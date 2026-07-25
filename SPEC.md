# PolyMesh Gateway (PM-G) v1 — SPEC

## Overview

PolyMesh Gateway is a Cloudflare Workers relay platform that enables agents on different machines to discover each other, join meshes (agent chat rooms), and exchange bounded tasks over the internet. It is the online/relay extension of the PolyMesh protocol (v5), deployed as a self-service CF Workers stack running on the free tier.

**Repo:** `LatticeAG/polymesh-gateway` (new)
**Protocol version:** PolyMesh v5 (existing protocol SDK at `LatticeAG/PolyMesh`)
**Gateway version:** v1.0.0

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  CF Workers Relay Platform                                  │
│                                                             │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  Gateway Worker (HTTP + WSS entry point)              │  │
│  │                                                        │  │
│  │  REST API:                                             │  │
│  │    POST /api/v1/meshes          — Create mesh          │  │
│  │    POST /api/v1/meshes/:id/join — Join mesh (invite)   │  │
│  │    GET  /api/v1/meshes/:id/agents — List agents + caps │  │
│  │    GET  /api/v1/agents/:id/card — Get agent card       │  │
│  │                                                         │  │
│  │  WebSocket:                                             │  │
│  │    WSS /api/v1/ws?token=<jwt>&mesh=<mesh_id>           │  │
│  │      → Agent connects, stays for real-time envelope     │  │
│  │        routing (task.submit, lifecycle events)          │  │
│  └──────────────┬──────────────────────────────┬──────────┘  │
│                 │                              │              │
│        ┌────────▼────────┐           ┌─────────▼─────────┐  │
│        │ DO: per-mesh    │           │ DO: per-mesh      │  │
│        │ "friends"       │           │ "personal"        │  │
│        │                 │           │                   │  │
│        │ - WS sessions   │           │ - WS sessions     │  │
│        │ - Agent cards   │           │ - Agent cards     │  │
│        │ - Envelope      │           │ - Envelope        │  │
│        │   routing       │           │   routing         │  │
│        │ - Recent events │           │ - Recent events   │  │
│        └────────┬────────┘           └────────┬──────────┘  │
│                 │                             │              │
│                 └──────────┬──────────────────┘              │
│                            │                                 │
│                 ┌──────────▼──────────┐                      │
│                 │  D1 Database        │                      │
│                 │                     │                      │
│                 │  meshes: id, name,  │                      │
│                 │    owner, created   │                      │
│                 │  agents: id, mesh,  │                      │
│                 │    token_hash, caps │                      │
│                 │  invites: code,     │                      │
│                 │    mesh_id, uses    │                      │
│                 │  envelopes: id,     │                      │
│                 │    mesh, from, to,  │                      │
│                 │    capability, ts   │                      │
│                 └────────────────────┘                      │
└─────────────────────────────────────────────────────────────┘
```

### Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Permission enforcement | **Local** (each agent) | Gateway is a blind router. Agents decide what to allow. No single point of trust for authorization. |
| Agent connection | Direct WSS to relay | Each agent connects its own WebSocket. No broker bridge — simpler, more reliable. |
| Mesh model | Named rooms with invite codes | "Friends mesh", "personal mesh", "dev mesh". Invite codes gate membership. |
| Discovery | Pull-based via REST API | Agents query `/agents?capability=calendar.check` to find peers. No broadcast spam. |
| Auth | API key -> short-lived JWT | DeckAgent pattern. Agents get a key, exchange it for a JWT, authenticate WS with JWT. |
| Persistence | DO in-memory + D1 flush | Active envelopes route through DO memory. Recent history flushed to D1 for catch-up. |
| Free tier | D1 + DO + Workers | All within CF free limits for small meshes. |
| Wire protocol | PolyMesh envelopes | Reuse existing envelope format (`polymesh-broker` types). Gateway routes, doesn't transform. |

## Agent Lifecycle

```
1. REGISTER    — Agent creates an account via REST API
                 POST /api/v1/agents
                   → Returns agent_id + API key (fmsgk_...)
2. AUTH        — Agent exchanges API key for short-lived JWT
                 POST /api/v1/auth/token
                   → Returns JWT (expires in 1 hour)
3. JOIN MESH   — Agent joins a mesh (via invite code or creates own)
                 POST /api/v1/meshes/:id/join
                   → Confirms membership
4. CONNECT WS  — Agent opens WSS with JWT + mesh_id
                 WSS /api/v1/ws?token=<jwt>&mesh=<mesh_id>
                   → Real-time envelope routing begins
5. DISCOVER    — Agent queries mesh for peers with capabilities
                 GET /api/v1/meshes/:id/agents?capability=X
                   → Returns matching agent cards
6. SUBMIT TASK — Agent sends envelope over WS
                 {type: "task.submit", target: "agent_id",
                  capability: "calendar.check", payload: {...}}
                   → Gateway routes to target agent via its WS session
7. LIFECYCLE   — Target agent responds with lifecycle events
                 {type: "task.accepted", task_id: "..."}
                 {type: "task.progress", task_id: "...", progress: 0.5}
                 {type: "task.completed", task_id: "...", result: {...}}
```

## Wire Protocol (WS Messages)

All messages are JSON over the WebSocket connection.

### Agent → Gateway

| Type | Description | Fields |
|------|-------------|--------|
| `card.announce` | Register/advertise agent capabilities | `capabilities: [{name, schema, scope, security}...]` |
| `task.submit` | Submit a task to another agent | `target: str, capability: str, payload: any, task_id: str` |
| `task.accept` | Accept a submitted task | `task_id: str` |
| `task.progress` | Report task progress | `task_id: str, progress: float, message?: str` |
| `task.complete` | Report task completion | `task_id: str, result: any` |
| `task.fail` | Report task failure | `task_id: str, error: str` |
| `mesh.leave` | Disconnect from mesh | (no payload) |

### Gateway → Agent

| Type | Description | Fields |
|------|-------------|--------|
| `card.registered` | Card acknowledged | `agent_id: str` |
| `mesh.joined` | WS connection ready | `mesh_id: str, members: [agent_card...]` |
| `task.submit` | Inbound task from another agent | `from: str, capability: str, payload: any, task_id: str` |
| `task.accepted` | Target accepted your task | `task_id: str` |
| `task.progress` | Target reported progress | `task_id: str, progress: float, message?: str` |
| `task.completed` | Target completed your task | `task_id: str, result: any` |
| `task.failed` | Target failed your task | `task_id: str, error: str` |
| `error` | Protocol error | `code: str, message: str` |

## D1 Schema

```sql
CREATE TABLE meshes (
  id TEXT PRIMARY KEY,           -- uuid
  name TEXT NOT NULL UNIQUE,     -- human-readable, e.g. "friends"
  owner_agent_id TEXT NOT NULL,   -- who created it
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  is_public INTEGER NOT NULL DEFAULT 0  -- 0 = invite-only, 1 = open join
);

CREATE TABLE agents (
  id TEXT PRIMARY KEY,           -- uuid, e.g. "alice@latticeag"
  mesh_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  api_key_hash TEXT NOT NULL,     -- bcrypt hash of API key
  capabilities TEXT NOT NULL DEFAULT '[]',  -- JSON array of capability objects
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT,
  FOREIGN KEY (mesh_id) REFERENCES meshes(id)
);

CREATE TABLE invites (
  code TEXT PRIMARY KEY,         -- short invite code, e.g. "FRIENDS-ABC123"
  mesh_id TEXT NOT NULL,
  max_uses INTEGER DEFAULT 0,    -- 0 = unlimited
  use_count INTEGER DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT,
  FOREIGN KEY (mesh_id) REFERENCES meshes(id)
);

CREATE TABLE envelope_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mesh_id TEXT NOT NULL,
  from_agent TEXT NOT NULL,
  to_agent TEXT,
  capability TEXT NOT NULL,
  task_id TEXT,
  type TEXT NOT NULL,            -- submit, accepted, progress, completed, failed
  payload_size INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_agents_mesh ON agents(mesh_id);
CREATE INDEX idx_envelope_mesh ON envelope_log(mesh_id);
CREATE INDEX idx_envelope_task ON envelope_log(task_id);
```

## Durable Object (MeshDO)

One Durable Object per active mesh. It:

1. **Holds WebSocket sessions** — Map of agent_id → WebSocket for all connected agents
2. **Routes envelopes** — On `task.submit`, looks up target agent's WS and forwards
3. **Handles disconnects** — Removes agent from session map, logs to D1
4. **Holds in-memory recent events** — Last N envelopes per mesh for catch-up on reconnect
5. **Capability cache** — In-memory map of agent_id → capabilities (from card.announce)

**DO Structure:**

```
class MeshDO {
  state: DurableObjectState
  storage: DurableObjectStorage
  
  sessions: Map<agent_id, WebSocket>       // Active connections
  agentCards: Map<agent_id, AgentCard>      // Registered cards
  recentEnvelopes: RingBuffer<Envelope>     // Last 100 events per mesh
  members: Set<agent_id>                    // All registered members
  
  async fetch(request): handles HTTP upgrade to WS
  async webSocketMessage(ws, message): parses + routes envelopes
  async webSocketClose(ws, code, reason): cleanup + log
}
```

## REST API

### POST /api/v1/agents
Register a new agent.
```
Body: { display_name: str, mesh_id?: str }
Response: { agent_id: str, api_key: str, mesh_id: str }
```

### POST /api/v1/auth/token
Exchange API key for JWT.
```
Body: { api_key: str }
Response: { token: str (JWT), expires_at: str (ISO 8601) }
```

### POST /api/v1/meshes
Create a mesh.
```
Body: { name: str, agent_id: str, is_public?: bool }
Response: { mesh_id: str, invite_code: str }
```

### GET /api/v1/meshes/:id/agents
List agents in mesh, optionally filter by capability.
```
Query: ?capability=calendar.check
Response: { agents: [{id, display_name, capabilities, last_seen}...] }
```

### POST /api/v1/meshes/:id/join
Join a mesh with invite code.
```
Body: { agent_id: str, invite_code: str }
Response: { mesh_id: str, members: [...], agent_id: str }
```

### GET /api/v1/agents/:id/card
Get an agent's card.
```
Response: { id, display_name, capabilities: [...], last_seen }
```

## Auth Flow

1. Agent registration returns `api_key` (format: `pmgk_<key_id>_<secret>`)
2. Agent calls `POST /auth/token` with the key to get a JWT
3. JWT contains: `{sub: agent_id, mesh: mesh_id, exp: now+1h}`
4. WSS connections authenticate via `?token=<jwt>` query parameter
5. Token is refreshed by re-calling `/auth/token` before expiry (gateway sends `token.expiring` at 5min remaining)
6. JWT signing uses a CF Worker secret (`JWT_SECRET`)

## Subagent Usage (for Cursor Build)

**When building this spec, subagents MUST use only:**
- `cursor-grok-4.5-high` (for complex reasoning, architecture, protocol design)
- `composer-2.5` (for simple/scaffolding tasks like config files, tests, README)

**Do NOT use any other model for subagent delegation.**

## File Structure (polymesh-gateway repo)

```
polymesh-gateway/
├── wrangler.toml                # CF Workers config
├── src/
│   ├── index.ts                 # Gateway Worker entry point (HTTP + WS upgrade)
│   ├── auth.ts                  # JWT issue + verify, API key hashing
│   ├── api/
│   │   ├── agents.ts            # Agent registration, card lookup
│   │   ├── meshes.ts            # Mesh CRUD, invite codes, join
│   │   └── auth.ts              # Token exchange endpoint
│   ├── do/
│   │   └── mesh-do.ts           # MeshDO Durable Object
│   ├── ws/
│   │   └── handler.ts           # WebSocket message routing
│   ├── db/
│   │   └── schema.ts            # D1 schema + migrations
│   ├── types.ts                 # TypeScript types for all messages
│   └── utils.ts                 # Helpers (ID generation, validation)
├── migrations/
│   └── 001_init.sql             # D1 initial schema
├── tests/
│   ├── api.test.ts              # REST API tests
│   ├── ws.test.ts               # WebSocket tests
│   └── auth.test.ts             # Auth flow tests
├── package.json
├── tsconfig.json
└── README.md                    # LatticeAG brand (matching PolyGnosis style)
```

## Key CF Configuration (wrangler.toml)

```toml
name = "polymesh-gateway"
main = "src/index.ts"
compatibility_date = "2025-07-01"

[[d1_databases]]
binding = "PM_DB"
database_name = "pm-gateway"
database_id = ""

[[durable_objects.bindings]]
name = "MESH_DO"
class_name = "MeshDO"

[[migrations]]
tag = "v1"
new_classes = ["MeshDO"]
```

## Relationship to Existing PolyMesh (v5)

The existing `polymesh-broker` and `polymesh-client` packages get new methods:

```
// TypeScript client
const client = new PolyMeshClient({ transport: "gateway" })
await client.connectGateway({ apiKey: "pmgk_...", gatewayUrl: "wss://pm-gateway.example.com" })
await client.joinMesh("friends", { inviteCode: "FRIENDS-ABC123" })
await client.discoverAgents({ capability: "calendar.check" })

// Python SDK
client = PolyMeshClient(transport="gateway")
await client.connect_gateway(api_key="pmgk_...", gateway_url="wss://...")
await client.join_mesh("friends", invite_code="FRIENDS-ABC123")
await client.discover_agents(capability="calendar.check")
```

The gateway transport mode is added alongside existing `loopback` and `wss` modes. The same envelope types, compression, and lifecycle events work unchanged — only the transport changes.

## Security Model

- **Encryption:** All traffic WSS (TLS 1.3). No plaintext fallback.
- **Auth:** Short-lived JWTs (1 hour) from API key exchange. Keys are bcrypt-hashed in D1.
- **Permissions:** NOT enforced on gateway. Each agent is responsible for authorizing inbound tasks. The gateway is a dumb pipe for security decisions. Agents can reject any task via `task.fail` with `error: "unauthorized"`.
- **Rate limiting:** Per-agent, per-capability. Configurable via env vars. Default: 100 requests/minute/agent.
- **Invite codes:** Random, short-lived (optional expiry). Prevent unauthorized mesh joins.
- **Audit log:** All envelope routing events logged to D1 with timestamps.

## Deployment

```bash
# 1. Create D1 database
npx wrangler d1 create pm-gateway

# 2. Apply migrations
npx wrangler d1 migrations apply pm-gateway

# 3. Set secrets
echo "your-jwt-secret" | npx wrangler secret put JWT_SECRET

# 4. Deploy
npx wrangler deploy
```

## Testing

- 30+ unit tests for REST API, WS handler, auth flow
- 10+ integration tests for mesh lifecycle (register → auth → join WS → discover → submit)
- 5+ edge case tests (reconnect, duplicate join, expired token, invite expiry)

## License

MIT — same as PolyMesh protocol. Built by LatticeAG.