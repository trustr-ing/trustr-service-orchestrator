import type { NostrEvent, ServiceRecord, UnsignedEvent } from '../../store/types'
import { buildAssertionsAnnouncement, buildServiceProfile } from './profiles'
import {
  parseAssertionsRequest,
  AssertionsRequestError,
  NIP85_OUTPUT_KINDS,
} from './parseRequest'
import { fetchPovEvent } from './fetchPov'
import { validatePovEvent } from './validatePov'
import { buildSubjectAssertions } from './generate'

/**
 * In-process implementation of the TSM Assertions service.
 *
 * `streamRequest` parses the §2.1 request contract, resolves the referenced
 * kind-37573 POV, validates its output shape, and yields the resulting
 * TSM Subject Assertion (kind-37575) and/or NIP-85 (kind-30382) events.
 * Any contract violation throws an {@link AssertionsRequestError}, which the
 * pipeline surfaces as a structured kind-7000 error. It yields only
 * `UnsignedEvent` objects; signing and publishing is handled upstream by
 * the orchestrator.
 */
export class AssertionsClient {
  /**
   * @param servicePubkey The assertions service's own pubkey. A request
   * whose `p` tag equals it was routed in public mode (shared key); such
   * requests may not ask for NIP-85 kinds (see streamRequest step 1b).
   */
  constructor(private readonly servicePubkey?: string) {}

  async healthCheck(): Promise<boolean> {
    return true
  }

  /**
   * Kind-37570 announcement per tsm/assertion-services and
   * tsm/nip85-bridge. AnnouncementManager enriches it with the `d` tag,
   * the kind-7570 messaging `p` tag and the `r` relay tags.
   */
  async fetchAnnouncement(): Promise<UnsignedEvent> {
    return buildAssertionsAnnouncement()
  }

  /** Kind-0 profile for the service key (bridge provider SHOULD). */
  buildProfile(service: ServiceRecord): UnsignedEvent {
    return buildServiceProfile(service)
  }

  async *streamRequest(
    event: NostrEvent,
    serviceId: string,
    defaultReadRelays?: string[],
    _defaultWriteRelays?: string[],
  ): AsyncGenerator<UnsignedEvent> {
    // 1. Validate the §2.1 request contract.
    const parsed = parseAssertionsRequest(event)
    if (!parsed.ok) {
      throw new AssertionsRequestError(
        parsed.code,
        `assertions request rejected: ${parsed.code}` +
          (parsed.detail ? ` (${parsed.detail})` : ''),
        parsed.detail,
      )
    }
    const { outputKinds, povNaddr, configType, threshold, maxItems } = parsed.request

    // 1b. NIP-85 kinds are "my POV, computed by TrustR": they must be
    // signed by the requester's subscription pubkey. When the request is
    // addressed to the shared service pubkey, the orchestrator would sign
    // with the service key, so refuse before doing any work.
    const pTag = event.tags.find(t => t[0] === 'p')?.[1]
    const viaServiceKey = this.servicePubkey !== undefined && pTag === this.servicePubkey
    const nip85Requested = outputKinds.filter(k => NIP85_OUTPUT_KINDS.has(k))
    if (viaServiceKey && nip85Requested.length > 0) {
      throw new AssertionsRequestError(
        'nip85_requires_subscription',
        'assertions request rejected: nip85_requires_subscription ' +
          '(NIP-85 kinds must be requested via a subscription pubkey so they are ' +
          "signed from the requester's own point of view)",
        nip85Requested.join(','),
      )
    }

    // 2. Resolve the referenced kind-37573 POV and validate its shape.
    const pov = await fetchPovEvent(povNaddr, defaultReadRelays ?? [])
    const validated = validatePovEvent(pov)

    console.log(
      `[assertions] request ${event.id.slice(0, 8)}... for ${serviceId}: ` +
      `outputKinds=[${outputKinds.join(',')}] type=${configType} threshold=${threshold} ` +
      `maxItems=${maxItems} pov=${pov.id.slice(0, 8)}... subjects=${validated.subjects.length}`,
    )

    // 3. Generate and yield the assertion events. The request's `d` tag
    // seeds the kind-37575 identifier; fall back to the event id when a
    // request omits it.
    const requestDTag = event.tags.find(t => t[0] === 'd')?.[1] ?? event.id
    const assertions = buildSubjectAssertions(validated.subjects, {
      outputKinds,
      configType,
      threshold,
      maxItems,
      povNaddr,
      requestId: event.id,
      requestAuthorPubkey: event.pubkey,
      requestDTag,
    })

    console.log(
      `[assertions] request ${event.id.slice(0, 8)}...: emitting ${assertions.length} assertion event(s)`,
    )

    for (const assertion of assertions) {
      yield assertion
    }
  }
}
