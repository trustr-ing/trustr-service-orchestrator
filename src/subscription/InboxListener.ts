import { hexToBytes } from 'nostr-tools/utils'
import type { RelayPool } from '../relay/RelayPool'
import type { NostrEvent, ServiceRecord } from '../store/types'
import {
  unwrapSubscriptionEvent,
  type SubscriptionRumor,
} from './giftWrap'

const GIFT_WRAP_KIND = 1059
const SUBSCRIPTION_RUMOR_KIND_STR = '7570'

export interface InquiryContext {
  service: ServiceRecord
  // The user pubkey, established via the three-way provenance check in
  // unwrapSubscriptionEvent (rumor.pubkey === seal.pubkey).
  userPubkey: string
  rumor: SubscriptionRumor
  // Relay the gift wrap was received on. Used as a fallback delivery hint
  // when the user has no NIP-17 (kind 10050) inbox relay list published.
  receivedFromRelay: string
}

export type SubscriptionInquiryHandler = (ctx: InquiryContext) => Promise<void>

/**
 * Listens on each service's listen relays for gift-wrapped subscription
 * inquiries (kind-1059 with `#k:7570` addressed to the service's messaging
 * pubkey), unwraps them, validates them, and routes them to the configured
 * handler. Decryption / validation failures are logged and dropped — never
 * propagated to the relay pool callback.
 */
export class InboxListener {
  constructor(
    private readonly pool: RelayPool,
    private readonly handler: SubscriptionInquiryHandler,
  ) {}

  start(services: ServiceRecord[]): void {
    for (const service of services) {
      this.subscribeForService(service)
    }
  }

  private subscribeForService(service: ServiceRecord): void {
    // Distinct from the kind-37572 request subscription so the two REQ
    // streams can be managed (and refreshed) independently.
    const subscriptionId = `tsm:inbox:${service.serviceId}`
    const filter: Record<string, unknown> = {
      kinds: [GIFT_WRAP_KIND],
      // Tag filters per tsm/subscription-events §Event Flow: the outer wrap
      // carries [p,messaging_pubkey] and [k,7570]; relays MAY index either.
      '#p': [service.pubkey],
      '#k': [SUBSCRIPTION_RUMOR_KIND_STR],
    }

    this.pool.subscribe(
      service.listenRelays,
      subscriptionId,
      filter,
      (event, relayUrl) => {
        void this.handleGiftWrap(service, event, relayUrl)
      },
    )

    console.log(
      `[inbox] subscribed on ${service.listenRelays.length} relay(s) for ${service.name} (k:1059 #k:7570)`,
    )
  }

  private async handleGiftWrap(
    service: ServiceRecord,
    event: NostrEvent,
    relayUrl: string,
  ): Promise<void> {
    let unwrapped
    try {
      unwrapped = unwrapSubscriptionEvent(event, hexToBytes(service.privkey))
    } catch (err) {
      // Common cases: wrap not addressed to us, malformed cipher, replayed
      // event we can't decrypt. Log at debug level and drop.
      console.log(
        `[inbox] dropped gift wrap ${event.id.slice(0, 8)}... on ${service.serviceId} ` +
        `(${(err as Error).message})`,
      )
      return
    }

    const { rumor, sealPubkey } = unwrapped

    try {
      await this.handler({
        service,
        userPubkey: sealPubkey,
        rumor,
        receivedFromRelay: relayUrl,
      })
    } catch (err) {
      console.error(
        `[inbox] handler error for inquiry from ${sealPubkey.slice(0, 8)}... on ${service.serviceId}: ` +
        `${(err as Error).message}`,
      )
    }
  }
}
