import { hexToBytes } from 'nostr-tools/utils'
import type { KeyManager } from './KeyManager'
import type { ServiceRecord, SigningContext } from '../store/types'

export class KeyResolver {
  constructor(
    private readonly services: ServiceRecord[],
    private readonly keyManager: KeyManager,
  ) {}

  /**
   * Resolve the `p`-tagged pubkey on a kind-37572 request into a signing
   * context. The optional `intendedServiceId` (extracted by the pipeline
   * from the request's `a` tag — `37570:<svc_pubkey>:<service_id>`) is
   * REQUIRED to disambiguate when one subscription/request pubkey is
   * authorized for more than one service. Without it, the resolver cannot
   * tell which `ServiceRecord` to sign with.
   */
  async resolve(
    pTagPubkey: string,
    requestAuthorPubkey: string,
    intendedServiceId?: string,
  ): Promise<SigningContext | null> {
    // 1. Check if p-tag matches a service pubkey (public_service mode).
    // The p-tag itself uniquely identifies the service here, so the
    // intendedServiceId is ignored (and would be redundant).
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

      const serviceRecord = this.findServiceForSubscription(
        subscription.allowedServices,
        intendedServiceId,
      )
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

      const serviceRecord = this.findServiceForSubscription(
        parentSubscription.allowedServices,
        intendedServiceId,
      )
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

  /**
   * Pick the `ServiceRecord` that should handle a request whose addressed
   * pubkey (subscription or request key) is authorized for `allowedServices`.
   *
   * Disambiguation rules:
   *  - If the request carried an `a` tag, the pipeline passes its serviceId
   *    as `intendedServiceId`. We use it iff the user is actually authorized
   *    for that service (or has a wildcard subscription).
   *  - Without an `intendedServiceId`, we only accept the resolution when
   *    there is exactly ONE candidate; ambiguity is rejected (null) so the
   *    pipeline returns the standard "unknown or unauthorized p-tag" error
   *    rather than silently dispatching to an unintended service.
   */
  private findServiceForSubscription(
    allowedServices: string[] | null,
    intendedServiceId?: string,
  ): ServiceRecord | undefined {
    if (intendedServiceId) {
      const wildcard = allowedServices === null
      const authorized = wildcard || allowedServices!.includes(intendedServiceId)
      if (!authorized) return undefined
      return this.services.find(s => s.serviceId === intendedServiceId)
    }

    const candidates =
      allowedServices === null
        ? this.services
        : this.services.filter(s => allowedServices.includes(s.serviceId))

    return candidates.length === 1 ? candidates[0] : undefined
  }
}
