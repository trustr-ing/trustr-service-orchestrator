import { createServer, IncomingMessage, ServerResponse } from 'http'
import { Orchestrator } from '../orchestrator/Orchestrator'
import { KeyManager } from '../keys/KeyManager'

export class HttpServer {
  private server: ReturnType<typeof createServer> | null = null
  private port: number
  private orchestrator: Orchestrator
  private keyManager: KeyManager

  constructor(port: number, orchestrator: Orchestrator, keyManager: KeyManager) {
    this.port = port
    this.orchestrator = orchestrator
    this.keyManager = keyManager
  }

  start(): void {
    this.server = createServer((req, res) => this.handleRequest(req, res))
    this.server.listen(this.port, () => {
      console.log(`[http] server listening on port ${this.port}`)
    })
  }

  stop(): void {
    if (this.server) {
      this.server.close()
      this.server = null
    }
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

    if (req.method === 'OPTIONS') {
      res.writeHead(200)
      res.end()
      return
    }

    const url = req.url || ''
    const method = req.method || ''

    // Public endpoints
    if (url === '/health' && method === 'GET') {
      this.handleHealth(res)
      return
    }

    if (url === '/services' && method === 'GET') {
      void this.handleServices(res)
      return
    }

    // VPC-only endpoints for subscription management
    if (!this.isVpcRequest(req)) {
      res.writeHead(403, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Access restricted to VPC only' }))
      return
    }

    // Subscription routes
    if (url === '/subscriptions' && method === 'GET') {
      void this.handleListSubscriptions(req, res)
    } else if (url === '/subscriptions' && method === 'POST') {
      void this.handleCreateSubscription(req, res)
    } else if (url.match(/^\/subscriptions\/[^/]+$/) && method === 'GET') {
      void this.handleGetSubscription(req, res)
    } else if (url.match(/^\/subscriptions\/[^/]+$/) && method === 'PATCH') {
      void this.handleUpdateSubscription(req, res)
    } else if (url.match(/^\/subscriptions\/[^/]+$/) && method === 'DELETE') {
      void this.handleDeleteSubscription(req, res)
    } else if (url.match(/^\/subscriptions\/[^/]+\/request-keys$/) && method === 'POST') {
      void this.handleCreateRequestKey(req, res)
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Not found' }))
    }
  }

  private isVpcRequest(req: IncomingMessage): boolean {
    const remoteAddr = req.socket.remoteAddress
    if (!remoteAddr) return false
    // Allow localhost and VPC range 10.118.0.0/20
    return remoteAddr === '127.0.0.1' || 
           remoteAddr === '::1' || 
           remoteAddr.startsWith('10.118.') || 
           remoteAddr.startsWith('::ffff:10.118.') ||
           remoteAddr.startsWith('::ffff:127.0.0.1')
  }

  private handleHealth(res: ServerResponse): void {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      status: 'ok',
      timestamp: Date.now()
    }))
  }

  private async handleServices(res: ServerResponse): Promise<void> {
    try {
      const services = await this.orchestrator.getActiveServices()
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        services,
        timestamp: Date.now()
      }))
    } catch (err) {
      console.error('[http] error fetching services:', err)
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Internal server error' }))
    }
  }

  private async handleListSubscriptions(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url || '', `http://${req.headers.host}`)
      const userPubkey = url.searchParams.get('userPubkey')
      
      if (userPubkey) {
        const subscriptions = await this.orchestrator.getStore.getSubscriptionsByUser(userPubkey)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ subscriptions }))
      } else {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'userPubkey query parameter required' }))
      }
    } catch (err) {
      console.error('[http] error listing subscriptions:', err)
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Internal server error' }))
    }
  }

  private async handleCreateSubscription(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const body = await this.readBody(req)
      const { userPubkey, allowedServices, expiresAt } = JSON.parse(body)

      if (!userPubkey) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'userPubkey is required' }))
        return
      }

      const subscription = await this.keyManager.createSubscription(userPubkey, allowedServices)
      res.writeHead(201, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ subscription }))
    } catch (err) {
      console.error('[http] error creating subscription:', err)
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Internal server error' }))
    }
  }

  private async handleGetSubscription(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const id = req.url?.split('/')[2]
      if (!id) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Invalid subscription ID' }))
        return
      }

      const subscription = await this.keyManager.getSubscription(id)
      if (!subscription) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Subscription not found' }))
        return
      }

      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ subscription }))
    } catch (err) {
      console.error('[http] error getting subscription:', err)
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Internal server error' }))
    }
  }

  private async handleUpdateSubscription(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const id = req.url?.split('/')[2]
      if (!id) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Invalid subscription ID' }))
        return
      }

      const body = await this.readBody(req)
      const { status } = JSON.parse(body)

      if (!status || !['active', 'suspended', 'revoked'].includes(status)) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Valid status required (active, suspended, revoked)' }))
        return
      }

      await this.orchestrator.getStore.updateSubscriptionStatus(id, status)
      const subscription = await this.keyManager.getSubscription(id)
      
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ subscription }))
    } catch (err) {
      console.error('[http] error updating subscription:', err)
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Internal server error' }))
    }
  }

  private async handleDeleteSubscription(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const id = req.url?.split('/')[2]
      if (!id) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Invalid subscription ID' }))
        return
      }

      await this.keyManager.revokeSubscription(id)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ success: true }))
    } catch (err) {
      console.error('[http] error deleting subscription:', err)
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Internal server error' }))
    }
  }

  private async handleCreateRequestKey(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const id = req.url?.split('/')[2]
      if (!id) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Invalid subscription ID' }))
        return
      }

      const body = await this.readBody(req)
      const { expiresAt, requestEventId } = JSON.parse(body || '{}')

      const requestKey = await this.keyManager.createRequestKey(id, requestEventId)
      if (expiresAt) {
        // Note: expiresAt support would need to be added to createRequestKey signature
      }
      
      res.writeHead(201, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ requestKey }))
    } catch (err) {
      console.error('[http] error creating request key:', err)
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Internal server error' }))
    }
  }

  private readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let body = ''
      req.on('data', chunk => { body += chunk.toString() })
      req.on('end', () => resolve(body))
      req.on('error', reject)
    })
  }
}
