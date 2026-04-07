import type { NostrEvent, ServiceRecord, SigningContext } from '../store/types'
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

    // 6. In service mode, additionally check subscriber authorization
    if (signingContext.mode === 'service') {
      const authorized = await this.store.isAuthorized(event.pubkey, signingContext.serviceRecord.serviceId)
      if (!authorized) {
        console.log(
          `[pipeline] rejected request ${event.id.slice(0, 8)}... — author ${event.pubkey.slice(0, 8)}... not authorized for ${signingContext.serviceRecord.serviceId}`,
        )
        return
      }
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

    // Publish orchestrator "request received" feedback
    const receivedFeedback = requestReceivedFeedback(event, service.serviceId, ctx.pubkey)
    await this.publisher.signAndPublish(receivedFeedback, ctx.privkey, publishRelays)

    let outputEventCount = 0

    try {
      // Stream unsigned events from the service module
      for await (const unsignedEvent of client.streamRequest(event, service.serviceId)) {
        await this.publisher.signAndPublish(unsignedEvent, ctx.privkey, publishRelays)

        if (unsignedEvent.kind !== 7000) {
          outputEventCount++
        }
      }

      // Publish orchestrator "request completed" feedback
      const completedFeedback = requestCompletedFeedback(event, service.serviceId, ctx.pubkey, outputEventCount)
      await this.publisher.signAndPublish(completedFeedback, ctx.privkey, publishRelays)

      console.log(
        `[pipeline] completed request ${event.id.slice(0, 8)}... — ${outputEventCount} output event(s)`,
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[pipeline] error processing request ${event.id.slice(0, 8)}...: ${message}`)

      const errorFeedback = requestErrorFeedback(event, service.serviceId, ctx.pubkey, message)
      try {
        await this.publisher.signAndPublish(errorFeedback, ctx.privkey, publishRelays)
      } catch (publishErr) {
        console.error('[pipeline] failed to publish error feedback:', publishErr)
      }
    }
  }
}
