# PolyMesh Gateway (PM-G) v1.0.0 — Extreme Specification

**Status:** Normative single source of truth  
**Repo:** `LatticeAG/polymesh-gateway`  
**Protocol:** PolyMesh v5 (envelope types compatible with `LatticeAG/PolyMesh`)  
**Gateway version:** `1.0.0`  
**API base path:** `/api/v1`  
**Runtime:** Cloudflare Workers + Durable Objects + D1  
**License:** MIT  

This document is exhaustive. A developer MUST be able to implement the entire gateway from this file alone, without clarifying questions. Where behavior is unspecified elsewhere, **this SPEC wins**.

---

## Table of Contents

1. [Overview & Design Principles](#1-overview--design-principles)
2. [Architecture](#2-architecture)
3. [Conventions & Identifiers](#3-conventions--identifiers)
4. [REST API](#4-rest-api)
5. [WebSocket Protocol](#5-websocket-protocol)
6. [Auth System](#6-auth-system)
7. [Durable Object (MeshDO)](#7-durable-object-meshdo)
8. [D1 Schema](#8-d1-schema)
9. [Agent Cards & Discovery](#9-agent-cards--discovery)
10. [Task Lifecycle](#10-task-lifecycle)
11. [Error Handling](#11-error-handling)
12. [Security](#12-security)
13. [Mesh Model](#13-mesh-model)
14. [Testing Strategy](#14-testing-strategy)
15. [Deployment](#15-deployment)
16. [Scaling](#16-scaling)
17. [File Structure & Module Responsibilities](#17-file-structure--module-responsibilities)
18. [Relationship to PolyMesh v5 SDKs](#18-relationship-to-polymesh-v5-sdks)
19. [Normative Constants](#19-normative-constants)
20. [Appendix: Complete JSON Schemas](#20-appendix-complete-json-schemas)

---

## 1. Overview & Design Principles

### 1.1 Purpose

PolyMesh Gateway is a Cloudflare Workers relay that lets agents on different machines:

1. **Register** and receive long-lived API keys.
2. **Authenticate** by exchanging keys for short-lived JWTs.
3. **Create / join meshes** (named agent rooms) via invite codes.
4. **Discover peers** by capability through pull-based REST queries.
5. **Exchange bounded tasks** over persistent WebSocket connections, using PolyMesh v5 envelope semantics.

### 1.2 Non-Goals (v1)

- Gateway-side ACL / capability authorization (agents enforce locally).
- Guaranteed offline delivery of task payloads (offline targets reject immediately).
- Multi-region active-active mesh state (one DO per mesh is authoritative for live WS).
- End-to-end payload encryption beyond TLS (payloads are opaque JSON to the gateway).
- Billing, multi-tenant org accounts, or admin UI.

### 1.3 Hard Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Permission enforcement | **Local** (each agent) | Gateway is a blind router. Agents accept or `task.fail` with `unauthorized`. |
| Agent connection | Direct WSS to MeshDO | No broker bridge; each agent holds its own socket. |
| Mesh model | Named rooms + invite codes | Friends / personal / dev meshes. |
| Discovery | Pull REST | No broadcast spam; `?capability=` filters. |
| Auth | API key → JWT | DeckAgent pattern; keys hashed in D1; JWT for WS. |
| Persistence | DO memory + async D1 flush | Hot path stays in DO; D1 is membership + audit. |
| Wire format | JSON PolyMesh envelopes | Gateway routes; does not transform payloads. |
| Free tier | Workers + D1 + DO | Small meshes stay within CF free limits. |

### 1.4 Glossary

| Term | Meaning |
|------|---------|
| **Agent** | A registered participant with `agent_id`, API key, and optional card. |
| **Mesh** | A named room of agents. Membership is stored in D1; live sessions in MeshDO. |
| **Card** | Advertised capabilities + metadata for an agent. |
| **Envelope** | A routed message unit (submit / lifecycle / announce / leave). |
| **Task** | A unit of work identified by `task_id`, progressing through a state machine. |
| **MeshDO** | Durable Object instance keyed by `mesh_id`. |
| **Blind router** | Gateway forwards envelopes without evaluating authorization. |

---

## 2. Architecture

### 2.1 Topology

```
┌──────────────────────────────────────────────────────────────────────────┐
│                     Cloudflare Workers Platform                          │
│                                                                          │
│  ┌────────────────────────────────────────────────────────────────────┐  │
│  │ Gateway Worker (src/index.ts)                                      │  │
│  │                                                                    │  │
│  │  HTTP REST  /api/v1/*                                              │  │
│  │    ├─ agents, auth, meshes ──► D1 (PM_DB)                          │  │
│  │    └─ health                                                   │  │
│  │                                                                    │  │
│  │  WSS upgrade /api/v1/ws?token=&mesh=                               │  │
│  │    ├─ verify JWT (Worker)                                          │  │
│  │    └─ stub.fetch() ──────────────► MeshDO (per mesh_id)            │  │
│  └───────────────────────────┬────────────────────────────────────────┘  │
│                              │                                           │
│         ┌────────────────────┼────────────────────┐                      │
│         ▼                    ▼                    ▼                      │
│  ┌─────────────┐      ┌─────────────┐      ┌─────────────┐               │
│  │ MeshDO      │      │ MeshDO      │      │ MeshDO      │  …            │
│  │ idFromName  │      │ "friends"   │      │ "dev"       │               │
│  │ (mesh uuid) │      │             │      │             │               │
│  │             │      │             │      │             │               │
│  │ sessions[]  │      │ sessions[]  │      │ sessions[]  │               │
│  │ cards cache │      │ cards cache │      │ cards cache │               │
│  │ ring buffer │      │ ring buffer │      │ ring buffer │               │
│  │ task routes │      │ task routes │      │ task routes │               │
│  └──────┬──────┘      └──────┬──────┘      └──────┬──────┘               │
│         │                    │                    │                      │
│         └────────────────────┼────────────────────┘                      │
│                              ▼                                           │
│                    ┌──────────────────┐                                  │
│                    │ D1: pm-gateway   │                                  │
│                    │ meshes           │                                  │
│                    │ agents           │                                  │
│                    │ invites          │                                  │
│                    │ envelope_log     │                                  │
│                    └──────────────────┘                                  │
└──────────────────────────────────────────────────────────────────────────┘
```

### 2.2 Component Responsibilities

#### 2.2.1 Gateway Worker

- Terminate TLS / HTTP.
- Route REST endpoints to handlers.
- Validate request bodies at the edge of each handler.
- Issue and verify JWTs using `JWT_SECRET`.
- Hash/verify API keys with bcrypt.
- On `GET/POST` that mutate membership, write D1 first (source of truth for membership).
- On WebSocket upgrade requests to `/api/v1/ws`:
  1. Reject if `Upgrade != websocket` → `426 upgrade_required`.
  2. Extract JWT from `Authorization: Bearer` or `?token=`.
  3. Verify JWT; reject `401` on failure.
  4. Require `mesh` query param; reject if missing or ≠ JWT `mesh` claim → `403 mesh_mismatch`.
  5. Forward the upgrade (with token/mesh headers) to `MESH_DO.idFromName(mesh_id)`.

#### 2.2.2 MeshDO (one per mesh)

- Accept hibernatable WebSockets.
- Maintain `agent_id → WebSocket` session map.
- Cache agent cards in memory + DO storage.
- Route task envelopes between sessions.
- Maintain ring buffer of recent envelopes (capacity 100).
- Maintain in-memory `task_id → submitter_agent_id` routing table.
- Asynchronously flush audit rows and capability updates to D1.
- Schedule alarms for idle cleanup / orphan task detection.

#### 2.2.3 D1 (`PM_DB`)

- Durable store for meshes, agents (incl. API key hashes), invites, envelope audit log.
- Authoritative for membership and discovery REST reads.
- Not on the hot path of WS message forwarding (except best-effort flush).

### 2.3 Data Flow Diagrams (Text)

#### 2.3.1 Agent Registration → Token → Join → WS

```
Agent                    Worker                     D1                      MeshDO
  │                        │                         │                         │
  │ POST /agents           │                         │                         │
  │───────────────────────►│ INSERT mesh? (personal) │                         │
  │                        │ INSERT invite           │                         │
  │                        │ INSERT agent + hash     │                         │
  │◄── {agent_id,api_key} ─│                         │                         │
  │                        │                         │                         │
  │ POST /auth/token       │                         │                         │
  │───────────────────────►│ SELECT by key_id        │                         │
  │                        │ bcrypt verify           │                         │
  │◄── {token,expires_at} ─│ issue JWT               │                         │
  │                        │                         │                         │
  │ POST /meshes/:id/join  │                         │                         │
  │───────────────────────►│ validate invite         │                         │
  │                        │ UPDATE agent.mesh_id    │                         │
  │                        │ INC invite.use_count    │                         │
  │                        │ (optional) notify ──────┼────────────────────────►│
  │◄── {members...} ───────│                         │                         │
  │                        │                         │                         │
  │ WSS /ws?token&mesh     │ verify JWT              │                         │
  │───────────────────────►│ stub.fetch(upgrade) ────┼────────────────────────►│
  │                        │                         │  acceptWebSocket        │
  │◄═══════════════════════╪═════════════════════════╪══ mesh.joined ══════════│
  │                        │                         │                         │
  │ card.announce          │                         │                         │
  │══════════════════════════════════════════════════╪════════════════════════►│
  │◄════════════════ card.registered ════════════════╪═════════════════════════│
  │                        │                         │ UPDATE capabilities     │
```

#### 2.3.2 Task Submit Routing + D1 Flush

```
Agent A (submitter)          MeshDO                     Agent B (target)           D1
      │                         │                              │                     │
      │ task.submit             │                              │                     │
      │ {target:B,task_id,...}  │                              │                     │
      │────────────────────────►│ validate online              │                     │
      │                         │ record task→A                │                     │
      │                         │ push ring buffer             │                     │
      │                         │ forward task.submit ─────────►                     │
      │                         │ async logEnvelope ─────────────────────────────────►│
      │                         │                              │                     │
      │                         │◄──── task.accept ────────────│                     │
      │◄──── task.accepted ─────│                              │                     │
      │                         │ async logEnvelope ─────────────────────────────────►│
      │                         │                              │                     │
      │                         │◄──── task.progress ──────────│                     │
      │◄──── task.progress ─────│                              │                     │
      │                         │                              │                     │
      │                         │◄──── task.complete ──────────│                     │
      │◄──── task.completed ────│ clear task route             │                     │
      │                         │ async logEnvelope ─────────────────────────────────►│
```

#### 2.3.3 Full Request Lifecycle (HTTP → WS → Envelope → Flush)

```
1. Client opens HTTPS to Worker.
2. If REST: Worker handler → parameterized D1 statements → JSON response.
3. If WS:
   a. Worker validates Upgrade + JWT + mesh claim.
   b. Worker obtains DO stub: MESH_DO.get(MESH_DO.idFromName(mesh_id)).
   c. Worker forwards Request; MeshDO calls state.acceptWebSocket(ws).
   d. MeshDO attaches {agentId, meshId, tokenExp, displayName} via serializeAttachment.
   e. MeshDO sends mesh.joined with current member cards.
4. Client sends JSON frames; MeshDO parses → routeWsMessage → reply/forward.
5. For auditable events: MeshDO pushes Envelope to ring buffer, persists recentEnvelopes
   to DO storage, and fire-and-forget INSERT into envelope_log (D1).
6. On close/leave: remove session; optionally update last_seen_at; alarm may prune idle DO state.
```

### 2.4 Binding & Environment

| Binding / Secret | Type | Purpose |
|------------------|------|---------|
| `PM_DB` | D1Database | Persistent relational store |
| `MESH_DO` | DurableObjectNamespace | Per-mesh DO class `MeshDO` |
| `JWT_SECRET` | Secret string | HS256 signing key (≥ 32 bytes entropy recommended) |
| `RATE_LIMIT_PER_MINUTE` | Var string | Default `"100"` — per-agent REST/WS action limit |

### 2.5 Health Endpoints

| Method | Path | Response |
|--------|------|----------|
| `GET` | `/` | `{ service, version, protocol, ok: true }` |
| `GET` | `/health` | same |
| `GET` | `/api/v1/health` | same |

No auth required. Always `200` if Worker is reachable.

---

## 3. Conventions & Identifiers

### 3.1 ID Formats

| Entity | Format | Example | Notes |
|--------|--------|---------|-------|
| `mesh_id` | UUID v4 | `550e8400-e29b-41d4-a716-446655440000` | From `crypto.randomUUID()` |
| `agent_id` | `{slug}@latticeag` | `alice@latticeag` | Collision → `{slug}-{8hex}@latticeag` |
| `task_id` | Client-chosen string | UUID recommended | Max 128 chars; unique per mesh while active |
| `invite_code` | `{PREFIX}-{6chars}` | `FRIENDS-ABC123` | Alphabet excludes `I,O,0,1` |
| API key | `pmgk_{keyId}_{secret}` | see Auth | Shown once at registration |

### 3.2 Timestamps

- All API timestamps: **ISO 8601 UTC** with `Z` (e.g. `2026-07-25T03:36:00.000Z`).
- D1 defaults may use SQLite `datetime('now')` (UTC, space-separated). Readers MUST treat both as UTC.
- JWT `exp` / `iat`: Unix seconds (integer).

### 3.3 Content Types

- REST request/response: `application/json; charset=utf-8`
- WebSocket frames: **text** UTF-8 JSON only (binary frames → close `1003`)
- Max JSON body size (REST): **256 KiB**
- Max WS message size: **256 KiB** (reject with `error` code `payload_too_large`)

### 3.4 CORS

Gateway MUST include:

```
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET, POST, OPTIONS
Access-Control-Allow-Headers: Content-Type, Authorization
Access-Control-Max-Age: 86400
```

`OPTIONS` → `204` with CORS headers.

### 3.5 Versioning

- URL prefix `/api/v1` is frozen for v1.
- Breaking changes require `/api/v2`.
- Health payload `version` is gateway semver; `protocol` is `polymesh-v5`.

---

## 4. REST API

All REST endpoints are under `/api/v1`.  
Unless noted, endpoints are **unauthenticated** at the HTTP layer for v1 registration/bootstrap; sensitive actions still require knowledge of API keys / invite codes. Future versions MAY require Bearer JWT on mutating mesh endpoints.

### 4.1 Common Error Envelope

Every non-2xx JSON error MUST match:

```json
{
  "error": {
    "code": "string",
    "message": "string"
  }
}
```

JSON Schema: see §20.1 `ApiErrorBody`.

### 4.2 POST `/api/v1/agents`

Register a new agent. If `mesh_id` omitted, create a private personal mesh + invite, then attach the agent.

#### Request

**Headers:** `Content-Type: application/json`  
**Body JSON Schema:** `CreateAgentRequest` (§20.2)

```json
{
  "display_name": "Alice",
  "mesh_id": "optional-existing-mesh-uuid"
}
```

| Field | Type | Required | Constraints |
|-------|------|----------|-------------|
| `display_name` | string | yes | trimmed length 1–128 |
| `mesh_id` | string (uuid) | no | must exist if provided |

#### Behavior

1. Validate body; reject `400 bad_request` if invalid.
2. Generate `agent_id = makeAgentId(display_name)`; if exists, append `-{8hex}`.
3. Generate API key via `generateApiKey()` → `pmgk_{keyId}_{secret}`.
4. `bcrypt.hash(apiKey, cost=10)`; store `api_key_hash = "{keyId}${bcryptHash}"`.
5. If `mesh_id` provided: `SELECT` mesh; `404 not_found` if missing. Agent joins that mesh **without** invite check (caller must already know mesh_id — intended for owner bootstrapping). Prefer join-via-invite for third parties.
6. Else create personal mesh:
   - `mesh_id = uuid`
   - `name = personal-{slug}` (unique suffix if collision)
   - `owner_agent_id = agent_id`
   - `is_public = 0`
   - invite `PERSONAL-XXXXXX`
7. `INSERT` agent row.
8. Return `201` with plaintext API key **once**.

#### Response `201`

JSON Schema: `CreateAgentResponse` (§20.3)

```json
{
  "agent_id": "alice@latticeag",
  "api_key": "pmgk_Ab12Cd34E_xY9...secret",
  "mesh_id": "550e8400-e29b-41d4-a716-446655440000"
}
```

#### Status Codes

| Status | Code | When |
|--------|------|------|
| 201 | — | Created |
| 400 | `bad_request` | Missing/invalid fields |
| 404 | `not_found` | `mesh_id` does not exist |
| 409 | `conflict` | Unrecoverable ID collision (should be rare) |
| 500 | `internal_error` | D1 failure |

---

### 4.3 GET `/api/v1/agents/:id/card`

Fetch an agent's public card.

#### Path Params

| Param | Type | Notes |
|-------|------|-------|
| `id` | string | URL-encoded `agent_id` (e.g. `alice%40latticeag`) |

#### Response `200`

JSON Schema: `AgentCard` (§20.4)

```json
{
  "id": "alice@latticeag",
  "display_name": "Alice",
  "capabilities": [
    {
      "name": "calendar.check",
      "schema": { "input": {}, "output": {} },
      "scope": "mesh",
      "security": "none"
    }
  ],
  "last_seen": "2026-07-25T03:00:00.000Z",
  "mesh_id": "550e8400-..."
}
```

#### Status Codes

| Status | Code | When |
|--------|------|------|
| 200 | — | Found |
| 404 | `not_found` | Agent missing |

---

### 4.4 POST `/api/v1/auth/token`

Exchange API key for JWT.

#### Request

JSON Schema: `TokenRequest` (§20.5)

```json
{ "api_key": "pmgk_Ab12Cd34E_xY9secret..." }
```

#### Behavior

1. Parse key → `{keyId, secret}`; malformed → `401 invalid_api_key`.
2. `SELECT agent WHERE api_key_hash LIKE '{keyId}$%'`.
3. bcrypt compare full `api_key` against stored hash.
4. On success, issue JWT: `{ sub: agent_id, mesh: agent.mesh_id, iat, exp=iat+3600 }`.
5. Update `last_seen_at` (best-effort).
6. Apply per-agent rate limit; exceed → `429 rate_limited`.

#### Response `200`

JSON Schema: `TokenResponse` (§20.6)

```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "expires_at": "2026-07-25T04:36:00.000Z"
}
```

#### Status Codes

| Status | Code | When |
|--------|------|------|
| 200 | — | Issued |
| 400 | `bad_request` | Missing body / api_key |
| 401 | `invalid_api_key` | Unknown key or bad secret |
| 429 | `rate_limited` | Too many attempts |
| 500 | `internal_error` | Signing / DB failure |

---

### 4.5 POST `/api/v1/meshes`

Create a mesh. Caller must already be a registered agent.

#### Request

JSON Schema: `CreateMeshRequest` (§20.7)

```json
{
  "name": "friends",
  "agent_id": "alice@latticeag",
  "is_public": false
}
```

| Field | Type | Required | Constraints |
|-------|------|----------|-------------|
| `name` | string | yes | trimmed 1–64; unique globally |
| `agent_id` | string | yes | must exist |
| `is_public` | boolean | no | default `false` |

#### Behavior

1. Validate; `404` if agent missing; `409 conflict` if name taken.
2. Create mesh row; generate invite `{NAMEPREFIX}-{6}`; `max_uses=0` (unlimited); `expires_at=null`.
3. Move creator: `UPDATE agents SET mesh_id = new_mesh`.
4. Best-effort notify MeshDO `/internal/member-joined`.
5. Return `201`.

#### Response `201`

JSON Schema: `CreateMeshResponse` (§20.8)

```json
{
  "mesh_id": "550e8400-e29b-41d4-a716-446655440000",
  "invite_code": "FRIENDS-K7M2PQ"
}
```

#### Status Codes

| Status | Code | When |
|--------|------|------|
| 201 | — | Created |
| 400 | `bad_request` | Invalid name/agent_id |
| 404 | `not_found` | Agent missing |
| 409 | `conflict` | Name taken |

---

### 4.6 GET `/api/v1/meshes/:id/agents`

List agents in a mesh with optional capability filter and online hint.

#### Path Params

| Param | Meaning |
|-------|---------|
| `id` | `mesh_id` |

#### Query Params

| Param | Type | Description |
|-------|------|-------------|
| `capability` | string | Exact capability name match (see §9 for wildcards) |
| `capability_match` | enum | `exact` (default) \| `prefix` \| `wildcard` |
| `online` | `true`/`false` | If `true`, only agents with active MeshDO session (requires DO status query; best-effort — if DO cold, treat all offline) |
| `q` | string | Case-insensitive substring on `display_name` or `id` |

#### Behavior

1. `404` if mesh missing.
2. Load agents from D1 for `mesh_id`.
3. Parse `capabilities` JSON; filter per §9.4.
4. Optionally merge online set from MeshDO `/internal/status`.
5. Sort: online first, then `display_name` ASC.

#### Response `200`

JSON Schema: `ListAgentsResponse` (§20.9)

```json
{
  "agents": [
    {
      "id": "bob@latticeag",
      "display_name": "Bob",
      "capabilities": [{ "name": "calendar.check" }],
      "last_seen": "2026-07-25T03:10:00.000Z",
      "mesh_id": "550e8400-...",
      "online": true
    }
  ]
}
```

Note: `online` is optional extension field on list responses; omit if unknown.

#### Status Codes

| Status | Code | When |
|--------|------|------|
| 200 | — | OK (possibly empty list) |
| 404 | `not_found` | Mesh missing |

---

### 4.7 POST `/api/v1/meshes/:id/join`

Join a mesh using an invite code.

#### Request

JSON Schema: `JoinMeshRequest` (§20.10)

```json
{
  "agent_id": "bob@latticeag",
  "invite_code": "FRIENDS-K7M2PQ"
}
```

#### Behavior

1. Validate mesh exists; agent exists.
2. Load invite by code:
   - missing → `403 invalid_invite`
   - `invite.mesh_id != :id` → `403 invalid_invite`
   - `expires_at < now` → `403 invite_expired`
   - `max_uses > 0 && use_count >= max_uses` → `403 invite_exhausted`
3. If agent already on this mesh: still increment use_count **once per call** in v1 (clients SHOULD avoid duplicate joins); membership update is idempotent.
4. Else `UPDATE agents.mesh_id`.
5. `UPDATE invites.use_count = use_count + 1`.
6. `updateLastSeen`.
7. Best-effort MeshDO notify.
8. Return member list.

**Public meshes:** Still require a valid invite in v1 request body. Owners create invites via create-mesh or `/invite`. (A future revision may allow `invite_code` omit when `is_public=1`.)

#### Response `200`

JSON Schema: `JoinMeshResponse` (§20.11)

```json
{
  "mesh_id": "550e8400-...",
  "agent_id": "bob@latticeag",
  "members": [ /* AgentCard[] */ ]
}
```

#### Status Codes

| Status | Code | When |
|--------|------|------|
| 200 | — | Joined |
| 400 | `bad_request` | Missing fields |
| 403 | `invalid_invite` / `invite_expired` / `invite_exhausted` | Invite problems |
| 404 | `not_found` | Mesh or agent missing |

---

### 4.8 POST `/api/v1/meshes/:id/invite`

Create a new invite code for an existing mesh.

#### Request

JSON Schema: `CreateInviteRequest` (§20.12)

```json
{
  "agent_id": "alice@latticeag",
  "max_uses": 10,
  "expires_in_seconds": 86400,
  "prefix": "FRIENDS"
}
```

| Field | Type | Required | Constraints |
|-------|------|----------|-------------|
| `agent_id` | string | yes | Must be mesh **owner** (`meshes.owner_agent_id`) or current member (v1: **owner only**) |
| `max_uses` | integer | no | `0` = unlimited; max `100000` |
| `expires_in_seconds` | integer | no | If set, `60..2592000` (30d); null expiry if omitted |
| `prefix` | string | no | `1..12` `[A-Za-z0-9]`; default from mesh name |

#### Auth (v1)

Require either:

- Header `Authorization: Bearer <jwt>` where `sub == agent_id` and `mesh == :id`, **or**
- Body includes `api_key` matching `agent_id` (optional alternate for scripts).

If neither proves identity of `agent_id` → `401 unauthorized`.  
If agent is not owner → `403 forbidden`.

#### Behavior

1. Validate mesh; verify caller is owner.
2. Generate invite code with ≥ 6 chars from 32-symbol alphabet (~30 bits); with prefix uniqueness enforced by PK.
3. Insert invite row.
4. Return code + metadata.

#### Response `201`

JSON Schema: `CreateInviteResponse` (§20.13)

```json
{
  "mesh_id": "550e8400-...",
  "invite_code": "FRIENDS-K7M2PQ",
  "max_uses": 10,
  "use_count": 0,
  "expires_at": "2026-07-26T03:36:00.000Z",
  "created_at": "2026-07-25T03:36:00.000Z"
}
```

#### Status Codes

| Status | Code | When |
|--------|------|------|
| 201 | — | Created |
| 400 | `bad_request` | Invalid fields |
| 401 | `unauthorized` | Auth missing/invalid |
| 403 | `forbidden` | Not owner |
| 404 | `not_found` | Mesh missing |
| 409 | `conflict` | Code collision after retries exhausted |

---

### 4.9 Additional REST (Normative Helpers)

#### 4.9.1 DELETE `/api/v1/meshes/:id/members/:agent_id` — Leave (HTTP)

Optional HTTP leave (WS `mesh.leave` is preferred for connected agents).

**Auth:** Bearer JWT `sub` must equal `:agent_id`, or owner removing a member.

**Behavior:** Set agent back to a personal mesh (create if needed) OR mark `mesh_id` as personal; remove from MeshDO members; do **not** delete agent row.

**Response `204`** empty.

#### 4.9.2 DELETE `/api/v1/meshes/:id` — Delete Mesh

**Auth:** Bearer JWT; `sub` must be `owner_agent_id`.

**Cascade rules:** see §13.5.

**Response `204`**.

---

## 5. WebSocket Protocol

### 5.1 Connection URL

```
WSS /api/v1/ws?token=<jwt>&mesh=<mesh_id>
```

Also accepted by MeshDO (after Worker proxy):

- Header `X-PM-Token: <jwt>`
- Header `X-PM-Mesh: <mesh_id>`
- Header `Authorization: Bearer <jwt>` (Worker extracts before proxy)

### 5.2 Connection Lifecycle

```
┌─────────┐    Upgrade+JWT OK     ┌──────────┐
│ CONNECT │ ─────────────────────►│ OPEN     │
└─────────┘                       └────┬─────┘
                                       │ MeshDO accepts WS
                                       ▼
                                  ┌──────────┐
                                  │ AUTHED   │  (JWT already verified)
                                  └────┬─────┘
                                       │ send mesh.joined
                                       ▼
                                  ┌──────────┐
                                  │ READY    │◄──── card.announce optional
                                  └────┬─────┘
                                       │ bidirectional envelopes
                                       ▼
                    ┌──────────────────┴──────────────────┐
                    ▼                                     ▼
              ┌──────────┐                          ┌──────────┐
              │ LEAVING  │ mesh.leave / client close │ REAUTH   │ token.expiring
              └────┬─────┘                          └────┬─────┘
                   │ close 1000                          │ client refreshes JWT
                   ▼                                     │ opens new WS; old closed
              ┌──────────┐                               │
              │ CLOSED   │◄──────────────────────────────┘
              └──────────┘
```

#### States (normative)

| State | Meaning | Allowed inbound |
|-------|---------|-----------------|
| `CONNECT` | HTTP upgrade in flight | — |
| `AUTHED` | Socket accepted; attachment written | none until `mesh.joined` sent |
| `READY` | Client may send protocol messages | all inbound types |
| `LEAVING` | Leave in progress | ignore further |
| `CLOSED` | Done | — |

Gateway MUST send `mesh.joined` before processing application messages. Messages received before `mesh.joined` MAY be queued briefly (≤ 1s) or rejected with `not_ready`.

### 5.3 Heartbeat

Cloudflare hibernation provides ping/pong. Additionally:

| Direction | Mechanism | Interval | Timeout |
|-----------|-----------|----------|---------|
| Gateway → Agent | WS protocol ping (platform) | platform default | — |
| Agent → Gateway | Optional app-level `{ "type": "ping" }` | ≤ 30s recommended | — |
| Gateway → Agent | `{ "type": "pong", "ts": ISO }` | reply to ping | — |

If no frames (including pong) for **120 seconds**, MeshDO MAY close with `1001 going_away` after alarm check.

**v1 minimum:** Rely on CF hibernation + close detection. App-level `ping`/`pong` is RECOMMENDED for clients behind aggressive NATs.

JSON Schema for ping/pong: §20.14.

### 5.4 Token Expiry Warning

When `tokenExp - now <= 300` seconds and not yet warned for this attachment:

```json
{
  "type": "token.expiring",
  "expires_at": "2026-07-25T04:36:00.000Z",
  "seconds_remaining": 280
}
```

Client MUST call `POST /auth/token` and reconnect with new JWT before hard expiry. On expiry, MeshDO closes with code `4001` reason `token_expired`.

### 5.5 Reconnect Flow

1. Client detects close / network loss.
2. Exponential backoff: `250ms, 500ms, 1s, 2s, 5s, 10s` (cap 10s); jitter ±20%.
3. Refresh JWT if `expires_at - now < 120s`.
4. Open new WSS with same `mesh_id`.
5. On `mesh.joined`, client MAY re-`card.announce`.
6. In-flight tasks: client is responsible for idempotency; gateway does **not** replay full payloads from ring buffer automatically in v1 (ring buffer is for DO-internal catch-up / debugging / future resume).
7. Duplicate session: if same `agent_id` connects again, MeshDO MUST close the previous socket with `4000 replaced` and keep the newest.

### 5.6 Inbound Messages (Agent → Gateway)

All messages share envelope:

```json
{ "type": "<message_type>", ...fields }
```

#### 5.6.1 `card.announce`

Announce/replace capabilities.

```json
{
  "type": "card.announce",
  "capabilities": [
    {
      "name": "calendar.check",
      "schema": {
        "input": { "type": "object", "properties": { "date": { "type": "string" } } },
        "output": { "type": "object", "properties": { "free": { "type": "boolean" } } }
      },
      "scope": "mesh",
      "security": "none"
    }
  ]
}
```

**Effects:** Update DO card cache + D1 `agents.capabilities`; reply `card.registered`; audit `announce`.

#### 5.6.2 `task.submit`

```json
{
  "type": "task.submit",
  "target": "bob@latticeag",
  "capability": "calendar.check",
  "payload": { "date": "2026-07-25" },
  "task_id": "t-uuid-1"
}
```

**Validation:**

- `target` ≠ self → else `invalid_target`
- target online → else `target_offline`
- `task_id` length 1–128
- If `task_id` already mapped and not terminal → `duplicate_task_id`
- Rate limit per agent

**Forward to target:**

```json
{
  "type": "task.submit",
  "from": "alice@latticeag",
  "capability": "calendar.check",
  "payload": { "date": "2026-07-25" },
  "task_id": "t-uuid-1"
}
```

#### 5.6.3 `task.accept`

```json
{ "type": "task.accept", "task_id": "t-uuid-1" }
```

Forward to submitter as `task.accepted`.

#### 5.6.4 `task.progress`

```json
{
  "type": "task.progress",
  "task_id": "t-uuid-1",
  "progress": 0.5,
  "message": "halfway"
}
```

`progress` MUST be finite number in `[0, 1]`. Out of range → `invalid_message`.

Forward as `task.progress` to submitter.

#### 5.6.5 `task.complete`

```json
{
  "type": "task.complete",
  "task_id": "t-uuid-1",
  "result": { "free": true }
}
```

Forward as `task.completed`; clear task route; audit `completed`.

#### 5.6.6 `task.fail`

```json
{
  "type": "task.fail",
  "task_id": "t-uuid-1",
  "error": "unauthorized"
}
```

Forward as `task.failed`; clear task route; audit `failed`.

#### 5.6.7 `mesh.leave`

```json
{ "type": "mesh.leave" }
```

Remove session; audit `leave`; close socket `1000`. Does **not** by itself remove D1 membership (use HTTP leave / re-join elsewhere). Spec clarification: **WS leave = disconnect from live mesh routing**; membership remains until HTTP leave or join another mesh.

### 5.7 Outbound Messages (Gateway → Agent)

| Type | When |
|------|------|
| `mesh.joined` | After accept |
| `card.registered` | After announce |
| `task.submit` | Inbound task |
| `task.accepted` | Peer accepted |
| `task.progress` | Peer progress |
| `task.completed` | Peer completed |
| `task.failed` | Peer failed |
| `token.expiring` | JWT near expiry |
| `error` | Protocol/routing error |
| `pong` | Reply to ping (optional) |

#### 5.7.1 `mesh.joined`

```json
{
  "type": "mesh.joined",
  "mesh_id": "550e8400-...",
  "members": [ /* AgentCard[] */ ]
}
```

#### 5.7.2 `error`

```json
{
  "type": "error",
  "code": "target_offline",
  "message": "Target agent is not connected: bob@latticeag"
}
```

Errors are **non-fatal** unless accompanied by close. Connection stays open.

### 5.8 Close Codes

| Code | Reason string | Meaning |
|------|---------------|---------|
| 1000 | `normal` / `leave` | Clean close |
| 1001 | `going_away` | Idle timeout / DO shutdown |
| 1003 | `unsupported_data` | Binary frame |
| 1011 | `missing_attachment` | Hibernation restore failure |
| 4000 | `replaced` | New session for same agent |
| 4001 | `token_expired` | JWT expired |
| 4002 | `unauthorized` | Auth failed post-accept (rare) |
| 4003 | `not_a_member` | Agent not in mesh per D1 |
| 4008 | `policy_violation` | Rate limit / size abuse |

### 5.9 Error Recovery Strategies

| Failure | Strategy |
|---------|----------|
| Invalid JSON | Send `error invalid_json`; keep connection |
| Unknown type | `error unknown_type`; keep connection |
| Target offline | `error target_offline`; client may retry later |
| Network drop | Client reconnect flow §5.5 |
| DO eviction | Hibernation restores sockets; if not, clients reconnect |
| D1 flush fail | Log; routing continues (degraded audit) |
| Duplicate task_id | Reject new submit; original mapping kept |

---

## 6. Auth System

### 6.1 API Key Format

```
pmgk_<key_id>_<secret>
```

| Part | Entropy | Encoding |
|------|---------|----------|
| prefix | literal `pmgk` | — |
| `key_id` | 9 random bytes → base62 (~64 bits) | `[0-9A-Za-z]+` |
| `secret` | 24 random bytes → base62 (~178 bits) | `[0-9A-Za-z]+` |

**Parsing rules:**

- Split on `_` → exactly 3 parts.
- `parts[0] === "pmgk"`.
- Reject otherwise → `invalid_api_key`.

**Storage format in D1 `agents.api_key_hash`:**

```
{keyId}${bcryptHash}
```

Example: `Ab12Cd34E$2a$10$...`

Lookup: `WHERE api_key_hash LIKE '{keyId}$%' LIMIT 1` then bcrypt compare.

### 6.2 bcrypt

| Parameter | Value |
|-----------|-------|
| Library | `bcryptjs` (Workers-compatible) |
| Cost | **10** |
| Input | Full API key string including prefix |

Rotation of cost: new hashes use current cost; verify accepts existing `$2a$`/`$2b$`.

### 6.3 JWT

| Claim | Type | Required | Description |
|-------|------|----------|-------------|
| `sub` | string | yes | `agent_id` |
| `mesh` | string | yes | current `mesh_id` |
| `iat` | number | yes | issued-at unix sec |
| `exp` | number | yes | expiry unix sec |

| Parameter | Value |
|-----------|-------|
| Alg | `HS256` |
| Header | `{ "alg": "HS256", "typ": "JWT" }` |
| TTL | **3600 seconds** (1 hour) |
| Secret | `JWT_SECRET` Worker secret |

**Issuance:** `jose.SignJWT({ mesh }).setSubject(sub).setIssuedAt(iat).setExpirationTime(exp)`.

**Verification:** `jwtVerify` with `algorithms: ["HS256"]`; require `sub` and `mesh` strings.

### 6.4 Token Refresh Flow

```
1. Client holds JWT with exp.
2. At ≤300s remaining, MeshDO sends token.expiring.
3. Client POST /auth/token with api_key (still valid).
4. Client opens new WSS with new token (or reconnects).
5. Old connection closes on exp or when replaced.
```

There is **no refresh_token** grant in v1. API key is the long-lived credential.

### 6.5 Key Rotation

1. `POST /api/v1/agents/:id/rotate-key` (normative for v1.1; if unimplemented, document as planned):
   - Auth with current API key or JWT.
   - Generate new key; rehash; invalidate old immediately.
   - Return new key once.
2. Until rotate endpoint ships, rotation = delete/recreate agent (destructive) — **not recommended**. Implementers SHOULD add rotate-key before production.

**Interim v1 procedure:** Owner creates new agent identity; leave old; update clients. Spec marks rotate as **SHOULD**.

### 6.6 Rate Limiting

| Scope | Default | Key | Enforcement point |
|-------|---------|-----|-------------------|
| Per-agent | 100 / minute | `agent_id` or `key_id` | Worker REST + MeshDO messages |
| Per-mesh | 2000 / minute | `mesh_id` | MeshDO |
| Global (isolate) | 10000 / minute | constant | Worker |

Implementation: sliding window in-memory `Map<string, timestamps[]>` per isolate (best-effort; not globally exact). Exceed → HTTP `429` or WS `error rate_limited` / close `4008` on repeated abuse.

Env: `RATE_LIMIT_PER_MINUTE` overrides per-agent default.

Auth token endpoint SHOULD use stricter limit: **20 / minute / key_id** to slow brute force.

---

## 7. Durable Object (MeshDO)

### 7.1 Class Identity

```toml
[[durable_objects.bindings]]
name = "MESH_DO"
class_name = "MeshDO"

[[migrations]]
tag = "v1"
new_classes = ["MeshDO"]
```

**Stub resolution:** `env.MESH_DO.get(env.MESH_DO.idFromName(meshId))`.

### 7.2 Constructor

```
constructor(state: DurableObjectState, env: Env)
```

MUST:

1. Store `state`, `env`.
2. `blockConcurrencyWhile`:
   - `restoreFromHibernation()` — rebuild `sessions` from `state.getWebSockets()` + attachments.
   - `loadPersistedState()` — load `meshId`, `agentCards`, `members`, `recentEnvelopes` from `state.storage`.

### 7.3 In-Memory State

| Structure | Type | Limits |
|-----------|------|--------|
| `sessions` | `Map<agent_id, WebSocket>` | Soft max **200** concurrent per mesh (reject with `503 mesh_full`) |
| `agentCards` | `Map<agent_id, AgentCard>` | Evict LRU offline cards when map > **500** entries |
| `members` | `Set<agent_id>` | Mirrors known membership |
| `recentEnvelopes` | RingBuffer capacity **100** | Drop oldest |
| `tasks` | `Map<task_id, {submitter, target, createdAt, state}>` | Max **1000** active; LRU/orphan cleanup |
| `meshId` | string \| null | Set on first upgrade |
| `hydrated` | boolean | After storage load |

#### 7.3.1 LRU Card Cache

When inserting a card would exceed 500:

1. Prefer evicting agents **not** in `sessions` and not in recent task routes.
2. Evict least-recently-`last_seen`.
3. Never evict currently connected agents.

### 7.4 Durable Object Storage Keys

| Key | Value |
|-----|-------|
| `meshId` | string |
| `agentCards` | `AgentCard[]` |
| `members` | `string[]` |
| `recentEnvelopes` | `Envelope[]` (≤100) |

`persistMeta()` writes the above via `storage.put({...})`.

### 7.5 WebSocket Upgrade Handler

Path: any upgrade to MeshDO (Worker proxies `/api/v1/ws`).

Steps:

1. Extract token + mesh.
2. `verifyJwt`.
3. Ensure `claims.mesh === meshId`.
4. Load agent from D1; if missing → `404`/`4003`; if `agent.mesh_id !== meshId` → `403 not_a_member` / close `4003`.
5. If existing session for agent → close old `4000 replaced`.
6. `WebSocketPair`; `state.acceptWebSocket(client)`.
7. `serializeAttachment({ v:1, agentId, meshId, tokenExp, displayName, warnedExpiring:false })`.
8. Add to `sessions` / `members` / `agentCards`.
9. `updateLastSeen` best-effort.
10. Send `mesh.joined`.
11. If token expiring soon → send `token.expiring`.

### 7.6 Message Routing

`webSocketMessage(ws, message)`:

1. Read attachment; if missing → close `1011`.
2. Check token not expired; else close `4001`.
3. Possibly emit `token.expiring`.
4. Reject binary / oversized.
5. `parseInboundMessage` → maybe `error` reply.
6. `routeWsMessage` with task table deps.
7. Apply `cardUpdate`, `envelope` push, D1 `logEnvelope` async.
8. Send `reply` to origin; `forward` to targets if online.
9. Apply `close` if leave.

Lifecycle forwards use `tasks.get(task_id).submitter` as destination. If missing → `error unknown_task` to sender.

### 7.7 Disconnect Handling

`webSocketClose` / `webSocketError`:

1. Resolve `agentId` from attachment.
2. Remove from `sessions`.
3. Best-effort `updateLastSeen`.
4. Do **not** remove from `members` / D1 on mere disconnect.
5. Leave in-flight tasks mapped; orphan detector handles timeouts.

### 7.8 Internal HTTP RPCs

| Path | Method | Purpose |
|------|--------|---------|
| `/internal/member-joined` | POST | `{agent_id, mesh_id}` → add member + load card |
| `/internal/status` | GET | `{mesh_id, sessions[], members[], recent}` |
| `/internal/recent` | GET | `{envelopes: Envelope[]}` |
| `/internal/member-left` | POST | Remove from members set (HTTP leave) |

These MUST NOT be exposed on the public Worker router.

### 7.9 Alarm Scheduling

| Alarm purpose | Schedule | Action |
|---------------|----------|--------|
| Idle cleanup | 10 minutes after last session close when `sessions.size==0` | Persist meta; optionally clear `tasks`; keep storage for warm restart |
| Orphan tasks | Every 60s while tasks non-empty | Fail tasks older than **task_timeout_sec** (default 300) → send `task.failed` `{error:"timeout"}` to submitter if online; clear map |
| Token sweep | Every 60s | Close sockets with expired attachments |

`state.storage.setAlarm(nextTime)` — single alarm; handler reschedules as needed.

### 7.10 Hibernation

Use `acceptWebSocket` + `webSocketMessage` / `webSocketClose` so idle meshes do not burn DO duration continuously. Attachments MUST restore identity across hibernation wakes.

---

## 8. D1 Schema

### 8.1 Migration Strategy

- Directory: `migrations/`
- Initial: `001_init.sql`
- Apply: `npx wrangler d1 migrations apply pm-gateway [--local]`
- Forward-only; never edit applied migrations. Add `002_*.sql` for changes.
- Each migration MUST be idempotent where possible (`IF NOT EXISTS`).

### 8.2 Tables

#### 8.2.1 `meshes`

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PRIMARY KEY | UUID |
| `name` | TEXT | NOT NULL UNIQUE | Human name |
| `owner_agent_id` | TEXT | NOT NULL | Creator agent_id (may pre-exist agent row for personal mesh chicken-egg — insert mesh first with intended id) |
| `created_at` | TEXT | NOT NULL DEFAULT `datetime('now')` | |
| `is_public` | INTEGER | NOT NULL DEFAULT 0 | 0 private, 1 public |

Indexes: PRIMARY on `id`; UNIQUE on `name`.

#### 8.2.2 `agents`

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PRIMARY KEY | agent_id |
| `mesh_id` | TEXT | NOT NULL, FK → meshes(id) | Current mesh |
| `display_name` | TEXT | NOT NULL | |
| `api_key_hash` | TEXT | NOT NULL | `keyId$bcrypt` |
| `capabilities` | TEXT | NOT NULL DEFAULT `'[]'` | JSON array |
| `created_at` | TEXT | NOT NULL DEFAULT `datetime('now')` | |
| `last_seen_at` | TEXT | NULL | ISO or sqlite datetime |

Indexes:

- `idx_agents_mesh ON agents(mesh_id)`
- Recommended: `idx_agents_keyid` — not required if LIKE on prefix acceptable for v1 scale

FK: `FOREIGN KEY (mesh_id) REFERENCES meshes(id)`  
Note: SQLite/D1 may not enforce FK unless `PRAGMA foreign_keys=ON`; application MUST enforce.

#### 8.2.3 `invites`

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `code` | TEXT | PRIMARY KEY | Invite code |
| `mesh_id` | TEXT | NOT NULL FK | |
| `max_uses` | INTEGER | DEFAULT 0 | 0=unlimited |
| `use_count` | INTEGER | DEFAULT 0 | |
| `created_at` | TEXT | NOT NULL DEFAULT `datetime('now')` | |
| `expires_at` | TEXT | NULL | ISO expiry |

Index recommended: `idx_invites_mesh ON invites(mesh_id)`.

#### 8.2.4 `envelope_log`

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | INTEGER | PK AUTOINCREMENT | |
| `mesh_id` | TEXT | NOT NULL | |
| `from_agent` | TEXT | NOT NULL | |
| `to_agent` | TEXT | NULL | |
| `capability` | TEXT | NOT NULL | May be `""` for leave/announce |
| `task_id` | TEXT | NULL | |
| `type` | TEXT | NOT NULL | see enum |
| `payload_size` | INTEGER | NULL | bytes of JSON payload if any |
| `created_at` | TEXT | NOT NULL DEFAULT `datetime('now')` | |

Indexes:

- `idx_envelope_mesh ON envelope_log(mesh_id)`
- `idx_envelope_task ON envelope_log(task_id)`

**Type enum:** `submit` \| `accepted` \| `progress` \| `completed` \| `failed` \| `leave` \| `announce`

### 8.3 Canonical SQL (`001_init.sql`)

```sql
CREATE TABLE IF NOT EXISTS meshes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  owner_agent_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  is_public INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  mesh_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  api_key_hash TEXT NOT NULL,
  capabilities TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT,
  FOREIGN KEY (mesh_id) REFERENCES meshes(id)
);

CREATE TABLE IF NOT EXISTS invites (
  code TEXT PRIMARY KEY,
  mesh_id TEXT NOT NULL,
  max_uses INTEGER DEFAULT 0,
  use_count INTEGER DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT,
  FOREIGN KEY (mesh_id) REFERENCES meshes(id)
);

CREATE TABLE IF NOT EXISTS envelope_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mesh_id TEXT NOT NULL,
  from_agent TEXT NOT NULL,
  to_agent TEXT,
  capability TEXT NOT NULL,
  task_id TEXT,
  type TEXT NOT NULL,
  payload_size INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_agents_mesh ON agents(mesh_id);
CREATE INDEX IF NOT EXISTS idx_envelope_mesh ON envelope_log(mesh_id);
CREATE INDEX IF NOT EXISTS idx_envelope_task ON envelope_log(task_id);
```

### 8.4 Query Patterns by Endpoint

| Endpoint | Queries |
|----------|---------|
| `POST /agents` | `getMesh`?; `getMeshByName` loop; `INSERT meshes`; `INSERT invites`; `agentIdExists`; `INSERT agents` |
| `GET /agents/:id/card` | `SELECT * FROM agents WHERE id=?` |
| `POST /auth/token` | `SELECT * FROM agents WHERE api_key_hash LIKE ?`; `UPDATE last_seen` |
| `POST /meshes` | `getAgent`; `getMeshByName`; `INSERT meshes`; `INSERT invites`; `UPDATE agents.mesh_id` |
| `GET /meshes/:id/agents` | `getMesh`; `SELECT * FROM agents WHERE mesh_id=? ORDER BY display_name` |
| `POST /meshes/:id/join` | `getMesh`; `getAgent`; `getInvite`; `UPDATE agents`; `UPDATE invites use_count`; `listAgents` |
| `POST /meshes/:id/invite` | `getMesh`; auth agent; `INSERT invites` |
| DO flush | `INSERT envelope_log ...`; `UPDATE agents SET capabilities`; `UPDATE last_seen` |

**All queries MUST use bound parameters** (`?` placeholders). Never string-concatenate user input into SQL.

### 8.5 Write Path (DO → D1)

```
route event → ring buffer (sync)
            → storage.put recentEnvelopes (async ok)
            → db.logEnvelope (async, swallow errors)
```

Ordering: live clients see WS frames immediately; D1 may lag seconds. Audit is **best-effort**.

### 8.6 Read Path (REST → D1)

```
HTTP → Worker → Db.* → JSON
```

Online status is **not** in D1; merge from MeshDO when requested.

---

## 9. Agent Cards & Discovery

### 9.1 Capability Object

```json
{
  "name": "calendar.check",
  "schema": {
    "input": { /* JSON Schema */ },
    "output": { /* JSON Schema */ }
  },
  "scope": "mesh",
  "security": "none"
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `name` | yes | Dotted capability id; `[a-z0-9._-]+`, length 1–128 |
| `schema` | no | `{ input?: JSONSchema, output?: JSONSchema }` |
| `scope` | no | `mesh` \| `self` \| `public` (informational) |
| `security` | no | Free string hint (`none`, `mtls`, …) — not enforced |

### 9.2 Full AgentCard Schema

See §20.4. Fields: `id`, `display_name`, `capabilities[]`, `last_seen`, `mesh_id`, optional `online`.

### 9.3 Registration Flow

```
1. Agent connects WS (member of mesh).
2. Agent sends card.announce with full capabilities array (replace semantics).
3. Gateway replies card.registered { agent_id }.
4. DO updates cache + D1 capabilities + last_seen.
5. Subsequent GET /agents/:id/card and list agents reflect new caps.
```

Empty `capabilities: []` clears advertised caps.

### 9.4 Discovery Query Language

Used by `GET /meshes/:id/agents`:

| Mode (`capability_match`) | Semantics |
|---------------------------|-----------|
| `exact` (default) | `cap.name === capability` |
| `prefix` | `cap.name.startsWith(capability)` |
| `wildcard` | `capability` may include `*` glob: `*` → `.*`, `?` → `.` after escape; match whole name |

Examples:

- `?capability=calendar.check` → exact
- `?capability=calendar.&capability_match=prefix` → `calendar.check`, `calendar.create`
- `?capability=calendar.*&capability_match=wildcard` → same
- `?q=ali` → names/ids containing `ali`
- `?online=true` → session-connected only

Multiple filters AND together.

### 9.5 Card TTL & Refresh

| Parameter | Value |
|-----------|-------|
| Soft TTL | 24 hours since `last_seen` — still returned but clients MAY treat as stale |
| Hard purge from DO LRU | When evicted per §7.3.1 |
| D1 retention | Until agent deleted |
| Refresh | Re-announce on each connect; RECOMMENDED every **15 minutes** while connected |

Gateway does **not** auto-expire D1 capabilities in v1.

---

## 10. Task Lifecycle

### 10.1 States

```
                    submit
         ┌──────────────────────────┐
         │                          ▼
    (none)                      SUBMITTED
                                    │
                         target sends accept
                                    ▼
                               ACCEPTED
                                    │
                      ┌─────────────┼─────────────┐
                      │ progress*   │             │
                      ▼             │             │
                 (still ACCEPTED    │             │
                  with progress)    │             │
                      │             │             │
                      │    complete │      fail / timeout / orphan
                      ▼             ▼             ▼
                                 COMPLETED     FAILED
                                    │             │
                                    └──────┬──────┘
                                           ▼
                                        TERMINAL
```

Normative state names for internal DO table: `submitted`, `accepted`, `progress`, `completed`, `failed`.

Note: `progress` is a sub-state of `accepted` (does not replace accepted).

### 10.2 Transitions

| From | Event | To | Gateway action |
|------|-------|----|----------------|
| — | `task.submit` validated | `submitted` | Forward submit; map task_id |
| `submitted` | `task.accept` from target | `accepted` | Forward `task.accepted` |
| `accepted`/`progress` | `task.progress` | `progress` | Forward progress |
| `accepted`/`progress`/`submitted` | `task.complete` from target | `completed` | Forward completed; clear |
| any non-terminal | `task.fail` from target | `failed` | Forward failed; clear |
| any non-terminal | timeout alarm | `failed` | Forward failed `timeout` if submitter online; clear |
| any non-terminal | submitter disconnect | keep | Wait timeout |
| any non-terminal | target disconnect | keep | Wait timeout (no auto-fail until orphan timeout) |

Target SHOULD accept or fail promptly. Completing from `submitted` without accept is **allowed** (skip accept).

### 10.3 Timeout Handling

| Knob | Default | Description |
|------|---------|-------------|
| `TASK_TIMEOUT_SEC` | 300 | Max age from submit to terminal |

On timeout: synthesize fail to submitter; audit type `failed` with capability from original if known.

### 10.4 Orphan Detection

Orphan = task in map where:

- `now - createdAt > TASK_TIMEOUT_SEC`, OR
- both submitter and target offline for > `TASK_TIMEOUT_SEC`

Alarm sweeps every 60s.

### 10.5 Duplicate `task_id`

If `tasks.has(task_id)` and state not terminal → reject submit with `duplicate_task_id`.  
After terminal, `task_id` MAY be reused (map entry removed). Clients SHOULD use UUIDs.

### 10.6 Payload Opacity

Gateway MUST NOT validate `payload` / `result` against capability schemas. Schema is for peer discovery only.

---

## 11. Error Handling

### 11.1 HTTP Error Catalog

| code | HTTP | Message (typical) | Recovery |
|------|------|-------------------|----------|
| `bad_request` | 400 | Invalid/missing fields | Fix request |
| `unauthorized` | 401 | Missing/invalid credentials | Re-auth |
| `invalid_api_key` | 401 | API key rejected | Check key |
| `invalid_token` | 401 | JWT invalid | Re-issue token |
| `token_expired` | 401 | JWT expired | Re-issue token |
| `forbidden` | 403 | Authenticated but not allowed | Use owner account |
| `invalid_invite` | 403 | Invite not valid for mesh | Check code |
| `invite_expired` | 403 | Invite past expires_at | Request new invite |
| `invite_exhausted` | 403 | max_uses reached | Request new invite |
| `mesh_mismatch` | 403 | JWT mesh ≠ requested | Re-token for mesh |
| `not_a_member` | 403 | Agent not in mesh | Join first |
| `not_found` | 404 | Resource missing | Check ids |
| `conflict` | 409 | Name/id conflict | Choose another name |
| `rate_limited` | 429 | Too many requests | Backoff |
| `upgrade_required` | 426 | Expected WebSocket | Use WS client |
| `mesh_full` | 503 | Too many sessions | Retry later |
| `internal_error` | 500 | Unexpected failure | Retry; report |

### 11.2 WebSocket Error Codes (`error.code`)

| code | Meaning | Fatal? |
|------|---------|--------|
| `invalid_json` | Parse failure | no |
| `invalid_message` | Schema/field failure | no |
| `unknown_type` | Bad type | no |
| `not_ready` | Sent before mesh.joined | no |
| `invalid_target` | Self-target etc. | no |
| `target_offline` | Target not connected | no |
| `duplicate_task_id` | Active id reuse | no |
| `unknown_task` | Lifecycle for unknown id | no |
| `payload_too_large` | >256KiB | no (repeat → close) |
| `rate_limited` | WS rate limit | no (abuse → close 4008) |
| `internal_error` | Unexpected | no |

### 11.3 Graceful Degradation

| Subsystem down | Behavior |
|----------------|----------|
| D1 read failure on REST | `500 internal_error` |
| D1 write failure on register | `500`; no partial agent without mesh |
| D1 flush from DO | Swallow; continue routing |
| MeshDO cold start | Slight latency; clients reconnect if upgrade fails |
| Partial member card load | `mesh.joined` with best-effort cards |
| Rate limiter memory reset (new isolate) | Limits reset; acceptable for v1 |

---

## 12. Security

### 12.1 Transport

- **TLS 1.3** via Cloudflare edge only. No plaintext HTTP API in production.
- Clients MUST use `https://` and `wss://`.
- HSTS handled by CF.

### 12.2 JWT Signing Key Management

- Store only as Worker secret `JWT_SECRET`.
- Generate with ≥ 32 cryptographically random bytes (base64 or hex).
- Rotate: put new secret → brief dual-verify window **not** supported in v1 → expect forced reconnects on rotate.
- Never log raw JWT or API keys.

### 12.3 API Key Hashing

- bcrypt cost **10**.
- Store `keyId$hash` to allow O(1)-ish lookup without scanning all agents.
- Plaintext key shown **once** at creation.

### 12.4 Rate Limits

See §6.6. Additionally:

- Token endpoint: 20/min/key_id.
- Invite invent: 10/min/owner.
- WS messages: 100/min/agent default.

### 12.5 D1 Injection Prevention

- Bound parameters only.
- Capability filter applied in application memory after SELECT, or with careful parameterization — never interpolate capability strings into SQL.
- JSON capabilities stored as text; parse with try/catch.

### 12.6 WebSocket Origin Validation

- v1 default: reflect CORS `*` for browser agents.
- Production hardening SHOULD set env `ALLOWED_ORIGINS` (comma-separated). If set:
  - REST: echo matching Origin or deny.

### 12.7 Gateway PSK (Pre-Shared Key)

For private gateway deployments — a self-hosted relay that should only accept agents you personally authorize.

**How it works:**

1. Deployer sets a `GATEWAY_PSK` Worker secret (any string, recommended 32+ random bytes as hex).
2. When `GATEWAY_PSK` is set, agent registration REQUIRES a matching `psk` field:

```http
POST /api/v1/agents
Content-Type: application/json

{ "display_name": "Alice", "psk": "the-shared-secret" }
```

3. If PSK is missing or wrong → `403 { error: { code: "psk_required", message: "...", status: 403 } }`.
4. If `GATEWAY_PSK` is NOT set → public registration (no PSK check) — default for public relays.

**Design decisions:**

- **Optional, not mandatory** — public gateways don't need it. Private deployers opt in by setting the secret.
- **Checked on registration only** — once registered, the agent uses its API key + JWT as normal. PSK is the door, not the deadbolt.
- **Single shared key** — one PSK per gateway. All trusted agents share it. Simpler than per-agent invite tokens for the deployment gate.
- **No PSK in responses** — never returned by the API, only accepted as input.
  - WS: require `Origin` header ∈ allowlist; else `403`.
- Non-browser agents may omit Origin; allow if `ALLOWED_ORIGINS` unset.

### 12.8 Invite Code Entropy

- Suffix: 6 chars from 32-symbol alphabet → \(32^6 ≈ 2^{30}\) space.
- Prefix is cosmetic, not secret.
- Optional expiry and max_uses reduce replay risk.
- Codes are **capabilities**: treat as secrets; deliver out-of-band.

### 12.8 Blind Router Trust Model

- Gateway does not verify that `capability` is offered by target.
- Gateway does not verify payload schemas.
- Agents MUST authorize locally and may `task.fail` with `unauthorized`.

### 12.9 PII & Logs

- Log mesh_id, agent_id, task_id, message types, sizes — not payloads — at info level.
- `envelope_log` stores sizes not bodies.

---

## 13. Mesh Model

### 13.1 Creation

See `POST /meshes` and personal mesh on `POST /agents`.

Personal mesh naming: `personal-{slug}` with numeric suffix on collision; `is_public=0`.

### 13.2 Public vs Private

| `is_public` | Meaning in v1 |
|-------------|----------------|
| 0 | Invite required (always) |
| 1 | Intended for open discovery listing (future); **still invite-gated for join in v1** |

### 13.3 Join via Invite

Flow: create invite (§4.8) → share code → `POST .../join` → membership moves to mesh → connect WS with JWT whose `mesh` claim matches (re-token after join!).

**Important:** After join, agent MUST call `/auth/token` again so JWT `mesh` claim updates to new mesh. Old JWT remains tied to previous mesh and will fail `mesh_mismatch`.

### 13.4 Leave

- WS `mesh.leave`: disconnect only.
- HTTP DELETE member: move agent to new/existing personal mesh; notify DO `member-left`; disconnect sessions.

### 13.5 Delete with Cascade

When owner deletes mesh:

1. Close all MeshDO sessions (`1001 going_away`).
2. For each agent with `mesh_id`:
   - Create personal mesh if needed; reassign.
3. `DELETE FROM invites WHERE mesh_id=?`
4. `DELETE FROM envelope_log WHERE mesh_id=?` (or retain for audit — v1 **deletes**)
5. `DELETE FROM meshes WHERE id=?`
6. DO storage may remain until eviction; harmless.

### 13.6 Member Listing + Online Status

`GET /meshes/:id/agents` + optional DO status merge.  
`online: true` iff agent_id ∈ MeshDO `sessions`.

### 13.7 Invite Generation Algorithm

```
alphabet = ABCDEFGHJKLMNPQRSTUVWXYZ23456789  # 32 chars
suffix = 6× random from alphabet
prefix = upper(alnum(meshName)).slice(0,12) || "MESH"
code = prefix + "-" + suffix
```

Retry up to 5 times on PK conflict.

---

## 14. Testing Strategy

### 14.1 Tooling

- **Vitest** unit/integration.
- Fake D1 in-memory (`tests/fake-d1.ts` pattern).
- MeshDO tested via exported handlers / miniflare or isolated class with mocked `DurableObjectState`.

### 14.2 Unit Tests by Module

| Module | Must cover |
|--------|------------|
| `auth.ts` | hash/verify; JWT issue/verify; expired; missing claims; parse stored hash |
| `utils.ts` | api key parse/generate; invite code charset; rate limiter window; agent id slug |
| `ws/handler.ts` | parse every message type; route submit/accept/progress/complete/fail/leave; offline target; duplicate task; self-target |
| `db/schema.ts` | CRUD meshes/agents/invites; capability filter; envelope log |
| `api/*.ts` | validation branches; status codes |

### 14.3 Integration Scenarios

1. Register → token → create mesh → invite → second agent join → both WS → announce → discover → submit → accept → progress → complete.
2. Submit to offline target → `target_offline`.
3. Expired JWT on WS → `401`/`4001`.
4. Duplicate join same mesh → 200 idempotent membership.
5. Invite expiry / exhaustion.
6. Reconnect replaces session (`4000`).
7. Token expiring warning emitted near expiry (inject clock).
8. Rate limit trips on token endpoint.
9. Mesh delete cascades.
10. Network partition: target disconnect mid-task → timeout fail.

### 14.4 Mock Strategies

| Dependency | Mock |
|------------|------|
| D1 | In-memory SQL subset or fake implementing `prepare().bind().first/run/all` |
| DO storage | Map-backed mock with alarm queue |
| WebSocket | Mock pair with message arrays |
| bcrypt/jose | Use real libs in unit tests (fast enough at cost 4 in test env — production stays 10; tests MAY set lower cost via injection) |

### 14.5 Edge Cases Checklist

- [ ] Expired token
- [ ] Duplicate joins
- [ ] Duplicate task_id
- [ ] Invite wrong mesh
- [ ] Agent not member on WS
- [ ] Payload > 256KiB
- [ ] Invalid JSON
- [ ] Binary WS frame
- [ ] Mesh name conflict
- [ ] Agent display_name unicode / empty
- [ ] Concurrent connects same agent
- [ ] D1 flush failure swallowed
- [ ] Hibernation restore missing attachment

### 14.6 Coverage Targets

- ≥ 30 unit tests
- ≥ 10 integration lifecycle tests
- ≥ 5 edge-case tests
- Typecheck clean (`tsc --noEmit`)

---

## 15. Deployment

### 15.1 `wrangler.toml` (normative shape)

```toml
name = "polymesh-gateway"
main = "src/index.ts"
compatibility_date = "2025-07-01"
compatibility_flags = ["nodejs_compat"]

[vars]
RATE_LIMIT_PER_MINUTE = "100"

[[d1_databases]]
binding = "PM_DB"
database_name = "pm-gateway"
database_id = "<from wrangler d1 create>"
migrations_dir = "migrations"

[[durable_objects.bindings]]
name = "MESH_DO"
class_name = "MeshDO"

[[migrations]]
tag = "v1"
new_classes = ["MeshDO"]
```

### 15.2 Procedure

```bash
# 1. Create D1
npx wrangler d1 create pm-gateway
# paste database_id into wrangler.toml

# 2. Apply migrations (remote)
npx wrangler d1 migrations apply pm-gateway --remote

# 3. Secrets
openssl rand -base64 48 | npx wrangler secret put JWT_SECRET

# 4. Deploy
npx wrangler deploy

# 5. Local dev
echo "dev-jwt-secret-change-me" > .dev.vars
npx wrangler d1 migrations apply pm-gateway --local
npm run dev
```

### 15.3 Custom Domains

1. CF Dashboard → Workers → polymesh-gateway → Triggers → Custom Domain.
2. Attach `pm-gateway.example.com`.
3. Clients use `https://pm-gateway.example.com` / `wss://pm-gateway.example.com`.
4. If `ALLOWED_ORIGINS` set, include web app origins.

### 15.4 Monitoring & Logging

- `console.log` / `console.error` → Workers logs / tail: `wrangler tail`.
- Metrics to watch: request count, 4xx/5xx, DO duration, D1 rows read/written, WS disconnect codes.
- Alert on elevated `500` and D1 error rates.
- Optional: ship logs to external drain (CF Logpush) — out of scope for code, ops concern.

### 15.5 Secrets Checklist

| Name | Required | Notes |
|------|----------|-------|
| `JWT_SECRET` | yes | Strong random |
| `.dev.vars` | local only | Never commit |

---

## 16. Scaling

### 16.1 Cloudflare Free Tier (approximate; verify current CF docs)

| Resource | Free-tier ballpark | Gateway impact |
|----------|--------------------|----------------|
| Workers requests | ~100k/day | REST + WS upgrade counts |
| CPU time | 10ms–50ms class limits | bcrypt cost 10 is heavy — keep token QPS low |
| D1 rows read | ~5M/day | List agents / auth lookups |
| D1 rows written | ~100k/day | envelope_log dominates |
| Durable Objects | Limited duration | Hibernation essential |
| Simultaneous connections | Platform caps | Cap sessions/mesh at 200 |

### 16.2 When Limits Are Hit

| Symptom | Likely limit | Mitigation |
|---------|--------------|------------|
| 429 from CF | Workers daily | Upgrade plan; cache discovery |
| D1 write errors | Write cap | Sample audit logs; batch flushes; TTL delete old envelope_log |
| DO exceeded | Duration / storage | Hibernation; shrink ring; evict cards |
| WS failures | Conn limits | Multiple meshes; shard by mesh already |

### 16.3 Scale-Beyond Strategies

1. **D1 reads:** Cache mesh agent lists in DO; REST can optionally read DO status.
2. **D1 writes:** Buffer envelope logs in DO; flush every N seconds or N events in a batch transaction.
3. **DO duration:** Always hibernate; avoid per-message storage.put — debounce persist.
4. **WS connections:** Keep one DO per mesh (natural shard). Very large communities → split meshes.
5. **bcrypt CPU:** Consider moving to a lower cost only if threat model allows — default remains 10; or introduce API key caching of verification success for few seconds in memory (careful).

### 16.4 Cold Start Considerations

- Worker isolate cold start: few ms–hundreds ms; first request slower.
- DO cold start: load storage + restore hibernated WS.
- Clients MUST implement reconnect backoff (§5.5).
- Personal meshes that never connect still cost only D1 rows.

---

## 17. File Structure & Module Responsibilities

```
polymesh-gateway/
├── wrangler.toml
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── SPEC.md                 # this document
├── README.md
├── migrations/
│   └── 001_init.sql
├── src/
│   ├── index.ts            # Worker router + WS upgrade proxy
│   ├── auth.ts             # bcrypt + JWT
│   ├── types.ts            # shared types
│   ├── utils.ts            # ids, cors, rate limit, json helpers
│   ├── api/
│   │   ├── agents.ts       # POST /agents, GET /agents/:id/card
│   │   ├── auth.ts         # POST /auth/token
│   │   └── meshes.ts       # meshes CRUD, join, invite
│   ├── do/
│   │   └── mesh-do.ts      # MeshDO
│   ├── ws/
│   │   └── handler.ts      # parse + route
│   └── db/
│       └── schema.ts       # Db class
└── tests/
    ├── api.test.ts
    ├── ws.test.ts
    ├── auth.test.ts
    └── fake-d1.ts
```

### Subagent Build Constraint

When building from this SPEC in Cursor, subagents MUST use only:

- `cursor-grok-4.5-high` — complex reasoning / architecture / protocol
- `composer-2.5` — scaffolding, config, simple tests

Do not use other models for subagent delegation.

---

## 18. Relationship to PolyMesh v5 SDKs

Gateway transport sits alongside `loopback` and direct `wss` modes.

TypeScript sketch:

```ts
const client = new PolyMeshClient({ transport: "gateway" });
await client.connectGateway({
  apiKey: "pmgk_...",
  gatewayUrl: "wss://pm-gateway.example.com",
});
await client.joinMesh("friends", { inviteCode: "FRIENDS-ABC123" });
await client.discoverAgents({ capability: "calendar.check" });
```

Python sketch:

```python
client = PolyMeshClient(transport="gateway")
await client.connect_gateway(api_key="pmgk_...", gateway_url="wss://...")
await client.join_mesh("friends", invite_code="FRIENDS-ABC123")
await client.discover_agents(capability="calendar.check")
```

Envelope types, compression (if any at SDK layer), and lifecycle events remain unchanged — only transport differs.

---

## 19. Normative Constants

| Constant | Value |
|----------|-------|
| Gateway version | `1.0.0` |
| API prefix | `/api/v1` |
| JWT TTL | 3600 s |
| Token warn threshold | 300 s |
| bcrypt cost | 10 |
| Ring buffer capacity | 100 |
| Max WS/REST payload | 256 KiB |
| Max sessions per mesh | 200 |
| Max cached cards per DO | 500 |
| Max active tasks per mesh | 1000 |
| Task timeout | 300 s |
| Rate limit / agent / min | 100 (env override) |
| Invite suffix length | 6 |
| Invite alphabet size | 32 |
| Attachment version | 1 |
| Compatibility date | `2025-07-01` |
| DO migration tag | `v1` |

---

## 20. Appendix: Complete JSON Schemas

### 20.1 ApiErrorBody

```json
{
  "$id": "https://polymesh.latticeag/schemas/ApiErrorBody.json",
  "type": "object",
  "required": ["error"],
  "additionalProperties": false,
  "properties": {
    "error": {
      "type": "object",
      "required": ["code", "message"],
      "additionalProperties": false,
      "properties": {
        "code": { "type": "string", "minLength": 1 },
        "message": { "type": "string" }
      }
    }
  }
}
```

### 20.2 CreateAgentRequest

```json
{
  "type": "object",
  "required": ["display_name"],
  "additionalProperties": false,
  "properties": {
    "display_name": { "type": "string", "minLength": 1, "maxLength": 128 },
    "mesh_id": { "type": "string", "minLength": 1 }
  }
}
```

### 20.3 CreateAgentResponse

```json
{
  "type": "object",
  "required": ["agent_id", "api_key", "mesh_id"],
  "additionalProperties": false,
  "properties": {
    "agent_id": { "type": "string" },
    "api_key": { "type": "string", "pattern": "^pmgk_[A-Za-z0-9]+_[A-Za-z0-9]+$" },
    "mesh_id": { "type": "string" }
  }
}
```

### 20.4 AgentCard / Capability

```json
{
  "$defs": {
    "Capability": {
      "type": "object",
      "required": ["name"],
      "properties": {
        "name": { "type": "string", "minLength": 1, "maxLength": 128 },
        "schema": {
          "type": "object",
          "properties": {
            "input": { "type": "object" },
            "output": { "type": "object" }
          },
          "additionalProperties": true
        },
        "scope": { "type": "string" },
        "security": { "type": "string" }
      },
      "additionalProperties": false
    },
    "AgentCard": {
      "type": "object",
      "required": ["id", "display_name", "capabilities"],
      "properties": {
        "id": { "type": "string" },
        "display_name": { "type": "string" },
        "capabilities": {
          "type": "array",
          "items": { "$ref": "#/$defs/Capability" }
        },
        "last_seen": { "type": ["string", "null"] },
        "mesh_id": { "type": "string" },
        "online": { "type": "boolean" }
      },
      "additionalProperties": false
    }
  }
}
```

### 20.5 TokenRequest

```json
{
  "type": "object",
  "required": ["api_key"],
  "additionalProperties": false,
  "properties": {
    "api_key": { "type": "string", "minLength": 10 }
  }
}
```

### 20.6 TokenResponse

```json
{
  "type": "object",
  "required": ["token", "expires_at"],
  "additionalProperties": false,
  "properties": {
    "token": { "type": "string" },
    "expires_at": { "type": "string", "format": "date-time" }
  }
}
```

### 20.7 CreateMeshRequest

```json
{
  "type": "object",
  "required": ["name", "agent_id"],
  "additionalProperties": false,
  "properties": {
    "name": { "type": "string", "minLength": 1, "maxLength": 64 },
    "agent_id": { "type": "string", "minLength": 1 },
    "is_public": { "type": "boolean" }
  }
}
```

### 20.8 CreateMeshResponse

```json
{
  "type": "object",
  "required": ["mesh_id", "invite_code"],
  "additionalProperties": false,
  "properties": {
    "mesh_id": { "type": "string" },
    "invite_code": { "type": "string" }
  }
}
```

### 20.9 ListAgentsResponse

```json
{
  "type": "object",
  "required": ["agents"],
  "additionalProperties": false,
  "properties": {
    "agents": {
      "type": "array",
      "items": { "$ref": "AgentCard.json" }
    }
  }
}
```

### 20.10 JoinMeshRequest

```json
{
  "type": "object",
  "required": ["agent_id", "invite_code"],
  "additionalProperties": false,
  "properties": {
    "agent_id": { "type": "string" },
    "invite_code": { "type": "string", "minLength": 3 }
  }
}
```

### 20.11 JoinMeshResponse

```json
{
  "type": "object",
  "required": ["mesh_id", "members", "agent_id"],
  "additionalProperties": false,
  "properties": {
    "mesh_id": { "type": "string" },
    "agent_id": { "type": "string" },
    "members": { "type": "array", "items": { "$ref": "AgentCard.json" } }
  }
}
```

### 20.12 CreateInviteRequest

```json
{
  "type": "object",
  "required": ["agent_id"],
  "additionalProperties": false,
  "properties": {
    "agent_id": { "type": "string" },
    "api_key": { "type": "string" },
    "max_uses": { "type": "integer", "minimum": 0, "maximum": 100000 },
    "expires_in_seconds": { "type": "integer", "minimum": 60, "maximum": 2592000 },
    "prefix": { "type": "string", "minLength": 1, "maxLength": 12, "pattern": "^[A-Za-z0-9]+$" }
  }
}
```

### 20.13 CreateInviteResponse

```json
{
  "type": "object",
  "required": ["mesh_id", "invite_code", "max_uses", "use_count", "created_at"],
  "additionalProperties": false,
  "properties": {
    "mesh_id": { "type": "string" },
    "invite_code": { "type": "string" },
    "max_uses": { "type": "integer" },
    "use_count": { "type": "integer" },
    "expires_at": { "type": ["string", "null"], "format": "date-time" },
    "created_at": { "type": "string", "format": "date-time" }
  }
}
```

### 20.14 WS Ping/Pong

```json
{
  "ping": {
    "type": "object",
    "required": ["type"],
    "properties": { "type": { "const": "ping" } },
    "additionalProperties": false
  },
  "pong": {
    "type": "object",
    "required": ["type", "ts"],
    "properties": {
      "type": { "const": "pong" },
      "ts": { "type": "string", "format": "date-time" }
    },
    "additionalProperties": false
  }
}
```

### 20.15 WS Inbound Schemas

```json
{
  "card.announce": {
    "type": "object",
    "required": ["type", "capabilities"],
    "properties": {
      "type": { "const": "card.announce" },
      "capabilities": { "type": "array", "items": { "$ref": "Capability" } }
    },
    "additionalProperties": false
  },
  "task.submit": {
    "type": "object",
    "required": ["type", "target", "capability", "task_id"],
    "properties": {
      "type": { "const": "task.submit" },
      "target": { "type": "string", "minLength": 1 },
      "capability": { "type": "string", "minLength": 1 },
      "payload": {},
      "task_id": { "type": "string", "minLength": 1, "maxLength": 128 }
    },
    "additionalProperties": false
  },
  "task.accept": {
    "type": "object",
    "required": ["type", "task_id"],
    "properties": {
      "type": { "const": "task.accept" },
      "task_id": { "type": "string" }
    },
    "additionalProperties": false
  },
  "task.progress": {
    "type": "object",
    "required": ["type", "task_id", "progress"],
    "properties": {
      "type": { "const": "task.progress" },
      "task_id": { "type": "string" },
      "progress": { "type": "number", "minimum": 0, "maximum": 1 },
      "message": { "type": "string" }
    },
    "additionalProperties": false
  },
  "task.complete": {
    "type": "object",
    "required": ["type", "task_id"],
    "properties": {
      "type": { "const": "task.complete" },
      "task_id": { "type": "string" },
      "result": {}
    },
    "additionalProperties": false
  },
  "task.fail": {
    "type": "object",
    "required": ["type", "task_id", "error"],
    "properties": {
      "type": { "const": "task.fail" },
      "task_id": { "type": "string" },
      "error": { "type": "string" }
    },
    "additionalProperties": false
  },
  "mesh.leave": {
    "type": "object",
    "required": ["type"],
    "properties": { "type": { "const": "mesh.leave" } },
    "additionalProperties": false
  }
}
```

### 20.16 WS Outbound Schemas

```json
{
  "mesh.joined": {
    "type": "object",
    "required": ["type", "mesh_id", "members"],
    "properties": {
      "type": { "const": "mesh.joined" },
      "mesh_id": { "type": "string" },
      "members": { "type": "array", "items": { "$ref": "AgentCard" } }
    },
    "additionalProperties": false
  },
  "card.registered": {
    "type": "object",
    "required": ["type", "agent_id"],
    "properties": {
      "type": { "const": "card.registered" },
      "agent_id": { "type": "string" }
    },
    "additionalProperties": false
  },
  "task.submit.inbound": {
    "type": "object",
    "required": ["type", "from", "capability", "task_id"],
    "properties": {
      "type": { "const": "task.submit" },
      "from": { "type": "string" },
      "capability": { "type": "string" },
      "payload": {},
      "task_id": { "type": "string" }
    },
    "additionalProperties": false
  },
  "task.accepted": {
    "type": "object",
    "required": ["type", "task_id"],
    "properties": {
      "type": { "const": "task.accepted" },
      "task_id": { "type": "string" }
    },
    "additionalProperties": false
  },
  "task.progress.out": {
    "type": "object",
    "required": ["type", "task_id", "progress"],
    "properties": {
      "type": { "const": "task.progress" },
      "task_id": { "type": "string" },
      "progress": { "type": "number" },
      "message": { "type": "string" }
    },
    "additionalProperties": false
  },
  "task.completed": {
    "type": "object",
    "required": ["type", "task_id"],
    "properties": {
      "type": { "const": "task.completed" },
      "task_id": { "type": "string" },
      "result": {}
    },
    "additionalProperties": false
  },
  "task.failed": {
    "type": "object",
    "required": ["type", "task_id", "error"],
    "properties": {
      "type": { "const": "task.failed" },
      "task_id": { "type": "string" },
      "error": { "type": "string" }
    },
    "additionalProperties": false
  },
  "token.expiring": {
    "type": "object",
    "required": ["type", "expires_at", "seconds_remaining"],
    "properties": {
      "type": { "const": "token.expiring" },
      "expires_at": { "type": "string", "format": "date-time" },
      "seconds_remaining": { "type": "integer", "minimum": 0 }
    },
    "additionalProperties": false
  },
  "error": {
    "type": "object",
    "required": ["type", "code", "message"],
    "properties": {
      "type": { "const": "error" },
      "code": { "type": "string" },
      "message": { "type": "string" }
    },
    "additionalProperties": false
  }
}
```

### 20.17 JWT Payload Schema

```json
{
  "type": "object",
  "required": ["sub", "mesh", "exp", "iat"],
  "properties": {
    "sub": { "type": "string", "description": "agent_id" },
    "mesh": { "type": "string", "description": "mesh_id" },
    "exp": { "type": "integer" },
    "iat": { "type": "integer" }
  },
  "additionalProperties": true
}
```

### 20.18 Envelope (DO ring buffer)

```json
{
  "type": "object",
  "required": ["id", "mesh_id", "from", "type", "ts"],
  "properties": {
    "id": { "type": "string" },
    "mesh_id": { "type": "string" },
    "from": { "type": "string" },
    "to": { "type": "string" },
    "type": {
      "type": "string",
      "enum": ["submit", "accepted", "progress", "completed", "failed", "leave", "announce"]
    },
    "capability": { "type": "string" },
    "task_id": { "type": "string" },
    "payload": {},
    "ts": { "type": "string", "format": "date-time" }
  },
  "additionalProperties": false
}
```

---

## Document Control

| Field | Value |
|-------|-------|
| Spec version | `1.0.0-extreme` |
| Gateway version | `1.0.0` |
| Last updated | 2026-07-25 |
| Normative language | MUST / SHOULD / MAY per RFC 2119 |

**End of SPEC.**
