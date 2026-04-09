import { getPublicKey } from 'nostr-tools/pure'
import { hexToBytes } from 'nostr-tools/utils'
import type { PubkeyMode, ServiceRecord } from './store/types'

export interface OrchestratorConfig {
  reconnectBaseMs: number
  reconnectMaxMs: number
  storageDir: string
  announceIntervalMs: number
  services: ServiceRecord[]
}

function parseCommaSeparated(raw: string | undefined): string[] {
  return (raw ?? '').split(',').map(s => s.trim()).filter(Boolean)
}

function parseServiceConfigs(): ServiceRecord[] {
  const services: ServiceRecord[] = []
  let index = 1

  while (true) {
    const prefix = `TSM_SERVICE_${index}_`
    const privkey = process.env[`${prefix}PRIVKEY`]
    if (!privkey) break

    const endpoint = process.env[`${prefix}ENDPOINT`]
    if (!endpoint) throw new Error(`${prefix}ENDPOINT is required`)

    const serviceId = process.env[`${prefix}SERVICE_ID`]
    if (!serviceId) throw new Error(`${prefix}SERVICE_ID is required`)

    const pubkeyMode = (process.env[`${prefix}PUBKEY_MODE`] ?? 'public_service') as PubkeyMode
    if (!['public_service', 'subscription_service', 'restricted_service'].includes(pubkeyMode)) {
      throw new Error(`${prefix}PUBKEY_MODE must be one of: public_service, subscription_service, restricted_service`)
    }

    const pubkey = getPublicKey(hexToBytes(privkey))

    const outputKindsRaw = process.env[`${prefix}OUTPUT_KINDS`] ?? '37573'
    const outputKinds = outputKindsRaw.split(',').map(k => parseInt(k.trim(), 10)).filter(k => !isNaN(k))

    const listenRelays = parseCommaSeparated(process.env[`${prefix}LISTEN_RELAYS`])
    if (listenRelays.length === 0) throw new Error(`${prefix}LISTEN_RELAYS is required (comma-separated relay URLs)`)

    const publishRelays = parseCommaSeparated(process.env[`${prefix}PUBLISH_RELAYS`])
    if (publishRelays.length === 0) throw new Error(`${prefix}PUBLISH_RELAYS is required (comma-separated relay URLs)`)

    services.push({
      id: `service_${index}`,
      name: process.env[`${prefix}NAME`] ?? `Service ${index}`,
      endpoint,
      serviceId,
      pubkeyMode,
      privkey,
      pubkey,
      outputKinds,
      listenRelays,
      publishRelays,
    })

    index++
  }

  return services
}

export function loadConfig(): OrchestratorConfig {
  const services = parseServiceConfigs()
  if (services.length === 0) {
    throw new Error('At least one TSM_SERVICE_1_PRIVKEY / TSM_SERVICE_1_ENDPOINT must be configured')
  }

  return {
    reconnectBaseMs: parseInt(process.env['RECONNECT_BASE_MS'] ?? '1000', 10),
    reconnectMaxMs: parseInt(process.env['RECONNECT_MAX_MS'] ?? '60000', 10),
    storageDir: process.env['STORAGE_DIR'] ?? './data',
    announceIntervalMs: parseInt(process.env['ANNOUNCE_INTERVAL_MS'] ?? String(6 * 60 * 60 * 1000), 10),
    services,
  }
}
