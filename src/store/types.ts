// ── Nostr event types ────────────────────────────────────────────────────────

export interface NostrEvent {
  id: string
  pubkey: string
  created_at: number
  kind: number
  tags: string[][]
  content: string
  sig: string
}

export interface UnsignedEvent {
  kind: number
  created_at: number
  tags: string[][]
  content: string
}

// ── Provider pubkey modes (TSM spec Appendix 2) ─────────────────────────────

export type PubkeyMode = 'public_service' | 'subscription_service' | 'restricted_service'

// ── Service configuration (loaded from ENV) ──────────────────────────────────

export interface ServiceRecord {
  id: string
  name: string
  endpoint: string
  serviceId: string
  pubkeyMode: PubkeyMode
  privkey: string
  pubkey: string
  outputKinds: number[]
  listenRelays: string[]
  publishRelays: string[]
}

// ── Subscription management ──────────────────────────────────────────────────

export type SubscriptionStatus = 'active' | 'suspended' | 'revoked'

export interface Subscription {
  id: string
  userPubkey: string
  subscriptionPubkey: string
  subscriptionPrivkey: string
  status: SubscriptionStatus
  allowedServices: string[] | null
  createdAt: number
  expiresAt: number | null
}

export interface NewSubscription {
  userPubkey: string
  allowedServices?: string[]
  status?: SubscriptionStatus
  expiresAt?: number
}

// ── Request key management (per-request ephemeral keypairs) ──────────────────

export interface RequestKey {
  id: string
  subscriptionId: string
  requestPubkey: string
  requestPrivkey: string
  requestEventId: string | null
  used: boolean
  usedAt: number | null
  createdAt: number
  expiresAt: number | null
}

export interface NewRequestKey {
  subscriptionId: string
  requestEventId?: string
  expiresAt?: number
}

// ── Payload sent to service modules ──────────────────────────────────────────

export interface ForwardPayload {
  event: NostrEvent
  serviceId: string
}

// ── Resolved signing context for a request ───────────────────────────────────

export interface SigningContext {
  privkey: Uint8Array
  pubkey: string
  serviceRecord: ServiceRecord
  mode: PubkeyMode
}
