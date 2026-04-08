import { existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { loadConfig } from './config'
import { SqliteStore } from './store/SqliteStore'
import { Orchestrator } from './orchestrator/Orchestrator'
import { HttpServer } from './http/server'

async function main(): Promise<void> {
  const config = loadConfig()
  const httpPort = parseInt(process.env.HTTP_PORT || '3002', 10)

  console.log(`[orchestrator] trustr-service-orchestrator v0.1.0`)
  console.log(`[orchestrator] ${config.services.length} service(s) configured:`)
  for (const s of config.services) {
    console.log(`  • ${s.name} (${s.serviceId}, mode: ${s.pubkeyMode}, pubkey: ${s.pubkey.slice(0, 8)}...)`)
    console.log(`    listen:  ${s.listenRelays.join(', ')}`)
    console.log(`    publish: ${s.publishRelays.join(', ')}`)
    console.log(`    endpoint: ${s.endpoint}`)
  }

  // Ensure storage directory exists
  if (!existsSync(config.storageDir)) {
    mkdirSync(config.storageDir, { recursive: true })
  }

  const dbPath = join(config.storageDir, 'orchestrator.db')
  const store = new SqliteStore(dbPath)
  const orchestrator = new Orchestrator(config, store)

  await orchestrator.start()

  // Start HTTP server
  const httpServer = new HttpServer(httpPort, orchestrator)
  httpServer.start()

  const shutdown = async (): Promise<void> => {
    httpServer.stop()
    await orchestrator.stop()
    process.exit(0)
  }

  process.on('SIGTERM', () => void shutdown())
  process.on('SIGINT', () => void shutdown())
}

main().catch(err => {
  console.error('[orchestrator] fatal error:', err)
  process.exit(1)
})
