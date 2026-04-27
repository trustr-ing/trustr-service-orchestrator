import { finalizeEvent } from 'nostr-tools/pure'
import type { EventTemplate } from 'nostr-tools/pure'
import type { PublishResult, RelayPool } from './RelayPool'
import type { UnsignedEvent, NostrEvent } from '../store/types'

export class EventPublisher {
  constructor(private readonly pool: RelayPool) {}

  private assertPublishAccepted(
    event: NostrEvent,
    relayUrls: string[],
    publishResult: PublishResult,
  ): void {
    const normalizedRelayUrls = [...new Set(relayUrls)]

    // Require at least one relay acknowledgement so publish failures are never
    // silently treated as successful processing.
    if (publishResult.successfulRelays.length === 0) {
      const failureDetails = publishResult.failedRelays
        .map(({ relayUrl, reason }) => `${relayUrl} (${reason})`)
        .join('; ')

      throw new Error(
        `[publisher] no relay accepted kind ${event.kind} (${event.id.slice(0, 8)}...). ` +
          `Failures: ${failureDetails || 'unknown relay failure'}`,
      )
    }

    if (publishResult.failedRelays.length === 0) return

    const failureDetails = publishResult.failedRelays
      .map(({ relayUrl, reason }) => `${relayUrl} (${reason})`)
      .join('; ')

    console.warn(
      `[publisher] partial publish for kind ${event.kind} (${event.id.slice(0, 8)}...) — ` +
        `${publishResult.successfulRelays.length}/${normalizedRelayUrls.length} relays accepted. ` +
        `Failures: ${failureDetails}`,
    )
  }

  async signAndPublish(
    unsignedEvent: UnsignedEvent,
    signingKey: Uint8Array,
    relayUrls: string[],
  ): Promise<NostrEvent> {
    const template: EventTemplate = {
      kind: unsignedEvent.kind,
      created_at: unsignedEvent.created_at,
      tags: unsignedEvent.tags,
      content: unsignedEvent.content,
    }

    const signedEvent = finalizeEvent(template, signingKey) as unknown as NostrEvent

    console.log(
      `[publisher] publishing kind ${signedEvent.kind} (${signedEvent.id.slice(0, 8)}...) to ${relayUrls.length} relay(s)`,
    )

    const publishResult = await this.pool.publish(relayUrls, signedEvent)
    this.assertPublishAccepted(signedEvent, relayUrls, publishResult)

    return signedEvent
  }

  async publishSigned(event: NostrEvent, relayUrls: string[]): Promise<void> {
    const publishResult = await this.pool.publish(relayUrls, event)
    this.assertPublishAccepted(event, relayUrls, publishResult)
  }
}
