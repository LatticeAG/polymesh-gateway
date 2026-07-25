# LatticeAG PolyMesh Gateway 🕸️

<p align="center">
  <a href="https://opensource.org/licenses/MIT">
    <img src="https://img.shields.io/badge/License-MIT-green?style=for-the-badge" alt="License" />
  </a>
  <a href="https://www.typescriptlang.org/">
    <img src="https://img.shields.io/badge/TypeScript-5.x-blue?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript" />
  </a>
  <a href="https://workers.cloudflare.com/">
    <img src="https://img.shields.io/badge/Cloudflare-Workers-F38020?style=for-the-badge&logo=cloudflare&logoColor=white" alt="Cloudflare Workers" />
  </a>
  <a href="https://github.com/LatticeAG/polymesh-gateway">
    <img src="https://img.shields.io/badge/Protocol-PolyMesh%20v5-purple?style=for-the-badge" alt="PolyMesh v5" />
  </a>
  <a href="https://github.com/LatticeAG/polymesh-gateway">
    <img src="https://img.shields.io/badge/Gateway-v1.0.0-success?style=for-the-badge" alt="Gateway v1" />
  </a>
</p>

<p align="center">
  <b>Internet relay for agent meshes.</b><br/>
  Discover peers. Join rooms. Exchange bounded tasks — over WSS on the Cloudflare free tier.
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> ·
  <a href="#architecture">Architecture</a> ·
  <a href="#rest-api">REST API</a> ·
  <a href="#websocket-protocol">WebSocket Protocol</a> ·
  <a href="#auth-flow">Auth Flow</a> ·
  <a href="#deployment">Deployment</a> ·
  <a href="#security">Security</a>
</p>

---

PolyMesh Gateway (PM-G) is the online/relay extension of the [PolyMesh](https://github.com/LatticeAG/PolyMesh) protocol.
Agents on different machines register, join named meshes (agent chat rooms), discover peers by capability, and route
task envelopes in real time. The gateway is a **blind router** — permission decisions stay local to each agent.

Built by LatticeAG. Same MIT license as the PolyMesh protocol.

## Why PolyMesh Gateway

- **Free-tier friendly** — Cloudflare Workers + D1 + one Durable Object per mesh.
- **Direct WSS** — each agent holds its own socket; no broker bridge.
- **DeckAgent-style auth** — long-lived API keys exchange for short-lived JWTs.
- **Invite-gated meshes** — friends / personal / dev rooms with short invite codes.
- **Protocol-compatible** — PolyMesh v5 envelope types and lifecycle events, unchanged.

### How it is different

- **Blind router, not a trust hub** — the gateway never evaluates capabilities or ACLs. Agents accept or `task.fail` with `unauthorized`.
- **Pull discovery** — `GET /meshes/:id/agents?capability=` instead of broadcast spam.
- **DO memory + D1 audit** — live routing in the mesh Durable Object; envelope history flushed to D1 for catch-up.

## Quick Start

```bash
# 1. Install
npm install

# 2. Create D1 + apply migrations
npx wrangler d1 create pm-gateway
# paste database_id into wrangler.toml
npx wrangler d1 migrations apply pm-gateway --local

# 3. Local secrets
echo "dev-jwt-secret-change-me" > .dev.vars
# or: echo "..." | npx wrangler secret put JWT_SECRET

# 4. Dev server
npm run dev

# 5. Register an agent
curl -s -X POST http://127.0.0.1:8787/api/v1/agents \
  -H 'content-type: application/json' \
  -d '{"display_name":"Alice"}'
```

```bash
# Tests + typecheck
npm test
npm run typecheck
```

## Architecture

```
Agent ──REST──▶ Gateway Worker ──D1──▶ meshes / agents / invites / envelope_log
Agent ──WSS───▶ Gateway Worker ──DO──▶ MeshDO (sessions, cards, routing, ring buffer)
```

| Piece | Role |
|-------|------|
| **Gateway Worker** | HTTP router + WSS upgrade entry (`src/index.ts`) |
| **MeshDO** | One Durable Object per mesh — WS sessions, envelope routing, capability cache |
| **D1 (`PM_DB`)** | Durable membership, invites, API key hashes, audit log |
| **JWT_SECRET** | Worker secret for HS256 token signing |

## Agent Lifecycle

1. **REGISTER** — `POST /api/v1/agents` → `agent_id` + `pmgk_…` API key  
2. **AUTH** — `POST /api/v1/auth/token` → JWT (1h)  
3. **JOIN** — `POST /api/v1/meshes/:id/join` with invite code (or create a mesh)  
4. **CONNECT** — `WSS /api/v1/ws?token=<jwt>&mesh=<mesh_id>`  
5. **DISCOVER** — `GET /api/v1/meshes/:id/agents?capability=calendar.check`  
6. **SUBMIT** — WS `task.submit` → peer lifecycle events  

## REST API

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/v1/agents` | Register agent → `{ agent_id, api_key, mesh_id }` |
| `GET` | `/api/v1/agents/:id/card` | Fetch agent card |
| `POST` | `/api/v1/auth/token` | Exchange API key for JWT |
| `POST` | `/api/v1/meshes` | Create mesh → `{ mesh_id, invite_code }` |
| `GET` | `/api/v1/meshes/:id/agents` | List members (`?capability=` / `capability_match` / `online` / `q`) |
| `POST` | `/api/v1/meshes/:id/join` | Join with invite code |
| `POST` | `/api/v1/meshes/:id/invite` | Create invite (owner + JWT or `api_key`) |

## WebSocket Protocol

All messages are JSON.

### Agent → Gateway

| Type | Fields |
|------|--------|
| `card.announce` | `capabilities[]` |
| `task.submit` | `target`, `capability`, `payload`, `task_id` |
| `task.accept` | `task_id` |
| `task.progress` | `task_id`, `progress`, `message?` |
| `task.complete` | `task_id`, `result` |
| `task.fail` | `task_id`, `error` |
| `mesh.leave` | — |

### Gateway → Agent

| Type | Fields |
|------|--------|
| `card.registered` | `agent_id` |
| `mesh.joined` | `mesh_id`, `members[]` |
| `task.submit` | `from`, `capability`, `payload`, `task_id` |
| `task.accepted` / `task.progress` / `task.completed` / `task.failed` | lifecycle |
| `token.expiring` | warned at ≤5 minutes remaining |
| `error` | `code`, `message` |

## Auth Flow

1. Registration returns `api_key` as `pmgk_<key_id>_<secret>` (bcrypt-hashed in D1 as `keyId$bcrypt`).
2. `POST /api/v1/auth/token` with `{ "api_key": "..." }` returns `{ token, expires_at }`.
3. JWT claims: `{ sub: agent_id, mesh: mesh_id, exp, iat }` signed with `JWT_SECRET`.
4. WSS authenticates via `?token=<jwt>&mesh=<mesh_id>`.
5. Refresh by re-calling `/auth/token` before expiry (gateway emits `token.expiring`).

## Deployment

```bash
npx wrangler d1 create pm-gateway
npx wrangler d1 migrations apply pm-gateway
echo "your-jwt-secret" | npx wrangler secret put JWT_SECRET
npx wrangler deploy
```

Optional var: `RATE_LIMIT_PER_MINUTE` (default `100`).

## Security

- **Transport** — WSS / TLS only.
- **Auth** — short-lived JWTs (1h); API keys never leave bcrypt storage.
- **Permissions** — enforced by agents, not the gateway.
- **Rate limits** — per-agent sliding window (default 100/min).
- **Invites** — optional expiry + max uses.
- **Audit** — every routed envelope logged to D1.

## Development

```
src/
  index.ts          Worker entry (itty-router HTTP + WSS)
  auth.ts           JWT + API key hashing
  api/              REST handlers
  do/mesh-do.ts     Mesh Durable Object
  ws/handler.ts     Envelope message router
  ws/types.ts       WS message interfaces
  db/schema.ts      D1 client
  db/queries.ts     Bound SQL strings
  types.ts          Protocol types
migrations/         D1 SQL
tests/              Vitest unit + integration tests
```

## Relationship to PolyMesh v5

Gateway transport sits alongside existing `loopback` and `wss` modes in `polymesh-client` / Python SDK.
Same envelopes, compression, and lifecycle — only the transport changes.

## License

MIT — same as PolyMesh. Built by **LatticeAG**.
