import { hexToBytes } from 'nostr-tools/utils'
import type { KeyManager } from './KeyManager'
import type { ServiceRecord, SigningContext } from '../store/types'

export class KeyResolver {
  constructor(
    private readonly services: ServiceRecord[],
    private readonly keyManager: KeyManager,
  ) {}

  async resolve(pTagPubkey: string, requestAuthorPubkey: string): Promise<SigningContext | null> {
    // 1. Check if p-tag matches a service pubkey (public_service mode)
    const serviceMatch = this.services.find(s => s.pubkey === pTagPubkey)
    if (serviceMatch) {
      return {
        privkey: hexToBytes(serviceMatch.privkey),
        pubkey: serviceMatch.pubkey,
        serviceRecord: serviceMatch,
        mode: 'public_service',
      }
    }

    // 2. Check if p-tag matches a subscription pubkey (subscription_service mode)
    const subscription = await this.keyManager.getSubscriptionByPubkey(pTagPubkey)
    if (subscription) {
      if (subscription.status !== 'active') return null
      if (subscription.userPubkey !== requestAuthorPubkey) return null

      const serviceRecord = this.findServiceForSubscription(subscription.allowedServices)
      if (!serviceRecord) return null

      return {
        privkey: hexToBytes(subscription.subscriptionPrivkey),
        pubkey: subscription.subscriptionPubkey,
        serviceRecord,
        mode: 'subscription_service',
      }
    }

    // 3. Check if p-tag matches a request pubkey (restricted_service mode)
    const requestKey = await this.keyManager.getRequestKeyByPubkey(pTagPubkey)
    if (requestKey) {
      const parentSubscription = await this.keyManager.getSubscription(requestKey.subscriptionId)
      if (!parentSubscription) return null
      if (parentSubscription.status !== 'active') return null
      if (parentSubscription.userPubkey !== requestAuthorPubkey) return null

      const serviceRecord = this.findServiceForSubscription(parentSubscription.allowedServices)
      if (!serviceRecord) return null

      return {
        privkey: hexToBytes(requestKey.requestPrivkey),
        pubkey: requestKey.requestPubkey,
        serviceRecord,
        mode: 'restricted_service',
      }
    }

    return null
  }

  findServiceByServiceId(serviceId: string): ServiceRecord | undefined {
    return this.services.find(s => s.serviceId === serviceId)
  }

  findServiceByPubkey(pubkey: string): ServiceRecord | undefined {
    return this.services.find(s => s.pubkey === pubkey)
  }

  private findServiceForSubscription(allowedServices: string[] | null): ServiceRecord | undefined {
    if (allowedServices === null) {
      return this.services[0]
    }
    return this.services.find(s => allowedServices.includes(s.serviceId))
  }
}
