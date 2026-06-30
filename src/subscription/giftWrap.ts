import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure'
import { createRumor, createSeal } from 'nostr-tools/nip59'
import {
  decrypt as nip44Decrypt,
  encrypt as nip44Encrypt,
  getConversationKey,
} from 'nostr-tools/nip44'
import type { NostrEvent, UnsignedEvent } from '../store/types'

// A NIP-59 rumor is an unsigned event with a derived id and an author pubkey,
// but no signature. The codebase's `UnsignedEvent` deliberately omits both, so
// we narrow to this shape locally rather than widening the shared type.
export type SubscriptionRumor = UnsignedEvent & { id: string; pubkey: string }

// Inner rumor kind for subscription protocol per tsm/subscription-events.
const SUBSCRIPTION_RUMOR_KIND = 7570
// Standard kinds defined by NIP-59.
const SEAL_KIND = 13
const GIFT_WRAP_KIND = 1059

// Two-day window the outer wrap's created_at is jittered into, per NIP-17/59.
const WRAP_TIMESTAMP_JITTER_WINDOW_SECONDS = 2 * 24 * 60 * 60

/**
 * Build a kind-7570 subscription rumor (Subscription Status or Subscription
 * Inquiry), seal it with the sender's private key, and gift-wrap it for the
 * recipient with a randomized created_at and the TSM-required `k:7570` outer
 * tag so inbox listeners can filter without unwrapping.
 *
 * @param rumorTemplate  Partial rumor — caller supplies kind, tags, content.
 *                       `pubkey` is set automatically from senderPrivkey.
 * @param senderPrivkey  Signs the kind-13 seal. For a Subscription Status this
 *                       MUST be the service announcement pubkey's privkey;
 *                       for a Subscription Inquiry it is the user's privkey.
 * @param recipientPubkey  Hex pubkey of the outer wrap's `p` tag.
 */
export function wrapSubscriptionRumor(
  rumorTemplate: Partial<UnsignedEvent>,
  senderPrivkey: Uint8Array,
  recipientPubkey: string,
): NostrEvent {
  const rumor = createRumor(
    {
      kind: SUBSCRIPTION_RUMOR_KIND,
      content: rumorTemplate.content ?? '',
      tags: rumorTemplate.tags ?? [],
      created_at: rumorTemplate.created_at ?? Math.floor(Date.now() / 1000),
    },
    senderPrivkey,
  )

  const seal = createSeal(rumor, senderPrivkey, recipientPubkey)

  // Outer wrap is signed by an ephemeral key so the on-relay author of the
  // wrap reveals nothing about either party.
  const ephemeralPrivkey = generateSecretKey()
  const conversationKey = getConversationKey(ephemeralPrivkey, recipientPubkey)

  return finalizeEvent(
    {
      kind: GIFT_WRAP_KIND,
      content: nip44Encrypt(JSON.stringify(seal), conversationKey),
      // Per NIP-17/59, randomize wrap timestamp within a two-day window to
      // avoid leaking ordering information on relays.
      created_at: jitteredTimestamp(),
      tags: [
        ['p', recipientPubkey],
        // tsm/subscription-events §Event Flow: outer wrap MUST include
        // ["k","7570"] so clients can filter their NIP-17 inbox by rumor kind.
        ['k', String(SUBSCRIPTION_RUMOR_KIND)],
      ],
    },
    ephemeralPrivkey,
  )
}

export interface UnwrappedSubscriptionRumor {
  rumor: SubscriptionRumor
  // Pubkey that signed the kind-13 seal. For a Subscription Status this is
  // the service announcement pubkey; for an Inquiry this is the user pubkey.
  sealPubkey: string
}

/**
 * Unwrap a kind-1059 gift wrap whose intended recipient is the holder of
 * `recipientPrivkey`, returning the inner kind-7570 rumor.
 *
 * Enforces the three-way provenance equality required by
 * tsm/subscription-events §Security: `rumor.pubkey === seal.pubkey`.
 * The wrap pubkey is intentionally ephemeral and is NOT compared.
 *
 * Throws if any decryption, parse, kind, or equality check fails.
 */
export function unwrapSubscriptionEvent(
  wrap: NostrEvent,
  recipientPrivkey: Uint8Array,
): UnwrappedSubscriptionRumor {
  if (wrap.kind !== GIFT_WRAP_KIND) {
    throw new Error(`expected kind ${GIFT_WRAP_KIND} gift wrap, got ${wrap.kind}`)
  }

  const wrapConversationKey = getConversationKey(recipientPrivkey, wrap.pubkey)
  const sealJson = nip44Decrypt(wrap.content, wrapConversationKey)
  const seal = parseJsonEvent(sealJson, 'seal')

  if (seal.kind !== SEAL_KIND) {
    throw new Error(`expected seal kind ${SEAL_KIND}, got ${seal.kind}`)
  }

  const sealConversationKey = getConversationKey(recipientPrivkey, seal.pubkey)
  const rumorJson = nip44Decrypt(seal.content, sealConversationKey)
  const parsedRumor = parseJsonEvent(rumorJson, 'rumor')

  if (parsedRumor.kind !== SUBSCRIPTION_RUMOR_KIND) {
    throw new Error(`expected rumor kind ${SUBSCRIPTION_RUMOR_KIND}, got ${parsedRumor.kind}`)
  }

  if (parsedRumor.pubkey !== seal.pubkey) {
    throw new Error(
      `provenance mismatch: rumor.pubkey ${parsedRumor.pubkey.slice(0, 8)}... !== seal.pubkey ${seal.pubkey.slice(0, 8)}...`,
    )
  }

  // parsedRumor is a NostrEvent shape; rumors omit `sig` but otherwise share
  // the same fields, so we expose it via the narrower SubscriptionRumor type.
  const { sig: _sig, ...rumorWithoutSig } = parsedRumor
  return {
    rumor: rumorWithoutSig as SubscriptionRumor,
    sealPubkey: seal.pubkey,
  }
}

// ── Internal helpers ────────────────────────────────────────────────────────

function jitteredTimestamp(): number {
  const nowSeconds = Math.floor(Date.now() / 1000)
  return nowSeconds - Math.floor(Math.random() * WRAP_TIMESTAMP_JITTER_WINDOW_SECONDS)
}

function parseJsonEvent(json: string, label: string): NostrEvent {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch (err) {
    throw new Error(`failed to parse ${label} JSON: ${(err as Error).message}`)
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as NostrEvent).kind !== 'number' ||
    typeof (parsed as NostrEvent).pubkey !== 'string' ||
    typeof (parsed as NostrEvent).content !== 'string' ||
    !Array.isArray((parsed as NostrEvent).tags)
  ) {
    throw new Error(`${label} is not a valid Nostr event shape`)
  }
  return parsed as NostrEvent
}
