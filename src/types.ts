/** PolyMesh Gateway v1 — shared TypeScript types */

export interface Env {
  PM_DB: D1Database;
  MESH_DO: DurableObjectNamespace;
  JWT_SECRET: string;
  RATE_LIMIT_PER_MINUTE?: string;
  GATEWAY_PSK?: string;
}

/** Runtime gateway settings derived from Env / wrangler vars */
export interface GatewayConfig {
  jwtSecret: string;
  rateLimitPerMinute: number;
}

/** Parsed or generated API key parts (`pmgk_<keyId>_<secret>`) */
export interface ApiKey {
  apiKey: string;
  keyId: string;
  secret: string;
}

// ─── Domain ───────────────────────────────────────────────────────────────────

export interface Capability {
  name: string;
  schema?: unknown;
  scope?: string;
  security?: string;
}

export interface AgentCard {
  id: string;
  display_name: string;
  capabilities: Capability[];
  last_seen?: string | null;
  mesh_id?: string;
  /** Present on list responses when MeshDO online status is known */
  online?: boolean;
}

export interface Mesh {
  id: string;
  name: string;
  owner_agent_id: string;
  created_at: string;
  is_public: number;
}

export interface Agent {
  id: string;
  mesh_id: string;
  display_name: string;
  api_key_hash: string;
  capabilities: string; // JSON array stored in D1
  created_at: string;
  last_seen_at: string | null;
}

export interface Invite {
  code: string;
  mesh_id: string;
  max_uses: number;
  use_count: number;
  created_at: string;
  expires_at: string | null;
}

export interface EnvelopeLogRecord {
  id: number;
  mesh_id: string;
  from_agent: string;
  to_agent: string | null;
  capability: string;
  task_id: string | null;
  type: string;
  payload_size: number | null;
  created_at: string;
}

export interface JWTPayload {
  sub: string; // agent_id
  mesh: string; // mesh_id
  exp: number;
  iat?: number;
}

// ─── REST bodies ──────────────────────────────────────────────────────────────

export interface CreateAgentRequest {
  display_name: string;
  mesh_id?: string;
  psk?: string;
}

export interface CreateAgentResponse {
  agent_id: string;
  api_key: string;
  mesh_id: string;
}

export interface TokenRequest {
  api_key: string;
}

export interface TokenResponse {
  token: string;
  expires_at: string;
}

export interface CreateMeshRequest {
  name: string;
  agent_id: string;
  is_public?: boolean;
}

export interface CreateMeshResponse {
  mesh_id: string;
  invite_code: string;
}

export interface JoinMeshRequest {
  agent_id: string;
  invite_code: string;
}

export interface JoinMeshResponse {
  mesh_id: string;
  members: AgentCard[];
  agent_id: string;
}

export interface CreateInviteRequest {
  agent_id: string;
  api_key?: string;
  max_uses?: number;
  expires_in_seconds?: number;
  prefix?: string;
}

export interface CreateInviteResponse {
  mesh_id: string;
  invite_code: string;
  max_uses: number;
  use_count: number;
  expires_at: string | null;
  created_at: string;
}

export interface ListAgentsResponse {
  agents: AgentCard[];
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
  };
}

// ─── WebSocket message types (canonical: src/ws/types.ts) ─────────────────────

export type {
  CardAnnounceMessage,
  CardRegisteredMessage,
  ErrorMessage,
  MeshJoinedMessage,
  MeshLeaveMessage,
  PingMessage,
  PongMessage,
  TaskAcceptMessage,
  TaskAcceptedMessage,
  TaskCompleteMessage,
  TaskCompletedMessage,
  TaskFailMessage,
  TaskFailedMessage,
  TaskProgressInbound,
  TaskProgressOutbound,
  TaskSubmitInbound,
  TaskSubmitOutbound,
  TokenExpiringMessage,
  WsInboundMessage,
  WsOutboundMessage,
} from "./ws/types";

/** In-memory envelope for DO ring buffer / catch-up */
export interface Envelope {
  id: string;
  mesh_id: string;
  from: string;
  to?: string;
  type: string;
  capability?: string;
  task_id?: string;
  payload?: unknown;
  ts: string;
}

export type EnvelopeLogType =
  | "submit"
  | "accepted"
  | "progress"
  | "completed"
  | "failed"
  | "leave"
  | "announce";
