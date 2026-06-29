import type { NostrEvent, UnsignedEvent } from '../../store/types'

/**
 * Placeholder in-process implementation of the TSM Assertions service.
 *
 * Once requests are routed to this client by the orchestrator's
 * RequestPipeline, `streamRequest` throws `not_implemented`. The pipeline's
 * existing catch path then publishes a kind 7000 `requestErrorFeedback`
 * event on the configured publish relays, surfacing the failure to the
 * requesting client without any custom feedback plumbing here.
 *
 * Replace `streamRequest` with the real assertion-generation logic when
 * the service is implemented. It MUST yield only `UnsignedEvent` objects;
 * signing and publishing is handled upstream by the orchestrator.
 */
export class AssertionsClient {
  async healthCheck(): Promise<boolean> {
    return true
  }

  /**
   * Announcement publishing is currently deferred for the assertions
   * service. Throws to ensure callers (AnnouncementManager) handle the
   * skip path rather than publishing a stub announcement.
   */
  async fetchAnnouncement(): Promise<UnsignedEvent> {
    throw new Error('assertions service announcement is deferred')
  }

  // eslint-disable-next-line require-yield
  async *streamRequest(
    _event: NostrEvent,
    _serviceId: string,
    _defaultReadRelays?: string[],
    _defaultWriteRelays?: string[],
  ): AsyncGenerator<UnsignedEvent> {
    throw new Error('not_implemented')
  }
}
