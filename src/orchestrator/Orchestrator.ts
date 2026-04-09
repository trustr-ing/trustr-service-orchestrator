import type { OrchestratorConfig } from '../config'
import type { OrchestratorStore } from '../store/OrchestratorStore'
import { RelayPool } from '../relay/RelayPool'
import { EventPublisher } from '../relay/EventPublisher'
import { KeyManager } from '../keys/KeyManager'
import { KeyResolver } from '../keys/KeyResolver'
import { ServiceClient } from '../services/ServiceClient'
import { AnnouncementManager } from './AnnouncementManager'
import { RequestPipeline } from './RequestPipeline'

export class Orchestrator {
  private readonly pool: RelayPool
  private readonly publisher: EventPublisher
  private readonly keyManager: KeyManager
  private readonly keyResolver: KeyResolver
  private readonly serviceClients: Map<string, ServiceClient>
  private readonly announcementManager: AnnouncementManager
  private readonly requestPipeline: RequestPipeline

  constructor(
    private readonly config: OrchestratorConfig,
    private readonly store: OrchestratorStore,
  ) {
    this.pool = new RelayPool(config.reconnectBaseMs, config.reconnectMaxMs)
    this.publisher = new EventPublisher(this.pool)
    this.keyManager = new KeyManager(store)
    this.keyResolver = new KeyResolver(config.services, this.keyManager)

    this.serviceClients = new Map(
      config.services.map(s => [s.serviceId, new ServiceClient(s.endpoint)]),
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
      const allPubkeys = [service.pubkey]

      // In subscription_service/restricted_service mode, also listen for managed pubkeys
      if (service.pubkeyMode === 'subscription_service' || service.pubkeyMode === 'restricted_service') {
        const subPubkeys = await this.keyManager.listActiveSubscriptionPubkeys()
        const reqPubkeys = await this.store.listUnusedRequestKeyPubkeys()
        allPubkeys.push(...subPubkeys, ...reqPubkeys)
      }

      const subscriptionId = `tsm:${service.serviceId}`
      const filter: Record<string, unknown> = {
        kinds: [37572],
        '#p': allPubkeys,
      }

      this.pool.subscribe(
        service.listenRelays,
        subscriptionId,
        filter,
        (event, relayUrl) => {
          void this.requestPipeline.handleRequestEvent(event, relayUrl)
        },
      )

      console.log(
        `[orchestrator] subscribed on ${service.listenRelays.length} relay(s) for ${service.name} ` +
        `(${allPubkeys.length} pubkey(s) in filter)`,
      )
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
