import { hexToBytes } from 'nostr-tools/utils'
import type { ServiceRecord, UnsignedEvent } from '../store/types'
import type { EventPublisher } from '../relay/EventPublisher'
import { ASSERTIONS_INTERNAL_ENDPOINT } from '../config'
import { AssertionsClient } from '../services/assertions'
import type { ServiceClientLike } from './Orchestrator'

export class AnnouncementManager {
  private readonly serviceClients: Map<string, ServiceClientLike>
  private intervalHandle: ReturnType<typeof setInterval> | null = null

  constructor(
    private readonly services: ServiceRecord[],
    private readonly publisher: EventPublisher,
    serviceClients: Map<string, ServiceClientLike>,
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

    // Bridge providers (tsm/nip85-bridge) SHOULD publish a kind-0 profile
    // from the same key that signs announcements and assertions. Only the
    // internal assertions service builds one; HTTP services own theirs.
    if (service.endpoint === ASSERTIONS_INTERNAL_ENDPOINT && client instanceof AssertionsClient) {
      const profile = client.buildProfile(service)
      const signedProfile = await this.publisher.signAndPublish(
        profile,
        hexToBytes(service.privkey),
        service.publishRelays,
      )
      console.log(`[announce] published kind 0 profile for ${service.name} (${signedProfile.id.slice(0, 8)}...)`)
    }

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

    // Advertise kind-7570 messaging support per tsm/subscription-events
    // §Advertising Support: ["p", <messaging_pubkey>, <relay?>, "7570"].
    // We reuse the service pubkey as the messaging pubkey (the simplification
    // approved during planning), so the messaging tag is uniquely identified
    // by the trailing "7570" parameter — not by being the first `p` tag.
    // Any other `p` tags the client emitted (e.g. announcement-pubkey hints
    // for compatibility with non-TSM consumers) are preserved.
    const messagingRelayHint = service.listenRelays[0] ?? ''
    const messagingTag: string[] = messagingRelayHint
      ? ['p', service.pubkey, messagingRelayHint, '7570']
      : ['p', service.pubkey, '', '7570']

    const messagingTagIndex = tags.findIndex(
      t => t[0] === 'p' && t[3] === '7570',
    )
    if (messagingTagIndex >= 0) {
      tags[messagingTagIndex] = messagingTag
    } else {
      tags.push(messagingTag)
    }

    // Add/update relay r tags with the service's listen relays
    const nonRelayTags = tags.filter(t => t[0] !== 'r')
    const relayTags = service.listenRelays.map(url => ['r', url])

    return {
      ...announcement,
      created_at: announcement.created_at ?? Math.floor(Date.now() / 1000),
      tags: [...nonRelayTags, ...relayTags],
    }
  }
}
