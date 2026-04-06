import type { NostrEvent, UnsignedEvent } from '../store/types'

type FeedbackStatus = 'processing' | 'error' | 'success' | 'info'

interface FeedbackOptions {
  requestEvent: NostrEvent
  serviceId: string
  signingPubkey: string
  status: FeedbackStatus
  message: string
  extra?: string[][]
}

export function buildFeedbackEvent(opts: FeedbackOptions): UnsignedEvent {
  const tags: string[][] = [
    ['status', opts.status === 'error' ? 'error' : opts.status, opts.message],
    ['e', opts.requestEvent.id],
    ['p', opts.requestEvent.pubkey],
  ]

  if (opts.extra) {
    tags.push(...opts.extra)
  }

  return {
    kind: 7000,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: '',
  }
}

export function requestReceivedFeedback(requestEvent: NostrEvent, serviceId: string, signingPubkey: string): UnsignedEvent {
  return buildFeedbackEvent({
    requestEvent,
    serviceId,
    signingPubkey,
    status: 'processing',
    message: `Request received by orchestrator, forwarding to ${serviceId}`,
  })
}

export function requestCompletedFeedback(requestEvent: NostrEvent, serviceId: string, signingPubkey: string, eventCount: number): UnsignedEvent {
  return buildFeedbackEvent({
    requestEvent,
    serviceId,
    signingPubkey,
    status: 'success',
    message: `Request completed — ${eventCount} output event(s) published`,
  })
}

export function requestErrorFeedback(requestEvent: NostrEvent, serviceId: string, signingPubkey: string, error: string): UnsignedEvent {
  return buildFeedbackEvent({
    requestEvent,
    serviceId,
    signingPubkey,
    status: 'error',
    message: error,
  })
}
