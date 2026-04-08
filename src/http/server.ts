import { createServer, IncomingMessage, ServerResponse } from 'http'
import { Orchestrator } from '../orchestrator/Orchestrator'

export class HttpServer {
  private server: ReturnType<typeof createServer> | null = null
  private port: number
  private orchestrator: Orchestrator

  constructor(port: number, orchestrator: Orchestrator) {
    this.port = port
    this.orchestrator = orchestrator
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
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

    if (req.method === 'OPTIONS') {
      res.writeHead(200)
      res.end()
      return
    }

    if (req.url === '/health' && req.method === 'GET') {
      this.handleHealth(res)
    } else if (req.url === '/services' && req.method === 'GET') {
      this.handleServices(res)
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Not found' }))
    }
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
}
