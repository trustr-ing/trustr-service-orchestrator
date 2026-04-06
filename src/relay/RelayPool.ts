import WebSocket from 'ws'
import type { NostrEvent } from '../store/types'

export type EventHandler = (event: NostrEvent, relayUrl: string) => void

interface Subscription {
  id: string
  filter: Record<string, unknown>
  handler: EventHandler
}

interface RelayConnection {
  url: string
  ws: WebSocket | null
  subscriptions: Map<string, Subscription>
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

  async publish(relayUrls: string[], event: NostrEvent): Promise<void> {
    const publishPromises = relayUrls.map(url => this.publishToRelay(url, event))
    await Promise.allSettled(publishPromises)
  }

  stop(): void {
    for (const conn of this.connections.values()) {
      conn.stopped = true
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
      console.log(`[relay-pool] disconnected from ${conn.url} (code ${code}), reconnecting in ${conn.reconnectDelay}ms`)
      this.scheduleReconnect(conn)
    })

    conn.ws.on('error', (err: Error) => {
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

    if (!Array.isArray(msg) || msg.length < 3) return

    const [type, subId, payload] = msg as [unknown, unknown, unknown]
    if (type !== 'EVENT' || typeof subId !== 'string') return

    const sub = conn.subscriptions.get(subId)
    if (sub && payload !== null && typeof payload === 'object') {
      sub.handler(payload as NostrEvent, conn.url)
    }
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

  private async publishToRelay(url: string, event: NostrEvent): Promise<void> {
    const conn = this.ensureConnection(url)

    return new Promise((resolve, reject) => {
      const waitForOpen = (): void => {
        if (conn.ws?.readyState === WebSocket.OPEN) {
          conn.ws.send(JSON.stringify(['EVENT', event]))
          resolve()
        } else if (conn.ws?.readyState === WebSocket.CONNECTING) {
          conn.ws.once('open', () => {
            conn.ws!.send(JSON.stringify(['EVENT', event]))
            resolve()
          })
        } else {
          reject(new Error(`Relay ${url} not connected`))
        }
      }

      const timeout = setTimeout(() => reject(new Error(`Publish timeout to ${url}`)), 10_000)
      try {
        waitForOpen()
      } finally {
        clearTimeout(timeout)
      }
    })
  }
}
