import type { OrchestratorConfig } from '../config'
import { ASSERTIONS_INTERNAL_ENDPOINT } from '../config'
import type { OrchestratorStore } from '../store/OrchestratorStore'
import type { ServiceRecord } from '../store/types'
import { RelayPool } from '../relay/RelayPool'
import { EventPublisher } from '../relay/EventPublisher'
import { KeyManager } from '../keys/KeyManager'
import { KeyResolver } from '../keys/KeyResolver'
import { ServiceClient } from '../services/ServiceClient'
import { AssertionsClient } from '../services/assertions'
import { AnnouncementManager } from './AnnouncementManager'
import { RequestPipeline } from './RequestPipeline'
import { InboxListener } from '../subscription/InboxListener'
import { InquiryHandler } from '../subscription/InquiryHandler'

export type ServiceClientLike = ServiceClient | AssertionsClient

// RelayPool subscription id convention for the kind-37572 request listener.
// Kept module-local so both `subscribe(...)` and `updateSubscription(...)`
// derive the same id from a service id.
function requestSubscriptionId(serviceId: string): string {
  return `tsm:${serviceId}`
}

export class Orchestrator {
  private readonly pool: RelayPool
  private readonly publisher: EventPublisher
  private readonly keyManager: KeyManager
  private readonly keyResolver: KeyResolver
  private readonly serviceClients: Map<string, ServiceClientLike>
  private readonly announcementManager: AnnouncementManager
  private readonly requestPipeline: RequestPipeline
  private readonly inboxListener: InboxListener
  private readonly inquiryHandler: InquiryHandler

  constructor(
    private readonly config: OrchestratorConfig,
    private readonly store: OrchestratorStore,
  ) {
    this.pool = new RelayPool(config.reconnectBaseMs, config.reconnectMaxMs)
    this.publisher = new EventPublisher(this.pool)
    this.keyManager = new KeyManager(store)
    this.keyResolver = new KeyResolver(config.services, this.keyManager)

    this.serviceClients = new Map(
      config.services.map(s => [
        s.serviceId,
        s.endpoint === ASSERTIONS_INTERNAL_ENDPOINT
          ? new AssertionsClient(s.pubkey)
          : new ServiceClient(s.endpoint),
      ]),
    )

    this.announcementManager = new AnnouncementManager(
      config.services,
      this.publisher,
      this.serviceClients,
    )

    this.requestPipeline = new RequestPipeline(
      config.services,
      this.keyResolver,
      this.publisher,
      this.serviceClients,
      store,
    )

    this.inquiryHandler = new InquiryHandler(
      this.keyManager,
      store,
      this.pool,
      // Strict ordering hook: after the data model is mutated, refresh each
      // service's kind-37572 REQ filter so a freshly-issued subscription
      // pubkey is listened for BEFORE the Status rumor reaches the user.
      () => this.refreshRequestSubscriptions(),
    )

    this.inboxListener = new InboxListener(this.pool, (ctx) => this.inquiryHandler.handle(ctx))
  }

  async start(): Promise<void> {
    console.log('[orchestrator] initializing store...')
    await this.store.initialize()

    // Health-check all service modules before starting
    console.log('[orchestrator] checking service module health...')
    for (const [serviceId, client] of this.serviceClients) {
      const healthy = await client.healthCheck()
      if (!healthy) {
        console.warn(`[orchestrator] ⚠ service ${serviceId} health check failed — continuing anyway`)
      } else {
        console.log(`[orchestrator] ✓ ${serviceId} is healthy`)
      }
    }

    // Fetch and publish announcements
    console.log('[orchestrator] publishing initial announcements...')
    await this.announcementManager.announceAll()
    this.announcementManager.startPeriodicAnnounce(this.config.announceIntervalMs)

    // Subscribe to request events on each service's listen relays
    console.log('[orchestrator] subscribing to request events...')
    await this.subscribeToRequests()

    // Subscribe to gift-wrapped subscription inquiries (kind-7570 rumors
    // inside kind-1059 wraps) per tsm/subscription-events.
    console.log('[orchestrator] subscribing to subscription inquiries...')
    this.inboxListener.start(this.config.services)

    console.log('[orchestrator] running')
  }

  async stop(): Promise<void> {
    console.log('[orchestrator] shutting down...')
    this.announcementManager.stop()
    this.pool.stop()
    await this.store.close()
    console.log('[orchestrator] stopped')
  }

  private async subscribeToRequests(): Promise<void> {
    for (const service of this.config.services) {
      const filter = await this.buildRequestFilter(service)
      const subscriptionId = requestSubscriptionId(service.serviceId)

      this.pool.subscribe(
        service.listenRelays,
        subscriptionId,
        filter,
        (event, relayUrl) => {
          void this.requestPipeline.handleRequestEvent(event, relayUrl)
        },
      )

      const pubkeyCount = Array.isArray(filter['#p']) ? (filter['#p'] as unknown[]).length : 0
      console.log(
        `[orchestrator] subscribed on ${service.listenRelays.length} relay(s) for ${service.name} ` +
        `(${pubkeyCount} pubkey(s) in filter)`,
      )
    }
  }

  /**
   * Rebuild the kind-37572 REQ filter for every service and push the
   * updated filter into the RelayPool. Called by InquiryHandler after a
   * subscription is created/extended/revoked, BEFORE the matching Status
   * rumor is emitted to the user (strict ordering — see InquiryHandler).
   */
  private async refreshRequestSubscriptions(): Promise<void> {
    for (const service of this.config.services) {
      // Only services that route via managed pubkeys can change their
      // filter at runtime; public_service mode's filter is static.
      if (
        service.pubkeyMode !== 'subscription_service' &&
        service.pubkeyMode !== 'restricted_service'
      ) {
        continue
      }

      const filter = await this.buildRequestFilter(service)
      this.pool.updateSubscription(
        service.listenRelays,
        requestSubscriptionId(service.serviceId),
        filter,
      )

      const pubkeyCount = Array.isArray(filter['#p']) ? (filter['#p'] as unknown[]).length : 0
      console.log(
        `[orchestrator] refreshed REQ filter for ${service.name} ` +
        `(${pubkeyCount} pubkey(s))`,
      )
    }
  }

  private async buildRequestFilter(
    service: ServiceRecord,
  ): Promise<Record<string, unknown>> {
    const allPubkeys = [service.pubkey]

    if (
      service.pubkeyMode === 'subscription_service' ||
      service.pubkeyMode === 'restricted_service'
    ) {
      const subPubkeys = await this.keyManager.listActiveSubscriptionPubkeys()
      const reqPubkeys = await this.store.listUnusedRequestKeyPubkeys()
      allPubkeys.push(...subPubkeys, ...reqPubkeys)
    }

    return {
      kinds: [37572],
      '#p': allPubkeys,
    }
  }

  async getActiveServices(): Promise<Array<{ serviceId: string; name: string; pubkey: string; endpoint: string; healthy: boolean }>> {
    const results = []
    for (const service of this.config.services) {
      const client = this.serviceClients.get(service.serviceId)
      let healthy = false
      
      if (client) {
        try {
          await client.healthCheck()
          healthy = true
        } catch (err) {
          healthy = false
        }
      }

      results.push({
        serviceId: service.serviceId,
        name: service.name,
        pubkey: service.pubkey,
        endpoint: service.endpoint,
        healthy
      })
    }
    return results
  }

  get getStore(): OrchestratorStore {
    return this.store
  }

  get getKeyManager(): KeyManager {
    return this.keyManager
  }
}
