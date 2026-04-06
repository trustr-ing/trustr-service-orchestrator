# trustr-service-orchestrator

Central orchestrator for [TSM (Trust Service Machine)](../trusted-services-nips/TSM/tsm-trust-service-machines.md) service modules. Manages all signing keys, relay connections, announcements, and request routing — service modules become stateless compute workers.

## Architecture

```
  Listen Relays (wss://...)                     Publish Relays (wss://...)
       │                                               ▲
       │  kind 37572 requests                          │  kind 37570 announcements
       ▼                                               │  kind 37573 output
 ┌─────────────────────────────────────────────────────┼──────────────────────┐
 │                  trustr-service-orchestrator        │                      │
 │                                                     │                      │
 │  RelayPool ───► RequestPipeline                EventPublisher              │
 │                   │                              ▲                         │
 │   validate:       │  resolve p-tag               │  sign with              │
 │     kind 37572    │  → service key?              │  resolved keypair       │
 │     dedup         │  → subscription key?         │                         │
 │     author ↔ p    │  → request key?              │                         │
 │     output kind   │                              │                         │
 │     authorized?   │                              │                         │
 │                   ▼                              │                         │
 │              ServiceClient ──POST /tsm/request──►│◄── SSE stream           │
 │                   │          (to VPC service)    │    of unsigned events   │
 │                   │                              │                         │
 │   AnnouncementManager ─GET /tsm/announce────────►│                         │
 │   (startup + periodic)   enrich tags, sign       │                         │
 │                                                                            │
 │   OrchestratorStore (SQLite)                                               │
 │     subscriptions, request keys, ACL                                       │
 └────────────────────────────────────────────────────────────────────────────┘
       │                              │
       ▼                              ▼
  GrapeRank Service             Semantic Service
  http://...:3001               http://...:3002
```

### Key design principles

- **Service modules never hold private keys** — the orchestrator signs all events
- **Service modules never connect to relays** — they return unsigned events via SSE stream
- **Per-service relay configuration** — each service has its own listen + publish relays
- **Provider pubkey modes** — supports service, subscription, and request keypair strategies (TSM spec Appendix 2)

### Request pipeline

1. **Kind check** — must be kind `37572`
2. **Deduplication** — bounded cache of 1,000 recent event IDs
3. **Encrypted requests** — skip if `content` is non-empty (not yet supported)
4. **Resolve `p` tag** — match against service pubkey → subscription pubkey → request pubkey
5. **Author validation** — request `pubkey` must correspond to the resolved `p` tag
6. **Output kind match** — at least one `k` tag must match the service's output kinds
7. **Publish feedback** — orchestrator signs and publishes "request received" (kind 7000)
8. **Forward to service** — POST to service module, read SSE stream of unsigned events
9. **Sign and publish** — each unsigned event is signed with the resolved keypair and published
10. **Publish feedback** — orchestrator signs and publishes "request completed" (kind 7000)

---

## Configuration

```bash
cp .env.example .env
```

### Global variables

| Variable | Required | Description |
|---|---|---|
| `RECONNECT_BASE_MS` | no | Initial relay reconnect backoff (default: `1000`) |
| `RECONNECT_MAX_MS` | no | Maximum relay reconnect backoff (default: `60000`) |
| `STORAGE_DIR` | no | SQLite database directory (default: `./data`) |
| `ANNOUNCE_INTERVAL_MS` | no | Announcement refresh interval (default: `21600000` / 6 hours) |

### Per-service variables

Increment the index (`1`, `2`, `3`, …) for additional services.

| Variable | Required | Description |
|---|---|---|
| `TSM_SERVICE_N_PRIVKEY` | ✅ | Hex private key (pubkey derived automatically) |
| `TSM_SERVICE_N_SERVICE_ID` | ✅ | Service identifier (matches announcement `d` tag) |
| `TSM_SERVICE_N_ENDPOINT` | ✅ | Service module base URL (e.g. `http://127.0.0.1:3001`) |
| `TSM_SERVICE_N_LISTEN_RELAYS` | ✅ | Comma-separated relay URLs for listening to requests |
| `TSM_SERVICE_N_PUBLISH_RELAYS` | ✅ | Comma-separated relay URLs for publishing events |
| `TSM_SERVICE_N_NAME` | no | Human-readable name |
| `TSM_SERVICE_N_PUBKEY_MODE` | no | Key strategy: `service` (default), `subscription`, or `request` |
| `TSM_SERVICE_N_OUTPUT_KINDS` | no | Expected output kinds (default: `37573`) |

---

## Service module protocol

Service modules are stateless HTTP servers exposing:

| Method | Path | Description |
|---|---|---|
| `GET` | `/tsm/announce` | Return unsigned kind 37570 announcement (JSON) |
| `POST` | `/tsm/request` | Accept `{ event, serviceId }`, respond with `text/event-stream` of unsigned events |
| `GET` | `/health` | Health check — returns `{ status: 'ok' }` |

The SSE stream format for `/tsm/request`:
```
data: {"kind": 7000, "created_at": 1234567890, "tags": [...], "content": ""}
data: {"kind": 37573, "created_at": 1234567890, "tags": [...], "content": ""}
```

The orchestrator enriches announcements (adds `d`, `p`, and `r` tags) and signs all events before publishing.

---

## Development

```bash
npm install
npm run dev          # tsx src/index.ts
npm run typecheck    # tsc --noEmit
npm run build        # esbuild → dist/index.js
npm start            # node dist/index.js
```

---

## Deployment

### 1. Prerequisites

```bash
sudo useradd --system --no-create-home --shell /usr/sbin/nologin trustr
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt install -y nodejs
```

### 2. Deploy service modules first

Service modules must be running before the orchestrator starts. See:
- [trustr-graperank-service](../trustr-graperank-service/)
- [trustr-semantic-ranking-service](../trustr-semantic-ranking-service/)

### 3. Install the orchestrator

```bash
npm install && npm run build

sudo mkdir -p /opt/trustr-service-orchestrator/data
sudo cp -r dist node_modules package.json /opt/trustr-service-orchestrator/
sudo cp .env.example /opt/trustr-service-orchestrator/.env
sudo nano /opt/trustr-service-orchestrator/.env
sudo chmod 600 /opt/trustr-service-orchestrator/.env
sudo chown -R trustr:trustr /opt/trustr-service-orchestrator
```

### 4. Systemd

```bash
sudo cp trustr-service-orchestrator.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now trustr-service-orchestrator
```

### 5. Common operations

```bash
sudo systemctl status trustr-service-orchestrator
sudo journalctl -u trustr-service-orchestrator -f

# Redeploy
npm run build && sudo cp dist/index.js /opt/trustr-service-orchestrator/dist/
sudo systemctl restart trustr-service-orchestrator
```

---

## Service modules

| Service | Repo | Default Port | Output Kind |
|---|---|---|---|
| GrapeRank WoT | `trustr-graperank-service` | `3001` | `37573` |
| Semantic Ranking | `trustr-semantic-ranking-service` | `3002` | `37573` |

---

## Related

- [trustr-graperank-service](../trustr-graperank-service/) — GrapeRank WoT ranking module
- [trustr-semantic-ranking-service](../trustr-semantic-ranking-service/) — Semantic ranking module
- [graperank-tsm](../graperank-tsm/) — GrapeRank algorithm library
- [TSM Specification](../trusted-services-nips/TSM/tsm-trust-service-machines.md)
- [TSM Ranking Services](../trusted-services-nips/TSM/tsm-ranking-services.md)
