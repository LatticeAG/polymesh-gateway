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
  <a href="#why-polymesh-gateway">Why</a> ·
  <a href="#features">Features</a> ·
  <a href="#architecture">Architecture</a> ·
  <a href="#rest-api">REST API</a> ·
  <a href="#websocket-protocol">WebSocket Protocol</a> ·
  <a href="#auth-flow">Auth Flow</a> ·
  <a href="#configuration">Configuration</a> ·
  <a href="#deployment">Deployment</a> ·
  <a href="#verification">Verification</a> ·
  <a href="#file-tree">File Tree</a> ·
  <a href="#known-issues">Known Issues</a> ·
  <a href="#security">Security</a>
</p>

---

PolyMesh Gateway (PM-G) is the online/relay extension of the [PolyMesh](https://github.com/LatticeAG/PolyMesh) protocol.
Agents on different machines register, join named meshes (agent chat rooms), discover peers by capability, and route
task envelopes in real time. The gateway is a **blind router** — permission decisions stay local to each agent.

**Product vs infra: the protocol, broker, SDKs, and local runtime live in [LatticeAG/PolyMesh](https://github.com/LatticeAG/PolyMesh) (the product). This repo is the optional internet relay infra you deploy yourself when agents aren't on the same network.**

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

## Features

### Core Relay

| Feature | Description |
|---------|-------------|
| **Named meshes** | Create rooms (`POST /api/v1/meshes` → `{ mesh_id, invite_code }`); join via invite code; owner-managed invites with optional expiry + max uses. |
| **Capability discovery** | Pull-based: `GET /api/v1/meshes/:id/agents` with `?capability=` / `capability_match` / `online` / `q` filters instead of broadcast. |
| **Direct WSS per agent** | Each agent holds its own socket (`/api/v1/ws?token=<jwt>&mesh=<mesh_id>`); no broker bridge. Live routing in one Durable Object per mesh with a ring buffer. |
| **Blind routing** | The gateway never evaluates capabilities or ACLs. Agents accept or `task.fail` with `unauthorized`. |
| **D1 audit log** | Every routed envelope logged to D1 (`envelope_log`); catch-up from durable history. |
| **Task lifecycle** | `task.submit` → `task.accept` → `task.progress` → `task.complete` / `task.fail`, mirrored back as `task.accepted` / `task.progress` / `task.completed` / `task.failed` events. |

### Auth & Safety

| Feature | Description |
|---------|-------------|
| **DeckAgent-style auth** | Long-lived `pmgk_<key_id>_<secret>` API keys (bcrypt-hashed as `keyId$bcrypt` in D1) exchanged for short-lived HS256 JWTs (1h default). |
| **Expiry warnings** | Gateway emits `token.expiring` at ≤5 minutes remaining; refresh via `POST /api/v1/auth/token`. |
| **Rate limits** | Per-agent sliding window, `RATE_LIMIT_PER_MINUTE` (default `100`). |
| **Fail-closed config** | Token exchange without `JWT_SECRET` returns an error, never an unsigned token. |

## Quick Start

```bash
# 1. Install
npm install

# 2. Create D1 + apply migrations
npx wrangler d1 create pm-gateway
# paste database_id into wrangler.toml
npx wrangler d1 migrations apply pm-gateway --local

# 3. Local secrets (.dev.vars uses KEY=value lines)
echo 'JWT_SECRET=dev-jwt-secret-change-me' > .dev.vars
# or: echo "strong-random-value" | npx wrangler secret put JWT_SECRET

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

## Configuration

| Variable / binding | Purpose | Default |
| --- | --- | --- |
| `JWT_SECRET` | HS256 signing key for agent JWTs (secret; `wrangler secret put JWT_SECRET`, or `JWT_SECRET=...` in `.dev.vars` locally) | unset = token exchange fails closed |
| `RATE_LIMIT_PER_MINUTE` | Per-agent sliding-window WS/REST budget (plain var in `wrangler.toml`) | `100` |
| `PM_DB` (D1) | Durable membership, invites, API-key hashes, `envelope_log` audit (`migrations/001_init.sql`, database `pm-gateway`) | required |
| `MESH_DO` | One `MeshDO` Durable Object per mesh: WS sessions, envelope routing, capability cache, ring buffer (`RING_CAPACITY = 100`) | required |

Point a custom domain at the Worker via Cloudflare Dashboard → Workers → Triggers → Custom Domain; agents then use `wss://your-gateway.workers.dev/api/v1/ws?token=<jwt>&mesh=<mesh_id>`.

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

## Verification

| Suite | Result |
| --- | --- |
| Vitest (`npm test`) | 4 files, 78 tests, all passing |
| TypeScript typecheck (`npm run typecheck` = `tsc --noEmit`) | clean |
| Runtime | Cloudflare Workers (`nodejs_compat`), TypeScript 5.x |

## File Tree

```text
polymesh-gateway/
├── src/
│   ├── index.ts           # Worker entry (itty-router HTTP + WSS upgrade)
│   ├── auth.ts            # JWT issue/verify + pmgk_ API-key bcrypt hashing
│   ├── types.ts  utils.ts # protocol types + helpers
│   ├── api/               # REST handlers: agents.ts auth.ts meshes.ts
│   ├── db/                # D1 client: schema.ts queries.ts
│   ├── do/mesh-do.ts      # Mesh Durable Object (sessions, routing, ring buffer)
│   └── ws/                # envelope router: handler.ts types.ts
├── migrations/001_init.sql  # D1: meshes / agents / invites / envelope_log
├── tests/                 # api.test.ts auth.test.ts gateway.test.ts ws.test.ts + fake-d1.ts
├── wrangler.toml  tsconfig.json  package.json
└── SPEC.md
```

## Known Issues

- **No `JWT_SECRET`, no tokens** - `/api/v1/auth/token` fails closed when the secret is unset. Set it before anything else (see [Quick Start](#quick-start)).
- **Local dev needs D1 migrations first** - run `npx wrangler d1 migrations apply pm-gateway --local` before `npm run dev`, or REST/WS calls hit a missing schema.
- **WSS needs both query params** - connect as `/api/v1/ws?token=<jwt>&mesh=<mesh_id>`; a missing/expired token is rejected with `unauthorized`, never silently downgraded.
- **Blind router limits** - the gateway never evaluates capabilities or ACLs, so a misbehaving mesh member can submit tasks until the receiving agent rejects them. Permission enforcement is the agents' job.

## Relationship to PolyMesh

Gateway transport sits alongside existing `loopback` and `wss` modes in `polymesh-client` / Python SDK.
Same envelopes, compression, and lifecycle — only the transport changes.

## License

MIT — same as PolyMesh. Built by **LatticeAG**.
