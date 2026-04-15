import type { NostrEvent, UnsignedEvent, ForwardPayload } from '../store/types'
import { readSSEStream } from './SSEStreamReader'

const REQUEST_TIMEOUT_MS = 300_000
const ANNOUNCE_TIMEOUT_MS = 15_000
const RESUME_POLL_INTERVAL_MS = 2_000
const RESUME_CHECK_TIMEOUT_MS = 10_000

interface BufferedEventsResponse {
  requestId: string
  events: UnsignedEvent[]
  cursor: number
  completed: boolean
  totalEvents: number
  hasMore: boolean
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export class ServiceClient {
  private supportsResume: boolean | null = null

  constructor(private readonly endpoint: string) {}

  async fetchAnnouncement(): Promise<UnsignedEvent> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), ANNOUNCE_TIMEOUT_MS)

    try {
      const response = await fetch(`${this.endpoint}/tsm/announce`, {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
        signal: controller.signal,
      })

      if (!response.ok) {
        throw new Error(`GET /tsm/announce returned HTTP ${response.status}`)
      }

      const body = await response.json() as UnsignedEvent
      if (typeof body.kind !== 'number' || !Array.isArray(body.tags)) {
        throw new Error('Invalid announcement response: missing kind or tags')
      }

      return body
    } finally {
      clearTimeout(timeout)
    }
  }

  private async checkResumeCapability(requestId: string): Promise<boolean> {
    if (this.supportsResume !== null) {
      return this.supportsResume
    }

    try {
      const response = await fetch(
        `${this.endpoint}/tsm/request/${requestId}/events?cursor=0`,
        {
          method: 'GET',
          signal: AbortSignal.timeout(RESUME_CHECK_TIMEOUT_MS),
        }
      )

      // Assume resume is supported if endpoint exists (404 or OK)
      // Only fail if we get a 404 for a completed request
      this.supportsResume = response.status === 404 || response.ok
      return this.supportsResume
    } catch (err) {
      // If timeout or network error, assume resume is supported
      // Better to try resume and fail than to give up immediately
      console.log(`[client] resume check timed out for ${requestId.slice(0, 8)}..., assuming resume is supported`)
      this.supportsResume = true
      return true
    }
  }

  private async *pollBufferedEvents(
    requestId: string,
    startCursor: number
  ): AsyncGenerator<UnsignedEvent> {
    let cursor = startCursor
    let completed = false

    while (!completed) {
      try {
        const response = await fetch(
          `${this.endpoint}/tsm/request/${requestId}/events?cursor=${cursor}`
        )

        if (!response.ok) {
          if (response.status === 404) {
            console.log(`[client] request ${requestId.slice(0, 8)}... not found in buffer, ending poll`)
            break
          }
          throw new Error(`Resume endpoint returned HTTP ${response.status}`)
        }

        const data = (await response.json()) as BufferedEventsResponse

        for (const event of data.events) {
          yield event
        }

        cursor = data.cursor
        completed = data.completed

        if (!completed && data.events.length === 0) {
          await sleep(RESUME_POLL_INTERVAL_MS)
        }
      } catch (err) {
        console.error(`[client] polling error for ${requestId.slice(0, 8)}...:`, err)
        await sleep(RESUME_POLL_INTERVAL_MS)
      }
    }

    console.log(`[client] polling complete for ${requestId.slice(0, 8)}... at cursor ${cursor}`)
  }

  async *streamRequest(event: NostrEvent, serviceId: string): AsyncGenerator<UnsignedEvent> {
    const payload: ForwardPayload = { event, serviceId }
    let cursor = 0
    let sseAttempted = false
    let resumeAttempted = false

    try {
      const response = await fetch(`${this.endpoint}/tsm/request`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'text/event-stream',
        },
        body: JSON.stringify(payload),
      })

      if (!response.ok) {
        throw new Error(`POST /tsm/request returned HTTP ${response.status}`)
      }

      sseAttempted = true

      for await (const unsignedEvent of readSSEStream(response)) {
        yield unsignedEvent
        cursor++
      }

      console.log(`[client] SSE stream completed normally for ${event.id.slice(0, 8)}...`)
    } catch (sseError) {
      const errorMsg = sseError instanceof Error ? sseError.message : String(sseError)
      console.log(
        `[client] SSE ${sseAttempted ? 'interrupted' : 'failed'} for ${event.id.slice(0, 8)}... after ${cursor} events: ${errorMsg}`
      )

      const canResume = await this.checkResumeCapability(event.id)

      if (canResume && cursor > 0) {
        resumeAttempted = true
        console.log(
          `[client] service supports resume, polling buffered events from cursor ${cursor}`
        )
        try {
          yield* this.pollBufferedEvents(event.id, cursor)
          console.log(`[client] resume completed successfully for ${event.id.slice(0, 8)}...`)
        } catch (resumeError) {
          const resumeErrorMsg = resumeError instanceof Error ? resumeError.message : String(resumeError)
          console.error(`[client] resume failed for ${event.id.slice(0, 8)}...: ${resumeErrorMsg}`)
          // Don't throw if we attempted resume - this prevents false negative errors
          // The request may still be completing on the service side
        }
      } else if (!canResume) {
        console.log(
          `[client] service does not support resume API, events after cursor ${cursor} are lost`
        )
        throw sseError
      } else {
        // cursor is 0, no events were received before SSE failed
        throw sseError
      }
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch(`${this.endpoint}/health`, {
        method: 'GET',
        signal: AbortSignal.timeout(5_000),
      })
      return response.ok
    } catch {
      return false
    }
  }
}
