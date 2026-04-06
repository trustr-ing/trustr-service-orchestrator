import { finalizeEvent } from 'nostr-tools/pure'
import type { EventTemplate } from 'nostr-tools/pure'
import type { RelayPool } from './RelayPool'
import type { UnsignedEvent, NostrEvent } from '../store/types'

export class EventPublisher {
  constructor(private readonly pool: RelayPool) {}

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

    await this.pool.publish(relayUrls, signedEvent)
    return signedEvent
  }

  async publishSigned(event: NostrEvent, relayUrls: string[]): Promise<void> {
    await this.pool.publish(relayUrls, event)
  }
}
