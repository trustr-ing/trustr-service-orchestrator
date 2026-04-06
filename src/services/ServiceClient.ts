import type { NostrEvent, UnsignedEvent, ForwardPayload } from '../store/types'
import { readSSEStream } from './SSEStreamReader'

const REQUEST_TIMEOUT_MS = 300_000
const ANNOUNCE_TIMEOUT_MS = 15_000

export class ServiceClient {
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

  async *streamRequest(event: NostrEvent, serviceId: string): AsyncGenerator<UnsignedEvent> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

    const payload: ForwardPayload = { event, serviceId }

    try {
      const response = await fetch(`${this.endpoint}/tsm/request`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'text/event-stream',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      })

      if (!response.ok) {
        throw new Error(`POST /tsm/request returned HTTP ${response.status}`)
      }

      yield* readSSEStream(response)
    } finally {
      clearTimeout(timeout)
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
