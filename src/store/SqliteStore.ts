import Database from 'better-sqlite3'
import { randomUUID } from 'crypto'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { bytesToHex } from 'nostr-tools/utils'
import type { OrchestratorStore } from './OrchestratorStore'
import type {
  Subscription,
  NewSubscription,
  RequestKey,
  NewRequestKey,
  SubscriptionStatus,
} from './types'

export class SqliteStore implements OrchestratorStore {
  private db: Database.Database

  constructor(dbPath: string) {
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')
  }

  async initialize(): Promise<void> {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS subscriptions (
        id TEXT PRIMARY KEY,
        user_pubkey TEXT NOT NULL,
        subscription_pubkey TEXT NOT NULL UNIQUE,
        subscription_privkey TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        allowed_services TEXT,
        created_at INTEGER NOT NULL,
        expires_at INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_subscriptions_user_lookup
        ON subscriptions(user_pubkey);
      CREATE INDEX IF NOT EXISTS idx_subscriptions_pubkey
        ON subscriptions(subscription_pubkey);

      CREATE TABLE IF NOT EXISTS request_keys (
        id TEXT PRIMARY KEY,
        subscription_id TEXT NOT NULL,
        request_pubkey TEXT NOT NULL UNIQUE,
        request_privkey TEXT NOT NULL,
        request_event_id TEXT,
        used INTEGER NOT NULL DEFAULT 0,
        used_at INTEGER,
        created_at INTEGER NOT NULL,
        expires_at INTEGER,
        FOREIGN KEY (subscription_id) REFERENCES subscriptions(id)
      );

      CREATE INDEX IF NOT EXISTS idx_request_keys_pubkey
        ON request_keys(request_pubkey);
      CREATE INDEX IF NOT EXISTS idx_request_keys_unused
        ON request_keys(used) WHERE used = 0;
    `)
  }

  // ── Subscriptions ──────────────────────────────────────────────────────

  async createSubscription(sub: NewSubscription): Promise<Subscription> {
    const secretKey = generateSecretKey()
    const subscriptionPubkey = getPublicKey(secretKey)
    const subscriptionPrivkey = bytesToHex(secretKey)
    const id = randomUUID()
    const createdAt = Math.floor(Date.now() / 1000)
    const status = sub.status ?? 'active'
    const allowedServices = sub.allowedServices ?? null
    const expiresAt = sub.expiresAt ?? null

    this.db.prepare(`
      INSERT INTO subscriptions
        (id, user_pubkey, subscription_pubkey, subscription_privkey, status, allowed_services, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      sub.userPubkey,
      subscriptionPubkey,
      subscriptionPrivkey,
      status,
      allowedServices ? JSON.stringify(allowedServices) : null,
      createdAt,
      expiresAt,
    )

    return {
      id,
      userPubkey: sub.userPubkey,
      subscriptionPubkey,
      subscriptionPrivkey,
      status,
      allowedServices,
      createdAt,
      expiresAt,
    }
  }

  async getSubscription(id: string): Promise<Subscription | null> {
    const row = this.db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(id) as SubscriptionRow | undefined
    return row ? mapSubscription(row) : null
  }

  async getSubscriptionByPubkey(pubkey: string): Promise<Subscription | null> {
    const row = this.db.prepare(
      'SELECT * FROM subscriptions WHERE subscription_pubkey = ?',
    ).get(pubkey) as SubscriptionRow | undefined
    return row ? mapSubscription(row) : null
  }

  async getSubscriptionsByUser(userPubkey: string): Promise<Subscription[]> {
    const rows = this.db.prepare(
      'SELECT * FROM subscriptions WHERE user_pubkey = ?',
    ).all(userPubkey) as SubscriptionRow[]
    return rows.map(mapSubscription)
  }

  async updateSubscriptionStatus(id: string, status: SubscriptionStatus): Promise<void> {
    this.db.prepare('UPDATE subscriptions SET status = ? WHERE id = ?').run(status, id)
  }

  async listActiveSubscriptionPubkeys(): Promise<string[]> {
    const rows = this.db.prepare(
      "SELECT subscription_pubkey FROM subscriptions WHERE status = 'active'",
    ).all() as Array<{ subscription_pubkey: string }>
    return rows.map(r => r.subscription_pubkey)
  }

  // ── Request keys ───────────────────────────────────────────────────────

  async createRequestKey(reqKey: NewRequestKey): Promise<RequestKey> {
    const secretKey = generateSecretKey()
    const requestPubkey = getPublicKey(secretKey)
    const requestPrivkey = bytesToHex(secretKey)
    const id = randomUUID()
    const createdAt = Math.floor(Date.now() / 1000)
    const expiresAt = reqKey.expiresAt ?? null
    const requestEventId = reqKey.requestEventId ?? null

    this.db.prepare(`
      INSERT INTO request_keys
        (id, subscription_id, request_pubkey, request_privkey, request_event_id, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, reqKey.subscriptionId, requestPubkey, requestPrivkey, requestEventId, createdAt, expiresAt)

    return {
      id,
      subscriptionId: reqKey.subscriptionId,
      requestPubkey,
      requestPrivkey,
      requestEventId,
      used: false,
      usedAt: null,
      createdAt,
      expiresAt,
    }
  }

  async getRequestKeyByPubkey(pubkey: string): Promise<RequestKey | null> {
    const row = this.db.prepare(
      'SELECT * FROM request_keys WHERE request_pubkey = ?',
    ).get(pubkey) as RequestKeyRow | undefined
    return row ? mapRequestKey(row) : null
  }

  async listUnusedRequestKeyPubkeys(): Promise<string[]> {
    const now = Math.floor(Date.now() / 1000)
    const rows = this.db.prepare(
      `SELECT request_pubkey FROM request_keys 
       WHERE used = 0 
       AND (expires_at IS NULL OR expires_at > ?)`,
    ).all(now) as Array<{ request_pubkey: string }>
    return rows.map(r => r.request_pubkey)
  }

  async markRequestKeyAsUsed(id: string, eventId: string): Promise<void> {
    const now = Math.floor(Date.now() / 1000)
    this.db.prepare(
      'UPDATE request_keys SET used = 1, used_at = ?, request_event_id = ? WHERE id = ?'
    ).run(now, eventId, id)
  }

  // ── Authorization ──────────────────────────────────────────────────────

  async isAuthorized(userPubkey: string, serviceId: string): Promise<boolean> {
    const rows = this.db.prepare(
      "SELECT allowed_services FROM subscriptions WHERE user_pubkey = ? AND status = 'active'",
    ).all(userPubkey) as Array<{ allowed_services: string | null }>

    for (const row of rows) {
      if (row.allowed_services === null) return true
      const allowed: string[] = JSON.parse(row.allowed_services)
      if (allowed.includes(serviceId)) return true
    }
    return false
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  async close(): Promise<void> {
    this.db.close()
  }
}

// ── Row mapping helpers ──────────────────────────────────────────────────────

interface SubscriptionRow {
  id: string
  user_pubkey: string
  subscription_pubkey: string
  subscription_privkey: string
  status: SubscriptionStatus
  allowed_services: string | null
  created_at: number
  expires_at: number | null
}

interface RequestKeyRow {
  id: string
  subscription_id: string
  request_pubkey: string
  request_privkey: string
  request_event_id: string | null
  used: number
  used_at: number | null
  created_at: number
  expires_at: number | null
}

function mapSubscription(row: SubscriptionRow): Subscription {
  return {
    id: row.id,
    userPubkey: row.user_pubkey,
    subscriptionPubkey: row.subscription_pubkey,
    subscriptionPrivkey: row.subscription_privkey,
    status: row.status,
    allowedServices: row.allowed_services ? JSON.parse(row.allowed_services) : null,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  }
}

function mapRequestKey(row: RequestKeyRow): RequestKey {
  return {
    id: row.id,
    subscriptionId: row.subscription_id,
    requestPubkey: row.request_pubkey,
    requestPrivkey: row.request_privkey,
    requestEventId: row.request_event_id,
    used: row.used === 1,
    usedAt: row.used_at,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  }
}
