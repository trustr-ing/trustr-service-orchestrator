import type { UnsignedEvent } from '../store/types'

export async function* readSSEStream(response: Response): AsyncGenerator<UnsignedEvent> {
  const reader = response.body?.getReader()
  if (!reader) throw new Error('Response body is not readable')

  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })

      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith(':')) continue

        if (trimmed.startsWith('data: ')) {
          const jsonStr = trimmed.slice(6)
          try {
            const event = JSON.parse(jsonStr) as UnsignedEvent
            if (typeof event.kind === 'number' && Array.isArray(event.tags)) {
              yield event
            }
          } catch {
            console.warn('[sse] failed to parse SSE data line:', jsonStr.slice(0, 80))
          }
        }
      }
    }

    // Process any remaining data in the buffer
    if (buffer.trim().startsWith('data: ')) {
      try {
        const event = JSON.parse(buffer.trim().slice(6)) as UnsignedEvent
        if (typeof event.kind === 'number' && Array.isArray(event.tags)) {
          yield event
        }
      } catch {
        // ignore incomplete trailing data
      }
    }
  } finally {
    reader.releaseLock()
  }
}
