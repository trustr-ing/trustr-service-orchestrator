import { hexToBytes } from 'nostr-tools/utils'
import type { ServiceRecord, UnsignedEvent } from '../store/types'
import type { EventPublisher } from '../relay/EventPublisher'
import type { ServiceClient } from '../services/ServiceClient'

export class AnnouncementManager {
  private readonly serviceClients: Map<string, ServiceClient>
  private intervalHandle: ReturnType<typeof setInterval> | null = null

  constructor(
    private readonly services: ServiceRecord[],
    private readonly publisher: EventPublisher,
    serviceClients: Map<string, ServiceClient>,
  ) {
    this.serviceClients = serviceClients
  }

  async announceAll(): Promise<void> {
    const results = await Promise.allSettled(
      this.services.map(service => this.announceService(service)),
    )

    let succeeded = 0
    let failed = 0
    for (const result of results) {
      if (result.status === 'fulfilled') succeeded++
      else {
        failed++
        console.error('[announce] failure:', result.reason)
      }
    }
    console.log(`[announce] published ${succeeded} announcement(s), ${failed} failure(s)`)
  }

  startPeriodicAnnounce(intervalMs: number): void {
    this.intervalHandle = setInterval(() => {
      void this.announceAll()
    }, intervalMs)
    console.log(`[announce] periodic re-announce every ${Math.round(intervalMs / 60_000)}min`)
  }

  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle)
      this.intervalHandle = null
    }
  }

  private async announceService(service: ServiceRecord): Promise<void> {
    const client = this.serviceClients.get(service.serviceId)
    if (!client) throw new Error(`No client for service ${service.serviceId}`)

    const unsignedAnnouncement = await client.fetchAnnouncement()
    const enrichedAnnouncement = this.enrichAnnouncement(unsignedAnnouncement, service)

    const signingKey = hexToBytes(service.privkey)
    const signedEvent = await this.publisher.signAndPublish(
      enrichedAnnouncement,
      signingKey,
      service.publishRelays,
    )

    console.log(
      `[announce] published kind ${signedEvent.kind} for ${service.name} (${signedEvent.id.slice(0, 8)}...)`,
    )
  }

  private enrichAnnouncement(announcement: UnsignedEvent, service: ServiceRecord): UnsignedEvent {
    const tags = [...announcement.tags]

    // Ensure the d tag matches the service ID
    const dTagIndex = tags.findIndex(t => t[0] === 'd')
    if (dTagIndex >= 0) {
      tags[dTagIndex] = ['d', service.serviceId]
    } else {
      tags.unshift(['d', service.serviceId])
    }

    // Set the p tag to the service pubkey (so users know where to address requests)
    const pTagIndex = tags.findIndex(t => t[0] === 'p')
    if (pTagIndex >= 0) {
      tags[pTagIndex] = ['p', service.pubkey]
    } else {
      tags.push(['p', service.pubkey])
    }

    // Add/update relay r tags with the service's listen relays
    const nonRelayTags = tags.filter(t => t[0] !== 'r')
    const relayTags = service.listenRelays.map(url => ['r', url])

    return {
      ...announcement,
      tags: [...nonRelayTags, ...relayTags],
    }
  }
}
