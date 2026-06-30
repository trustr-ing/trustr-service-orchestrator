import { hexToBytes } from 'nostr-tools/utils'
import type { KeyManager } from '../keys/KeyManager'
import type { OrchestratorStore } from '../store/OrchestratorStore'
import type { RelayPool } from '../relay/RelayPool'
import type { NostrEvent, ServiceRecord, Subscription } from '../store/types'
import type { InquiryContext } from './InboxListener'
import { wrapSubscriptionRumor } from './giftWrap'
import {
  buildSubscriptionStatusRumor,
  activeAuthorizedPubkeyFromSubscription,
  revokedAuthorizedPubkeyFromSubscription,
  type AuthorizedPubkey,
  type SubscriptionStatusValue,
} from './statusBuilder'

// Recognized `inquiry` tag values per tsm/subscription-events §Subscription
// Inquiry Event.
type InquiryIntent = 'inquire' | 'subscribe' | 'renew' | 'cancel' | 'pay'

export interface OnSubscriptionChange {
  // Fired after the data model has been mutated (subscription created or
  // allowed_services updated). Block D wires this to refresh the request
  // REQ filter so the newly-authorized pubkey is picked up immediately.
  (): Promise<void>
}

/**
 * Handles incoming kind-7570 Subscription Inquiry rumors and emits the
 * matching Subscription Status rumor back to the user via gift wrap.
 *
 * MVP scope (per session 1 plan):
 *  - free-tier: every `subscribe`/`renew`/`inquire` auto-approves and emits
 *    an active Status. No bolt11, no quota, no expiration.
 *  - `cancel`: removes the service from the user's allowed_services list
 *    and emits a cancelled Status. If the cancellation empties the list,
 *    the subscription is revoked outright.
 *  - `pay`: log-only; payment flows deferred to a later session.
 */
export class InquiryHandler {
  constructor(
    private readonly keyManager: KeyManager,
    private readonly store: OrchestratorStore,
    private readonly pool: RelayPool,
    private readonly onChange: OnSubscriptionChange,
  ) {}

  async handle(ctx: InquiryContext): Promise<void> {
    const intent = readInquiryIntent(ctx)
    if (!intent) {
      console.log(
        `[inquiry] ignoring rumor from ${ctx.userPubkey.slice(0, 8)}... ` +
        `for ${ctx.service.serviceId} (no recognized inquiry tag)`,
      )
      return
    }

    // Validate the `a` tag points at THIS service. Inquiries to the wrong
    // service ID on a shared messaging pubkey are dropped to avoid leaking
    // state across services.
    if (!referencesService(ctx, ctx.service)) {
      console.log(
        `[inquiry] dropping ${intent} from ${ctx.userPubkey.slice(0, 8)}... ` +
        `— a tag does not reference ${ctx.service.serviceId}`,
      )
      return
    }

    switch (intent) {
      case 'subscribe':
      case 'renew':
      case 'inquire':
        await this.handleSubscribe(ctx)
        return
      case 'cancel':
        await this.handleCancel(ctx)
        return
      case 'pay':
        // Payment flow deferred. Emit current Status so the user resyncs.
        await this.handleSubscribe(ctx)
        return
    }
  }

  // ── Intent handlers ────────────────────────────────────────────────────

  private async handleSubscribe(ctx: InquiryContext): Promise<void> {
    const existing = await this.findActiveSubscription(ctx.userPubkey)
    let subscription: Subscription

    if (!existing) {
      // One subscription pubkey per user; allowed_services starts with just
      // this service. Subsequent subscribe-inquiries for other services on
      // this same user extend the allowed_services array.
      subscription = await this.keyManager.createSubscription(
        ctx.userPubkey,
        [ctx.service.serviceId],
      )
      console.log(
        `[inquiry] created subscription ${subscription.id.slice(0, 8)}... for ` +
        `${ctx.userPubkey.slice(0, 8)}... (initial service: ${ctx.service.serviceId})`,
      )
    } else if (existing.allowedServices === null) {
      // null `allowed_services` already authorizes every service; nothing
      // to mutate on the data side.
      subscription = existing
    } else if (!existing.allowedServices.includes(ctx.service.serviceId)) {
      const nextServices = [...existing.allowedServices, ctx.service.serviceId]
      await this.store.updateSubscriptionAllowedServices(existing.id, nextServices)
      subscription = { ...existing, allowedServices: nextServices }
      console.log(
        `[inquiry] extended subscription ${subscription.id.slice(0, 8)}... ` +
        `with service ${ctx.service.serviceId}`,
      )
    } else {
      // Already subscribed to this service; reaffirm with a fresh Status.
      subscription = existing
    }

    // Strict ordering: refresh listener filters BEFORE emitting Status so
    // that by the time the user receives the pubkey they should target,
    // the orchestrator is already listening for requests on it.
    await this.onChange()

    await this.emitStatus(ctx, subscription, 'active')
  }

  private async handleCancel(ctx: InquiryContext): Promise<void> {
    const existing = await this.findActiveSubscription(ctx.userPubkey)
    if (!existing) {
      console.log(
        `[inquiry] cancel from ${ctx.userPubkey.slice(0, 8)}... but no active subscription`,
      )
      return
    }

    if (existing.allowedServices === null) {
      // The subscription authorized every service; cancelling a single
      // service from a wildcard set is ambiguous. Conservative behavior:
      // revoke the whole subscription so the user must re-subscribe to
      // re-enable other services explicitly.
      await this.keyManager.revokeSubscription(existing.id)
      console.log(
        `[inquiry] revoked subscription ${existing.id.slice(0, 8)}... ` +
        `(cancel against wildcard allowed_services)`,
      )
      await this.onChange()
      await this.emitStatus(ctx, existing, 'revoked')
      return
    }

    const nextServices = existing.allowedServices.filter(s => s !== ctx.service.serviceId)

    if (nextServices.length === 0) {
      // Last service removed → revoke the subscription entirely so the
      // pubkey stops being a valid request target across the orchestrator.
      await this.keyManager.revokeSubscription(existing.id)
      console.log(
        `[inquiry] revoked subscription ${existing.id.slice(0, 8)}... ` +
        `(no remaining allowed services)`,
      )
    } else {
      await this.store.updateSubscriptionAllowedServices(existing.id, nextServices)
      console.log(
        `[inquiry] removed ${ctx.service.serviceId} from subscription ` +
        `${existing.id.slice(0, 8)}... (remaining: ${nextServices.length})`,
      )
    }

    await this.onChange()
    await this.emitStatus(ctx, existing, 'cancelled')
  }

  // ── Subscription resolution ────────────────────────────────────────────

  private async findActiveSubscription(userPubkey: string): Promise<Subscription | null> {
    const subscriptions = await this.store.getSubscriptionsByUser(userPubkey)
    return subscriptions.find(s => s.status === 'active') ?? null
  }

  // ── Status delivery ────────────────────────────────────────────────────

  private async emitStatus(
    ctx: InquiryContext,
    subscription: Subscription,
    status: SubscriptionStatusValue,
  ): Promise<void> {
    const relayHint = ctx.service.listenRelays[0]
    const authorized: AuthorizedPubkey =
      status === 'cancelled' || status === 'revoked'
        ? revokedAuthorizedPubkeyFromSubscription(subscription, relayHint)
        : activeAuthorizedPubkeyFromSubscription(subscription, relayHint)

    const rumor = buildSubscriptionStatusRumor({
      service: ctx.service,
      authorizedPubkeys: [authorized],
      status,
    })

    const wrap = wrapSubscriptionRumor(
      rumor,
      hexToBytes(ctx.service.privkey),
      ctx.userPubkey,
    )

    await this.publishWrap(ctx, wrap)
  }

  private async publishWrap(ctx: InquiryContext, wrap: NostrEvent): Promise<void> {
    // Delivery targets per session-1 plan:
    //   - the relay we received the inquiry on (cheap and always reachable)
    //   - the service's configured publishRelays (broadcast)
    //
    // Future: also resolve the user's NIP-17 kind-10050 DM relay list and
    // publish there. Tracked as a Block-D / R2 follow-up.
    const targets = new Set<string>([ctx.receivedFromRelay, ...ctx.service.publishRelays])

    const result = await this.pool.publish([...targets], wrap)
    if (result.failedRelays.length > 0) {
      console.warn(
        `[inquiry] status publish: ${result.successfulRelays.length}/${targets.size} ` +
        `relays accepted (failures: ${result.failedRelays.map(f => `${f.relayUrl}:${f.reason}`).join(', ')})`,
      )
    }
  }
}

// ── Tag parsing helpers ──────────────────────────────────────────────────────

function readInquiryIntent(ctx: InquiryContext): InquiryIntent | null {
  const tag = ctx.rumor.tags.find(t => t[0] === 'inquiry')
  const value = tag?.[1]
  if (
    value === 'inquire' ||
    value === 'subscribe' ||
    value === 'renew' ||
    value === 'cancel' ||
    value === 'pay'
  ) {
    return value
  }
  return null
}

function referencesService(ctx: InquiryContext, service: ServiceRecord): boolean {
  // Inquiry rumors carry ["a","37570:<service_pubkey>:<service_id>", ...].
  // We accept the inquiry iff that coordinate matches the service the wrap
  // was addressed to.
  const expectedCoord = `37570:${service.pubkey}:${service.serviceId}`
  return ctx.rumor.tags.some(t => t[0] === 'a' && t[1] === expectedCoord)
}
