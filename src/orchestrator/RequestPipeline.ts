import type { NostrEvent, ServiceRecord, SigningContext, UnsignedEvent } from '../store/types'
import type { KeyResolver } from '../keys/KeyResolver'
import type { EventPublisher } from '../relay/EventPublisher'
import type { ServiceClient } from '../services/ServiceClient'
import type { OrchestratorStore } from '../store/OrchestratorStore'
import {
  requestReceivedFeedback,
  requestCompletedFeedback,
  requestErrorFeedback,
} from '../feedback/FeedbackBuilder'

const SEEN_EVENT_MAX_SIZE = 1_000
const DEFAULT_ESTIMATED_DURATION_MS = 120_000
const MIN_ESTIMATED_DURATION_MS = 5_000
const PROFILE_MIN_SAMPLE_COUNT = 3
const EWMA_ALPHA = 0.25
const IN_FLIGHT_PROGRESS_MAX = 95
const TERMINAL_PROGRESS = 100
const SERVICE_FALLBACK_PROFILE_KEY = '*'

interface ParsedInterpreterConfig {
  iterate?: number
  actorType?: string
}

interface ProgressContext {
  startedAtMs: number
  serviceId: string
  profileKey: string
  estimatedDurationMs: number
  lastProgress: number
}

interface SeenEventRecord {
  id: string
  dTag: string | null
  timestamp: number
}

class SeenEventCache {
  private readonly events = new Map<string, SeenEventRecord>()

  shouldProcess(event: NostrEvent): boolean {
    const dTag = event.tags.find(t => t[0] === 'd')?.[1] ?? null
    const key = dTag ?? event.id

    const existing = this.events.get(key)
    if (!existing) return true

    // If this is a replaceable event (has d tag) and is newer, allow reprocessing
    if (dTag && event.created_at > existing.timestamp) {
      console.log(
        `[pipeline] detected updated request ${event.id.slice(0, 8)}... (d:${dTag.slice(0, 8)}..., replacing ${existing.id.slice(0, 8)}...)`
      )
      return true
    }

    // Already seen and not newer
    return false
  }

  add(event: NostrEvent): void {
    const dTag = event.tags.find(t => t[0] === 'd')?.[1] ?? null
    const key = dTag ?? event.id

    if (this.events.size >= SEEN_EVENT_MAX_SIZE) {
      const oldest = this.events.keys().next().value as string
      this.events.delete(oldest)
    }

    this.events.set(key, {
      id: event.id,
      dTag,
      timestamp: event.created_at
    })
  }
}

export class RequestPipeline {
  private readonly seenEvents = new SeenEventCache()

  constructor(
    private readonly services: ServiceRecord[],
    private readonly keyResolver: KeyResolver,
    private readonly publisher: EventPublisher,
    private readonly serviceClients: Map<string, ServiceClient>,
    private readonly store: OrchestratorStore,
  ) {}

  private getConfigValue(event: NostrEvent, key: string): string | undefined {
    return event.tags.find(tag => tag[0] === 'config' && tag[1] === key)?.[2]
  }

  private parseInterpreterConfigs(rawInterpreters?: string): ParsedInterpreterConfig[] {
    if (!rawInterpreters) return []

    try {
      const parsed = JSON.parse(rawInterpreters)
      if (!Array.isArray(parsed)) return []

      const parsedInterpreters: ParsedInterpreterConfig[] = []
      for (const interpreter of parsed) {
        if (!interpreter || typeof interpreter !== 'object') continue

        const parsedInterpreter: ParsedInterpreterConfig = {}
        const iterateValue = (interpreter as { iterate?: unknown }).iterate
        if (typeof iterateValue === 'number' && Number.isFinite(iterateValue)) {
          parsedInterpreter.iterate = Math.max(1, Math.floor(iterateValue))
        }

        const paramsValue = (interpreter as { params?: unknown }).params
        if (paramsValue && typeof paramsValue === 'object') {
          const actorTypeValue = (paramsValue as { actorType?: unknown }).actorType
          if (typeof actorTypeValue === 'string' && actorTypeValue.trim()) {
            parsedInterpreter.actorType = actorTypeValue.trim()
          }
        }

        parsedInterpreters.push(parsedInterpreter)
      }

      return parsedInterpreters
    } catch {
      return []
    }
  }

  private parsePovSize(rawPov?: string): number | null {
    if (!rawPov) return null

    try {
      const parsed = JSON.parse(rawPov)
      if (Array.isArray(parsed)) return parsed.length
      if (typeof parsed === 'string' && parsed.trim()) return 1
      return null
    } catch {
      const trimmedPov = rawPov.trim()
      return trimmedPov ? 1 : null
    }
  }

  private bucketSmallCount(value: number): string {
    if (value <= 0) return '0'
    if (value === 1) return '1'
    if (value <= 2) return '2'
    if (value <= 3) return '3'
    if (value <= 5) return '4-5'
    return '6+'
  }

  private bucketPovSize(value: number | null): string {
    if (value === null || value <= 0) return 'unknown'
    if (value === 1) return '1'
    if (value <= 10) return '2-10'
    if (value <= 50) return '11-50'
    if (value <= 100) return '51-100'
    if (value <= 500) return '101-500'
    return '500+'
  }

  private buildRequestProfileKey(event: NostrEvent): string {
    const typeValue = this.getConfigValue(event, 'type') || 'unknown'
    const interpreters = this.parseInterpreterConfigs(this.getConfigValue(event, 'interpreters'))
    const interpreterCountBucket = this.bucketSmallCount(interpreters.length)

    const iterateSum = interpreters.reduce((sum, interpreter) => sum + (interpreter.iterate || 1), 0)
    const iterateBucket = this.bucketSmallCount(iterateSum)

    const hasEventActorInterpreter = interpreters.some((interpreter) => {
      const normalizedActorType = interpreter.actorType?.toLowerCase()
      return normalizedActorType === 'e' || normalizedActorType === 'a'
    })

    const povSize = this.parsePovSize(this.getConfigValue(event, 'pov'))
    const povBucket = this.bucketPovSize(povSize)

    return [
      `type=${typeValue}`,
      `interpreters=${interpreterCountBucket}`,
      `iterations=${iterateBucket}`,
      `eventActor=${hasEventActorInterpreter ? 1 : 0}`,
      `povCount=${povBucket}`,
    ].join('|')
  }

  private normalizeEstimatedDurationMs(durationMs: number): number {
    if (!Number.isFinite(durationMs) || durationMs <= 0) {
      return DEFAULT_ESTIMATED_DURATION_MS
    }

    return Math.max(MIN_ESTIMATED_DURATION_MS, Math.round(durationMs))
  }

  private async resolveEstimatedDurationMs(serviceId: string, profileKey: string): Promise<number> {
    const profileStat = await this.store.getRequestDurationStat(serviceId, profileKey)
    if (profileStat && profileStat.sampleCount >= PROFILE_MIN_SAMPLE_COUNT) {
      return this.normalizeEstimatedDurationMs(profileStat.ewmaDurationMs)
    }

    const serviceFallbackStat = await this.store.getRequestDurationStat(serviceId, SERVICE_FALLBACK_PROFILE_KEY)
    if (serviceFallbackStat) {
      return this.normalizeEstimatedDurationMs(serviceFallbackStat.ewmaDurationMs)
    }

    return DEFAULT_ESTIMATED_DURATION_MS
  }

  private computeProgressValue(progressContext: ProgressContext, isTerminal: boolean): number {
    if (isTerminal) {
      progressContext.lastProgress = TERMINAL_PROGRESS
      return TERMINAL_PROGRESS
    }

    const elapsedMs = Date.now() - progressContext.startedAtMs
    const rawProgress = Math.floor((elapsedMs / progressContext.estimatedDurationMs) * 100)
    const boundedProgress = Math.max(0, Math.min(IN_FLIGHT_PROGRESS_MAX, rawProgress))
    const nextProgress = Math.max(progressContext.lastProgress, boundedProgress)

    progressContext.lastProgress = nextProgress
    return nextProgress
  }

  private withProgressTag(unsignedEvent: UnsignedEvent, progressValue: number): UnsignedEvent {
    const nextTags = unsignedEvent.tags.map((tag) => [...tag])
    const progressTagIndex = nextTags.findIndex((tag) => tag[0] === 'progress')
    const normalizedProgress = String(progressValue)

    if (progressTagIndex >= 0) {
      nextTags[progressTagIndex] = ['progress', normalizedProgress]
    } else {
      nextTags.push(['progress', normalizedProgress])
    }

    return {
      ...unsignedEvent,
      tags: nextTags,
    }
  }

  private decorateFeedbackProgress(
    unsignedEvent: UnsignedEvent,
    progressContext: ProgressContext,
    isTerminal: boolean,
  ): UnsignedEvent {
    if (unsignedEvent.kind !== 7000) return unsignedEvent

    const progressValue = this.computeProgressValue(progressContext, isTerminal)
    return this.withProgressTag(unsignedEvent, progressValue)
  }

  private async publishWithProgress(
    unsignedEvent: UnsignedEvent,
    ctx: SigningContext,
    publishRelays: string[],
    progressContext: ProgressContext,
    isTerminalFeedback = false,
  ): Promise<void> {
    const decoratedEvent = this.decorateFeedbackProgress(unsignedEvent, progressContext, isTerminalFeedback)
    await this.publisher.signAndPublish(decoratedEvent, ctx.privkey, publishRelays)
  }

  private async recordDurationStats(serviceId: string, profileKey: string, durationMs: number): Promise<void> {
    try {
      await this.store.recordRequestDurationStat(serviceId, profileKey, durationMs, EWMA_ALPHA)
      await this.store.recordRequestDurationStat(serviceId, SERVICE_FALLBACK_PROFILE_KEY, durationMs, EWMA_ALPHA)
    } catch (error) {
      console.error(
        `[pipeline] failed to record duration stats for ${serviceId} (${profileKey}):`,
        error,
      )
    }
  }

  async handleRequestEvent(event: NostrEvent, relayUrl: string): Promise<void> {
    // 1. Deduplication / replaceable event handling
    if (!this.seenEvents.shouldProcess(event)) return
    this.seenEvents.add(event)

    // 2. Kind check
    if (event.kind !== 37572) return

    // 3. Skip encrypted requests
    if (event.content.trim() !== '') {
      console.log(`[pipeline] skipped encrypted request ${event.id.slice(0, 8)}...`)
      return
    }

    // 4. Extract p-tag
    const pTag = event.tags.find(t => t[0] === 'p')?.[1]
    if (!pTag) {
      console.log(`[pipeline] skipped request ${event.id.slice(0, 8)}... — no p tag`)
      return
    }

    // 5. Resolve signing context (validates p-tag → keypair)
    const signingContext = await this.keyResolver.resolve(pTag, event.pubkey)
    if (!signingContext) {
      console.log(
        `[pipeline] rejected request ${event.id.slice(0, 8)}... — unknown or unauthorized p-tag ${pTag.slice(0, 8)}...`,
      )
      return
    }

    // 6. Authorization checks based on mode
    // public_service → no authorization required (open access)

    if (signingContext.mode === 'subscription_service') {
      const authorized = await this.store.isAuthorized(event.pubkey, signingContext.serviceRecord.serviceId)
      if (!authorized) {
        console.log(
          `[pipeline] rejected request ${event.id.slice(0, 8)}... — author ${event.pubkey.slice(0, 8)}... not subscribed to ${signingContext.serviceRecord.serviceId}`,
        )
        return
      }
    }

    if (signingContext.mode === 'restricted_service') {
      const requestKey = await this.store.getRequestKeyByPubkey(signingContext.pubkey)
      if (!requestKey || requestKey.used) {
        console.log(
          `[pipeline] rejected request ${event.id.slice(0, 8)}... — restricted key ${signingContext.pubkey.slice(0, 8)}... already used or invalid`,
        )
        return
      }

      if (requestKey.expiresAt && requestKey.expiresAt < event.created_at) {
        console.log(
          `[pipeline] rejected request ${event.id.slice(0, 8)}... — restricted key ${signingContext.pubkey.slice(0, 8)}... expired`,
        )
        return
      }

      const subscription = await this.store.getSubscription(requestKey.subscriptionId)
      if (!subscription || subscription.status !== 'active') {
        console.log(
          `[pipeline] rejected request ${event.id.slice(0, 8)}... — parent subscription inactive`,
        )
        return
      }

      if (subscription.userPubkey !== event.pubkey) {
        console.log(
          `[pipeline] rejected request ${event.id.slice(0, 8)}... — author mismatch for restricted key`,
        )
        return
      }

      // Mark as used BEFORE processing (prevent race conditions)
      await this.store.markRequestKeyAsUsed(requestKey.id, event.id)
    }

    // 7. Verify output kind match
    const requestedKinds = event.tags
      .filter(t => t[0] === 'k' && t[1] !== undefined)
      .map(t => parseInt(t[1]!, 10))

    const hasMatchingKind = signingContext.serviceRecord.outputKinds.some(k => requestedKinds.includes(k))
    if (!hasMatchingKind) {
      console.log(
        `[pipeline] skipped request ${event.id.slice(0, 8)}... — output kind mismatch`,
      )
      return
    }

    // 8. Determine publish relays (request `r` tags + service publish relays)
    const requestRelays = event.tags.filter(t => t[0] === 'r').map(t => t[1]!).filter(Boolean)
    const publishRelays = [...new Set([...signingContext.serviceRecord.publishRelays, ...requestRelays])]

    console.log(
      `[pipeline] processing request ${event.id.slice(0, 8)}... for ${signingContext.serviceRecord.name} (mode: ${signingContext.mode})`,
    )

    await this.processRequest(event, signingContext, publishRelays)
  }

  private async processRequest(
    event: NostrEvent,
    ctx: SigningContext,
    publishRelays: string[],
  ): Promise<void> {
    const service = ctx.serviceRecord
    const client = this.serviceClients.get(service.serviceId)
    if (!client) {
      console.error(`[pipeline] no client for service ${service.serviceId}`)
      return
    }

    const profileKey = this.buildRequestProfileKey(event)
    const progressContext: ProgressContext = {
      startedAtMs: Date.now(),
      serviceId: service.serviceId,
      profileKey,
      estimatedDurationMs: await this.resolveEstimatedDurationMs(service.serviceId, profileKey),
      lastProgress: 0,
    }

    // Publish orchestrator "request received" feedback
    const receivedFeedback = requestReceivedFeedback(event, service.serviceId, ctx.pubkey)
    await this.publishWithProgress(receivedFeedback, ctx, publishRelays, progressContext)

    let outputEventCount = 0

    try {
      const defaultReadRelays = [
        ...new Set([...service.listenRelays, ...service.publishRelays]),
      ]
      const defaultWriteRelays = [...service.publishRelays]

      // Stream unsigned events from the service module
      for await (const unsignedEvent of client.streamRequest(
        event,
        service.serviceId,
        defaultReadRelays,
        defaultWriteRelays,
      )) {
        await this.publishWithProgress(unsignedEvent, ctx, publishRelays, progressContext)

        if (unsignedEvent.kind !== 7000) {
          outputEventCount++
        }
      }

      // Publish orchestrator "request completed" feedback
      const completedFeedback = requestCompletedFeedback(event, service.serviceId, ctx.pubkey, outputEventCount)
      await this.publishWithProgress(completedFeedback, ctx, publishRelays, progressContext, true)

      const durationMs = Date.now() - progressContext.startedAtMs
      await this.recordDurationStats(service.serviceId, profileKey, durationMs)

      console.log(
        `[pipeline] completed request ${event.id.slice(0, 8)}... — ${outputEventCount} output event(s)`,
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[pipeline] error processing request ${event.id.slice(0, 8)}...: ${message}`)

      const errorFeedback = requestErrorFeedback(event, service.serviceId, ctx.pubkey, message)
      try {
        await this.publishWithProgress(errorFeedback, ctx, publishRelays, progressContext, true)
      } catch (publishErr) {
        console.error('[pipeline] failed to publish error feedback:', publishErr)
      }
    }
  }
}
