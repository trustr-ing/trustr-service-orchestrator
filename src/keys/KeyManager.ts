import type { OrchestratorStore } from '../store/OrchestratorStore'
import type { Subscription, RequestKey } from '../store/types'

export class KeyManager {
  constructor(private readonly store: OrchestratorStore) {}

  async createSubscription(userPubkey: string, allowedServices?: string[]): Promise<Subscription> {
    return this.store.createSubscription({ userPubkey, allowedServices })
  }

  async createRequestKey(subscriptionId: string, requestEventId?: string): Promise<RequestKey> {
    return this.store.createRequestKey({ subscriptionId, requestEventId })
  }

  async revokeSubscription(subscriptionId: string): Promise<void> {
    await this.store.updateSubscriptionStatus(subscriptionId, 'revoked')
  }

  async suspendSubscription(subscriptionId: string): Promise<void> {
    await this.store.updateSubscriptionStatus(subscriptionId, 'suspended')
  }

  async reactivateSubscription(subscriptionId: string): Promise<void> {
    await this.store.updateSubscriptionStatus(subscriptionId, 'active')
  }

  async getSubscription(id: string): Promise<Subscription | null> {
    return this.store.getSubscription(id)
  }

  async getSubscriptionByPubkey(pubkey: string): Promise<Subscription | null> {
    return this.store.getSubscriptionByPubkey(pubkey)
  }

  async getRequestKeyByPubkey(pubkey: string): Promise<RequestKey | null> {
    return this.store.getRequestKeyByPubkey(pubkey)
  }

  async listActiveSubscriptionPubkeys(): Promise<string[]> {
    return this.store.listActiveSubscriptionPubkeys()
  }
}
