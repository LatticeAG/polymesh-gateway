/** D1 client + queries for PolyMesh Gateway */

import type {
  Agent,
  AgentCard,
  Capability,
  EnvelopeLogRecord,
  EnvelopeLogType,
  Invite,
  Mesh,
} from "../types";
import {
  INSERT_AGENT,
  INSERT_ENVELOPE_LOG,
  INSERT_INVITE,
  INSERT_MESH,
  SELECT_AGENT_BY_ID,
  SELECT_AGENT_BY_KEY_PREFIX,
  SELECT_AGENT_EXISTS,
  SELECT_AGENTS_BY_MESH,
  SELECT_ENVELOPE_LOG_BY_MESH,
  SELECT_INVITE_BY_CODE,
  SELECT_MESH_BY_ID,
  SELECT_MESH_BY_NAME,
  UPDATE_AGENT_CAPABILITIES,
  UPDATE_AGENT_LAST_SEEN,
  UPDATE_AGENT_MESH,
  UPDATE_INVITE_USE_COUNT,
} from "./queries";

function parseCapabilities(raw: string | null | undefined): Capability[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? (v as Capability[]) : [];
  } catch {
    return [];
  }
}

export function agentToCard(agent: Agent): AgentCard {
  return {
    id: agent.id,
    display_name: agent.display_name,
    capabilities: parseCapabilities(agent.capabilities),
    last_seen: agent.last_seen_at,
    mesh_id: agent.mesh_id,
  };
}

export class Db {
  constructor(private readonly db: D1Database) {}

  // ─── Meshes ───────────────────────────────────────────────────────────────

  async createMesh(input: {
    id: string;
    name: string;
    owner_agent_id: string;
    is_public?: boolean;
  }): Promise<Mesh> {
    await this.db
      .prepare(INSERT_MESH)
      .bind(
        input.id,
        input.name,
        input.owner_agent_id,
        input.is_public ? 1 : 0,
      )
      .run();
    const mesh = await this.getMesh(input.id);
    if (!mesh) throw new Error("Failed to create mesh");
    return mesh;
  }

  async getMesh(id: string): Promise<Mesh | null> {
    return this.db
      .prepare(SELECT_MESH_BY_ID)
      .bind(id)
      .first<Mesh>();
  }

  async getMeshByName(name: string): Promise<Mesh | null> {
    return this.db
      .prepare(SELECT_MESH_BY_NAME)
      .bind(name)
      .first<Mesh>();
  }

  // ─── Agents ───────────────────────────────────────────────────────────────

  async createAgent(input: {
    id: string;
    mesh_id: string;
    display_name: string;
    api_key_hash: string;
    capabilities?: Capability[];
  }): Promise<Agent> {
    const caps = JSON.stringify(input.capabilities ?? []);
    await this.db
      .prepare(INSERT_AGENT)
      .bind(
        input.id,
        input.mesh_id,
        input.display_name,
        input.api_key_hash,
        caps,
      )
      .run();
    const agent = await this.getAgent(input.id);
    if (!agent) throw new Error("Failed to create agent");
    return agent;
  }

  async getAgent(id: string): Promise<Agent | null> {
    return this.db
      .prepare(SELECT_AGENT_BY_ID)
      .bind(id)
      .first<Agent>();
  }

  /** Lookup by keyId prefix stored as `keyId$bcryptHash` in api_key_hash */
  async getAgentByKeyId(keyId: string): Promise<Agent | null> {
    return this.db
      .prepare(SELECT_AGENT_BY_KEY_PREFIX)
      .bind(`${keyId}$%`)
      .first<Agent>();
  }

  async updateAgentMesh(agentId: string, meshId: string): Promise<void> {
    await this.db
      .prepare(UPDATE_AGENT_MESH)
      .bind(meshId, agentId)
      .run();
  }

  async updateAgentCapabilities(
    agentId: string,
    capabilities: Capability[],
  ): Promise<void> {
    await this.db
      .prepare(UPDATE_AGENT_CAPABILITIES)
      .bind(JSON.stringify(capabilities), agentId)
      .run();
  }

  async updateLastSeen(agentId: string, at?: string): Promise<void> {
    const ts = at ?? new Date().toISOString();
    await this.db
      .prepare(UPDATE_AGENT_LAST_SEEN)
      .bind(ts, agentId)
      .run();
  }

  async listAgentsByMesh(
    meshId: string,
    capability?: string,
  ): Promise<AgentCard[]> {
    const { results } = await this.db
      .prepare(SELECT_AGENTS_BY_MESH)
      .bind(meshId)
      .all<Agent>();

    let cards = (results ?? []).map(agentToCard);
    if (capability) {
      cards = cards.filter((c) =>
        c.capabilities.some((cap) => cap.name === capability),
      );
    }
    return cards;
  }

  async agentIdExists(id: string): Promise<boolean> {
    const row = await this.db
      .prepare(SELECT_AGENT_EXISTS)
      .bind(id)
      .first<{ ok: number }>();
    return !!row;
  }

  // ─── Invites ──────────────────────────────────────────────────────────────

  async createInvite(input: {
    code: string;
    mesh_id: string;
    max_uses?: number;
    expires_at?: string | null;
  }): Promise<Invite> {
    await this.db
      .prepare(INSERT_INVITE)
      .bind(
        input.code,
        input.mesh_id,
        input.max_uses ?? 0,
        input.expires_at ?? null,
      )
      .run();
    const invite = await this.getInvite(input.code);
    if (!invite) throw new Error("Failed to create invite");
    return invite;
  }

  async getInvite(code: string): Promise<Invite | null> {
    return this.db
      .prepare(SELECT_INVITE_BY_CODE)
      .bind(code)
      .first<Invite>();
  }

  async incrementInviteUse(code: string): Promise<void> {
    await this.db
      .prepare(UPDATE_INVITE_USE_COUNT)
      .bind(code)
      .run();
  }

  // ─── Envelope log ─────────────────────────────────────────────────────────

  async logEnvelope(input: {
    mesh_id: string;
    from_agent: string;
    to_agent?: string | null;
    capability: string;
    task_id?: string | null;
    type: EnvelopeLogType | string;
    payload_size?: number | null;
  }): Promise<void> {
    await this.db
      .prepare(INSERT_ENVELOPE_LOG)
      .bind(
        input.mesh_id,
        input.from_agent,
        input.to_agent ?? null,
        input.capability,
        input.task_id ?? null,
        input.type,
        input.payload_size ?? null,
      )
      .run();
  }

  async listRecentEnvelopes(
    meshId: string,
    limit = 100,
  ): Promise<EnvelopeLogRecord[]> {
    const { results } = await this.db
      .prepare(SELECT_ENVELOPE_LOG_BY_MESH)
      .bind(meshId, limit)
      .all<EnvelopeLogRecord>();
    return results ?? [];
  }
}
