import WebSocket from 'ws'
import type { NostrEvent } from '../store/types'

export type EventHandler = (event: NostrEvent, relayUrl: string) => void

export interface PublishFailure {
  relayUrl: string
  reason: string
}

export interface PublishResult {
  successfulRelays: string[]
  failedRelays: PublishFailure[]
}

interface PendingPublishAck {
  resolve: () => void
  reject: (error: Error) => void
  timeout: NodeJS.Timeout
}

interface Subscription {
  id: string
  filter: Record<string, unknown>
  handler: EventHandler
}

interface RelayConnection {
  url: string
  ws: WebSocket | null
  subscriptions: Map<string, Subscription>
  pendingPublishAcks: Map<string, PendingPublishAck>
  reconnectDelay: number
  reconnecting: boolean
  stopped: boolean
}

export class RelayPool {
  private readonly connections = new Map<string, RelayConnection>()
  private readonly reconnectBaseMs: number
  private readonly reconnectMaxMs: number

  constructor(reconnectBaseMs: number, reconnectMaxMs: number) {
    this.reconnectBaseMs = reconnectBaseMs
    this.reconnectMaxMs = reconnectMaxMs
  }

  subscribe(relayUrls: string[], subscriptionId: string, filter: Record<string, unknown>, handler: EventHandler): void {
    const sub: Subscription = { id: subscriptionId, filter, handler }

    for (const url of relayUrls) {
      const conn = this.ensureConnection(url)
      conn.subscriptions.set(subscriptionId, sub)
      this.sendReq(conn, sub)
    }
  }

  unsubscribe(relayUrls: string[], subscriptionId: string): void {
    for (const url of relayUrls) {
      const conn = this.connections.get(url)
      if (!conn) continue
      conn.subscriptions.delete(subscriptionId)
      this.send(conn, JSON.stringify(['CLOSE', subscriptionId]))
    }
  }

  async publish(relayUrls: string[], event: NostrEvent): Promise<PublishResult> {
    const dedupedRelayUrls = [...new Set(relayUrls)]
    const publishPromises = dedupedRelayUrls.map((relayUrl) => this.publishToRelay(relayUrl, event))
    const settledPublishes = await Promise.allSettled(publishPromises)

    const successfulRelays: string[] = []
    const failedRelays: PublishFailure[] = []

    settledPublishes.forEach((settledPublish, relayIndex) => {
      const relayUrl = dedupedRelayUrls[relayIndex]!
      if (settledPublish.status === 'fulfilled') {
        successfulRelays.push(relayUrl)
        return
      }

      const failureReason =
        settledPublish.reason instanceof Error
          ? settledPublish.reason.message
          : String(settledPublish.reason)

      failedRelays.push({
        relayUrl,
        reason: failureReason,
      })
    })

    return {
      successfulRelays,
      failedRelays,
    }
  }

  stop(): void {
    for (const conn of this.connections.values()) {
      conn.stopped = true
      this.rejectPendingPublishes(conn, new Error(`Relay pool stopped for ${conn.url}`))
      conn.ws?.close()
    }
    this.connections.clear()
  }

  getConnectedRelayCount(): number {
    let count = 0
    for (const conn of this.connections.values()) {
      if (conn.ws?.readyState === WebSocket.OPEN) count++
    }
    return count
  }

  // ── Internal ───────────────────────────────────────────────────────────

  private ensureConnection(url: string): RelayConnection {
    let conn = this.connections.get(url)
    if (conn) return conn

    conn = {
      url,
      ws: null,
      subscriptions: new Map(),
      pendingPublishAcks: new Map(),
      reconnectDelay: this.reconnectBaseMs,
      reconnecting: false,
      stopped: false,
    }
    this.connections.set(url, conn)
    this.connect(conn)
    return conn
  }

  private connect(conn: RelayConnection): void {
    if (conn.stopped) return
    conn.ws = new WebSocket(conn.url)

    conn.ws.on('open', () => {
      console.log(`[relay-pool] connected to ${conn.url}`)
      conn.reconnectDelay = this.reconnectBaseMs
      this.resubscribeAll(conn)
    })

    conn.ws.on('message', (data: WebSocket.RawData) => {
      this.handleMessage(conn, data.toString())
    })

    conn.ws.on('close', (code: number) => {
      if (conn.stopped) return
      this.rejectPendingPublishes(
        conn,
        new Error(`Relay ${conn.url} disconnected before publish acknowledgment (code ${code})`),
      )
      console.log(`[relay-pool] disconnected from ${conn.url} (code ${code}), reconnecting in ${conn.reconnectDelay}ms`)
      this.scheduleReconnect(conn)
    })

    conn.ws.on('error', (err: Error) => {
      this.rejectPendingPublishes(conn, new Error(`Relay ${conn.url} socket error: ${err.message}`))
      console.error(`[relay-pool] error on ${conn.url}: ${err.message}`)
    })
  }

  private resubscribeAll(conn: RelayConnection): void {
    for (const sub of conn.subscriptions.values()) {
      this.sendReq(conn, sub)
    }
  }

  private sendReq(conn: RelayConnection, sub: Subscription): void {
    this.send(conn, JSON.stringify(['REQ', sub.id, sub.filter]))
  }

  private send(conn: RelayConnection, msg: string): void {
    if (conn.ws?.readyState === WebSocket.OPEN) {
      conn.ws.send(msg)
    }
  }

  private handleMessage(conn: RelayConnection, data: string): void {
    let msg: unknown
    try {
      msg = JSON.parse(data)
    } catch {
      return
    }

    if (!Array.isArray(msg) || msg.length === 0) return

    const [type, ...messageParts] = msg as [unknown, ...unknown[]]
    if (type === 'EVENT') {
      if (messageParts.length < 2) return

      const [subId, payload] = messageParts as [unknown, unknown]
      if (typeof subId !== 'string') return

      const sub = conn.subscriptions.get(subId)
      if (sub && payload !== null && typeof payload === 'object') {
        sub.handler(payload as NostrEvent, conn.url)
      }

      return
    }

    if (type !== 'OK') return
    if (messageParts.length < 3) return

    const [eventId, accepted, relayMessage] = messageParts as [unknown, unknown, unknown]
    if (typeof eventId !== 'string' || typeof accepted !== 'boolean') return

    const pendingPublish = conn.pendingPublishAcks.get(eventId)
    if (!pendingPublish) return

    conn.pendingPublishAcks.delete(eventId)
    clearTimeout(pendingPublish.timeout)

    if (accepted) {
      pendingPublish.resolve()
      return
    }

    const relayReason =
      typeof relayMessage === 'string' && relayMessage.trim().length > 0
        ? relayMessage
        : 'relay rejected event'

    pendingPublish.reject(
      new Error(
        `Relay ${conn.url} rejected event ${eventId.slice(0, 8)}...: ${relayReason}`,
      ),
    )
  }

  private scheduleReconnect(conn: RelayConnection): void {
    if (conn.reconnecting || conn.stopped) return
    conn.reconnecting = true
    setTimeout(() => {
      conn.reconnecting = false
      conn.reconnectDelay = Math.min(conn.reconnectDelay * 2, this.reconnectMaxMs)
      this.connect(conn)
    }, conn.reconnectDelay)
  }

  private rejectPendingPublishes(conn: RelayConnection, error: Error): void {
    for (const [eventId, pendingPublish] of conn.pendingPublishAcks.entries()) {
      conn.pendingPublishAcks.delete(eventId)
      clearTimeout(pendingPublish.timeout)
      pendingPublish.reject(error)
    }
  }

  private async publishToRelay(url: string, event: NostrEvent): Promise<void> {
    const conn = this.ensureConnection(url)

    return new Promise((resolve, reject) => {
      // Keep publish completion tied to the relay OK acknowledgment so we do not
      // treat a local socket send as a persisted event.
      let settled = false
      let connectionWaitTimeout: NodeJS.Timeout | null = null

      const resolvePublish = (): void => {
        if (settled) return
        settled = true
        if (connectionWaitTimeout) clearTimeout(connectionWaitTimeout)
        resolve()
      }

      const rejectPublish = (error: Error): void => {
        if (settled) return
        settled = true
        if (connectionWaitTimeout) clearTimeout(connectionWaitTimeout)
        reject(error)
      }

      const sendForAck = (socket: WebSocket): void => {
        if (conn.pendingPublishAcks.has(event.id)) {
          rejectPublish(
            new Error(
              `Publish already pending for event ${event.id.slice(0, 8)}... on ${url}`,
            ),
          )
          return
        }

        const ackTimeout = setTimeout(() => {
          const pendingPublish = conn.pendingPublishAcks.get(event.id)
          if (!pendingPublish) return

          conn.pendingPublishAcks.delete(event.id)
          pendingPublish.reject(
            new Error(
              `Publish timeout waiting for OK from ${url} for event ${event.id.slice(0, 8)}...`,
            ),
          )
        }, 10_000)

        conn.pendingPublishAcks.set(event.id, {
          resolve: resolvePublish,
          reject: rejectPublish,
          timeout: ackTimeout,
        })

        socket.send(JSON.stringify(['EVENT', event]), (sendError?: Error) => {
          if (!sendError) return

          const pendingPublish = conn.pendingPublishAcks.get(event.id)
          if (!pendingPublish) return

          conn.pendingPublishAcks.delete(event.id)
          clearTimeout(pendingPublish.timeout)
          pendingPublish.reject(
            new Error(
              `Failed to send event ${event.id.slice(0, 8)}... to ${url}: ${sendError.message}`,
            ),
          )
        })
      }

      const waitForOpen = (): void => {
        const socket = conn.ws
        if (!socket) {
          rejectPublish(new Error(`Relay ${url} not connected`))
          return
        }

        if (socket.readyState === WebSocket.OPEN) {
          sendForAck(socket)
          return
        }

        if (socket.readyState === WebSocket.CONNECTING) {
          socket.once('open', waitForOpen)
          return
        }

        rejectPublish(new Error(`Relay ${url} not connected`))
      }

      connectionWaitTimeout = setTimeout(
        () => rejectPublish(new Error(`Publish timeout waiting for connection to ${url}`)),
        10_000,
      )

      waitForOpen()
    })
  }
}
