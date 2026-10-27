import type {
  Subscription,
  NewSubscription,
  RequestKey,
  NewRequestKey,
  SubscriptionStatus,
  RequestDurationStat,
  ProcessedRequest,
} from './types'

export interface OrchestratorStore {
  // ── Subscriptions ────────────────────────────────────────────────────────

  createSubscription(sub: NewSubscription): Promise<Subscription>
  getSubscription(id: string): Promise<Subscription | null>
  getSubscriptionByPubkey(pubkey: string): Promise<Subscription | null>
  getSubscriptionsByUser(userPubkey: string): Promise<Subscription[]>
  updateSubscriptionStatus(id: string, status: SubscriptionStatus): Promise<void>
  updateSubscriptionAllowedServices(id: string, allowedServices: string[] | null): Promise<void>
  listActiveSubscriptionPubkeys(): Promise<string[]>

  // ── Request keys ─────────────────────────────────────────────────────────

  createRequestKey(reqKey: NewRequestKey): Promise<RequestKey>
  getRequestKeyByPubkey(pubkey: string): Promise<RequestKey | null>
  listUnusedRequestKeyPubkeys(): Promise<string[]>
  markRequestKeyAsUsed(id: string, eventId: string): Promise<void>

  // ── Authorization ────────────────────────────────────────────────────────

  isAuthorized(userPubkey: string, serviceId: string): Promise<boolean>

  // ── Processed requests (restart-safe dedup) ──────────────────────────────
  getProcessedRequest(key: string): Promise<ProcessedRequest | null>
  markRequestProcessed(key: string, eventId: string, createdAt: number): Promise<void>

  // ── Request duration stats ───────────────────────────────────────────────

  getRequestDurationStat(serviceId: string, profileKey: string): Promise<RequestDurationStat | null>
  recordRequestDurationStat(
    serviceId: string,
    profileKey: string,
    durationMs: number,
    alpha: number,
  ): Promise<RequestDurationStat>

  // ── Lifecycle ────────────────────────────────────────────────────────────

  initialize(): Promise<void>
  close(): Promise<void>
}
