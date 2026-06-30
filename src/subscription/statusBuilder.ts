import type { UnsignedEvent, ServiceRecord, Subscription } from '../store/types'

/**
 * Per-pubkey state encoded into a single `p` tag of a Subscription Status
 * rumor. Tag layout (positional) per tsm/subscription-events §Subscription
 * Status Event:
 *
 *   ["p", <pubkey>, <relay?>, <used>, <expiration?>, <quota?>]
 *
 * - `expiration: 0` marks the pubkey as expired/revoked (still listed for
 *   history/audit but unusable per §Client Behavior).
 * - `quota: 0` likewise marks the pubkey as quota-exhausted/revoked.
 * - `null` for expiration or quota means "absent" (no expiration / no quota).
 */
export interface AuthorizedPubkey {
  pubkey: string
  relayHint?: string
  usedCount: number
  expirationUnixSeconds: number | null
  quotaRemaining: number | null
}

export type SubscriptionStatusValue =
  | 'active'
  | 'payment-required'
  | 'expired'
  | 'cancelled'
  | 'revoked'

export interface BuildSubscriptionStatusRumorArgs {
  service: ServiceRecord
  authorizedPubkeys: AuthorizedPubkey[]
  status: SubscriptionStatusValue
  // Optional human-readable note rendered into the rumor's content field.
  note?: string
}

/**
 * Build a kind-7570 Subscription Status rumor (unsigned, no id, no pubkey —
 * those are populated by createRumor inside the gift-wrap step). One Status
 * rumor describes the user's full authorized pubkey set for ONE service,
 * keyed by (service_pubkey, a-tag) per the spec.
 */
export function buildSubscriptionStatusRumor(
  args: BuildSubscriptionStatusRumorArgs,
): Pick<UnsignedEvent, 'kind' | 'created_at' | 'content' | 'tags'> {
  const { service, authorizedPubkeys, status, note } = args

  const relayHint = service.listenRelays[0] ?? ''
  const aTag = relayHint
    ? ['a', `37570:${service.pubkey}:${service.serviceId}`, relayHint]
    : ['a', `37570:${service.pubkey}:${service.serviceId}`]

  const pTags = authorizedPubkeys.map(authorizedPubkeyToTag)

  return {
    kind: 7570,
    created_at: Math.floor(Date.now() / 1000),
    content: note ?? '',
    tags: [aTag, ...pTags, ['status', status]],
  }
}

/**
 * Lift a Subscription record into the AuthorizedPubkey shape with the
 * conventions used by Block-C MVP responses: no expiration, no quota,
 * usedCount = 0. The orchestrator does not yet track per-pubkey usage; once
 * it does, that value flows in here.
 */
export function activeAuthorizedPubkeyFromSubscription(
  subscription: Subscription,
  relayHint?: string,
): AuthorizedPubkey {
  return {
    pubkey: subscription.subscriptionPubkey,
    relayHint,
    usedCount: 0,
    expirationUnixSeconds: subscription.expiresAt ?? null,
    quotaRemaining: null,
  }
}

/**
 * Lift a Subscription record into the AuthorizedPubkey shape that marks it
 * as cancelled/revoked. Per spec §Client Behavior, the pubkey stays listed
 * with `expiration = 0` so clients can render history.
 */
export function revokedAuthorizedPubkeyFromSubscription(
  subscription: Subscription,
  relayHint?: string,
): AuthorizedPubkey {
  return {
    pubkey: subscription.subscriptionPubkey,
    relayHint,
    usedCount: 0,
    expirationUnixSeconds: 0,
    quotaRemaining: null,
  }
}

// ── Internal helpers ────────────────────────────────────────────────────────

function authorizedPubkeyToTag(authorizedPubkey: AuthorizedPubkey): string[] {
  // Positional encoding per spec §Subscription Status Event:
  //   ["p", <pubkey>, <relay?>, <used>, <expiration?>, <quota?>]
  //
  // Optional positions before another optional position MUST be filled with
  // an empty string so position is preserved.
  const tag: string[] = [
    'p',
    authorizedPubkey.pubkey,
    authorizedPubkey.relayHint ?? '',
    String(authorizedPubkey.usedCount),
  ]

  const hasExpiration = authorizedPubkey.expirationUnixSeconds !== null
  const hasQuota = authorizedPubkey.quotaRemaining !== null

  if (hasExpiration || hasQuota) {
    tag.push(hasExpiration ? String(authorizedPubkey.expirationUnixSeconds) : '')
  }
  if (hasQuota) {
    tag.push(String(authorizedPubkey.quotaRemaining))
  }

  return tag
}
