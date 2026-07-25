/** MeshDO — one Durable Object per active mesh (SPEC §7) */

import { Db, agentToCard } from "../db/schema";
import type {
  AgentCard,
  Capability,
  Envelope,
  Env,
  ErrorMessage,
  JWTPayload,
  WsInboundMessage,
} from "../types";
import {
  secondsUntilExpiry,
  tokenExpiringSoon,
  verifyJwt,
} from "../auth";
import { generateId, nowIso } from "../utils";
import {
  buildMeshJoined,
  buildTokenExpiring,
  createTaskRoutingTable,
  handleInboundMessage,
  parseInboundMessage,
  sendError,
  sendJson,
  type TaskRouteEntry,
  type TaskRoutingTable,
  type WsMeshContext,
} from "../ws/handler";

const RING_CAPACITY = 100;
const TOKEN_WARN_SEC = 300; // 5 minutes
const ATTACHMENT_VERSION = 1;
const MAX_SESSIONS = 200;
const MAX_AGENT_CARDS = 500;
const MAX_TASKS = 1000;
const MAX_WS_MESSAGE_BYTES = 256 * 1024; // 256 KiB
const IDLE_CLEANUP_MS = 10 * 60 * 1000; // 10 minutes
const SWEEP_INTERVAL_MS = 60 * 1000; // 60 seconds
const TASK_TIMEOUT_SEC = 300;

interface WsAttachment {
  v: number;
  agentId: string;
  meshId: string;
  tokenExp: number;
  displayName: string;
  warnedExpiring: boolean;
}

class RingBuffer<T> {
  private buf: T[] = [];
  constructor(private readonly capacity: number) {}

  push(item: T): void {
    this.buf.push(item);
    if (this.buf.length > this.capacity) {
      this.buf.shift();
    }
  }

  toArray(): T[] {
    return [...this.buf];
  }

  get size(): number {
    return this.buf.length;
  }
}

function jsonError(
  code: string,
  message: string,
  status: number,
): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Wrap task table with SPEC max-1000 eviction (oldest createdAt first). */
function createBoundedTaskTable(): TaskRoutingTable {
  const inner = createTaskRoutingTable();
  return {
    get: (taskId) => inner.get(taskId),
    hasActive: (taskId) => inner.hasActive(taskId),
    entries: () => inner.entries(),
    get size() {
      return inner.size;
    },
    delete: (taskId) => {
      inner.delete(taskId);
    },
    set: (taskId, entry) => {
      if (!inner.get(taskId) && inner.size >= MAX_TASKS) {
        let oldestId: string | null = null;
        let oldestAt = Number.POSITIVE_INFINITY;
        for (const [id, e] of inner.entries()) {
          if (e.createdAt < oldestAt) {
            oldestAt = e.createdAt;
            oldestId = id;
          }
        }
        if (oldestId) inner.delete(oldestId);
      }
      inner.set(taskId, entry);
    },
  };
}

/**
 * Per-mesh Durable Object.
 *
 * Uses the WebSocket hibernation API (`acceptWebSocket` + `webSocketMessage` /
 * `webSocketClose`) so idle meshes do not burn DO duration continuously.
 */
export class MeshDO implements DurableObject {
  private readonly state: DurableObjectState;
  private readonly env: Env;

  /** agent_id → live WebSocket (rebuilt from hibernation attachments) */
  private sessions = new Map<string, WebSocket>();
  /** agent_id → card (capabilities cache, LRU offline max 500) */
  private agentCards = new Map<string, AgentCard>();
  /** All known member agent ids for this mesh (from D1 + announces) */
  private members = new Set<string>();
  private recentEnvelopes = new RingBuffer<Envelope>(RING_CAPACITY);
  private tasks: TaskRoutingTable = createBoundedTaskTable();
  private meshId: string | null = null;
  private hydrated = false;
  /** When sessions last became empty (for idle cleanup alarm) */
  private idleSince: number | null = null;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;

    this.state.blockConcurrencyWhile(async () => {
      await this.restoreFromHibernation();
      await this.loadPersistedState();
    });
  }

  private async restoreFromHibernation(): Promise<void> {
    const sockets = this.state.getWebSockets();
    this.sessions.clear();
    for (const ws of sockets) {
      const att = this.readAttachment(ws);
      if (!att?.agentId) {
        try {
          ws.close(1011, "missing_attachment");
        } catch {
          /* ignore */
        }
        continue;
      }
      this.sessions.set(att.agentId, ws);
      if (!this.meshId) this.meshId = att.meshId;
      this.members.add(att.agentId);
      if (!this.agentCards.has(att.agentId)) {
        this.putAgentCard({
          id: att.agentId,
          display_name: att.displayName || att.agentId,
          capabilities: [],
          last_seen: nowIso(),
          mesh_id: att.meshId,
        });
      }
    }
    this.idleSince = this.sessions.size === 0 ? Date.now() : null;
  }

  private async loadPersistedState(): Promise<void> {
    const storedMeshId = await this.state.storage.get<string>("meshId");
    if (storedMeshId) this.meshId = storedMeshId;

    const cards = await this.state.storage.get<AgentCard[]>("agentCards");
    if (cards) {
      for (const c of cards) {
        this.agentCards.set(c.id, c);
        this.members.add(c.id);
      }
    }

    const memberIds = await this.state.storage.get<string[]>("members");
    if (memberIds) {
      for (const id of memberIds) this.members.add(id);
    }

    const envelopes = await this.state.storage.get<Envelope[]>("recentEnvelopes");
    if (envelopes) {
      for (const e of envelopes) this.recentEnvelopes.push(e);
    }

    this.hydrated = true;
  }

  private async persistMeta(): Promise<void> {
    if (!this.meshId) return;
    await this.state.storage.put({
      meshId: this.meshId,
      agentCards: [...this.agentCards.values()],
      members: [...this.members],
      recentEnvelopes: this.recentEnvelopes.toArray(),
    });
  }

  private readAttachment(ws: WebSocket): WsAttachment | null {
    try {
      const raw = ws.deserializeAttachment() as WsAttachment | null;
      if (!raw || raw.v !== ATTACHMENT_VERSION) return null;
      return raw;
    } catch {
      return null;
    }
  }

  private writeAttachment(ws: WebSocket, att: WsAttachment): void {
    ws.serializeAttachment(att);
  }

  private ensureMeshId(meshId: string): void {
    if (!this.meshId) {
      this.meshId = meshId;
    }
  }

  /** Agents referenced by in-flight task routes (protect from card LRU) */
  private agentsInTaskRoutes(): Set<string> {
    const ids = new Set<string>();
    for (const [, entry] of this.tasks.entries()) {
      ids.add(entry.submitter);
      ids.add(entry.target);
    }
    return ids;
  }

  private pickLruCardVictim(): string | null {
    const inTasks = this.agentsInTaskRoutes();

    const pick = (allowTaskRouted: boolean): string | null => {
      let bestId: string | null = null;
      let bestSeen = Number.POSITIVE_INFINITY;
      for (const [id, card] of this.agentCards) {
        if (this.sessions.has(id)) continue; // never evict connected
        if (!allowTaskRouted && inTasks.has(id)) continue;
        const ts = card.last_seen ? Date.parse(card.last_seen) : 0;
        const score = Number.isFinite(ts) ? ts : 0;
        if (score < bestSeen) {
          bestSeen = score;
          bestId = id;
        }
      }
      return bestId;
    };

    return pick(false) ?? pick(true);
  }

  private putAgentCard(card: AgentCard): void {
    if (this.agentCards.has(card.id)) {
      this.agentCards.set(card.id, card);
      return;
    }
    while (this.agentCards.size >= MAX_AGENT_CARDS) {
      const victim = this.pickLruCardVictim();
      if (!victim) break;
      this.agentCards.delete(victim);
    }
    this.agentCards.set(card.id, card);
  }

  private makeContext(): WsMeshContext {
    const meshId = this.meshId ?? "";
    return {
      meshId,
      getSession: (agentId) => this.sessions.get(agentId),
      getAllSessions: () => new Map(this.sessions),
      getAgentCard: (agentId) => this.agentCards.get(agentId),
      getMemberCards: () => this.collectMemberCards(),
      setAgentCapabilities: (agentId, capabilities) => {
        void this.setCapabilities(agentId, capabilities);
      },
      pushEnvelope: (envelope) => {
        this.recentEnvelopes.push(envelope);
        void this.state.storage.put(
          "recentEnvelopes",
          this.recentEnvelopes.toArray(),
        );
      },
      logEnvelope: async (input) => {
        if (!this.meshId) return;
        try {
          const db = new Db(this.env.PM_DB);
          await db.logEnvelope({
            mesh_id: this.meshId,
            ...input,
          });
        } catch {
          // D1 flush is best-effort; routing must not fail
        }
      },
      closeSession: (agentId, code = 1000, reason = "closed") => {
        const ws = this.sessions.get(agentId);
        if (ws) {
          try {
            ws.close(code, reason);
          } catch {
            /* ignore */
          }
        }
        this.removeSession(agentId);
      },
    };
  }

  private collectMemberCards(): AgentCard[] {
    const cards: AgentCard[] = [];
    const seen = new Set<string>();

    for (const [id, card] of this.agentCards) {
      cards.push({
        ...card,
        mesh_id: this.meshId ?? card.mesh_id,
      });
      seen.add(id);
    }

    for (const id of this.members) {
      if (seen.has(id)) continue;
      cards.push({
        id,
        display_name: id,
        capabilities: [],
        last_seen: null,
        mesh_id: this.meshId ?? undefined,
      });
    }

    cards.sort((a, b) => {
      const aOn = this.sessions.has(a.id) ? 0 : 1;
      const bOn = this.sessions.has(b.id) ? 0 : 1;
      if (aOn !== bOn) return aOn - bOn;
      return a.display_name.localeCompare(b.display_name);
    });

    return cards;
  }

  private async setCapabilities(
    agentId: string,
    capabilities: Capability[],
  ): Promise<void> {
    const existing = this.agentCards.get(agentId);
    const card: AgentCard = {
      id: agentId,
      display_name: existing?.display_name ?? agentId,
      capabilities,
      last_seen: nowIso(),
      mesh_id: this.meshId ?? existing?.mesh_id,
    };
    this.putAgentCard(card);
    this.members.add(agentId);
    await this.persistMeta();

    try {
      const db = new Db(this.env.PM_DB);
      await db.updateAgentCapabilities(agentId, capabilities);
      await db.updateLastSeen(agentId);
    } catch {
      /* best-effort D1 sync */
    }
  }

  private removeSession(agentId: string): void {
    this.sessions.delete(agentId);
    if (this.sessions.size === 0 && this.idleSince === null) {
      this.idleSince = Date.now();
    }
  }

  // ─── HTTP entry (upgrade + internal RPCs) ─────────────────────────────────

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/internal/member-joined" && request.method === "POST") {
      return this.handleMemberJoined(request);
    }

    if (url.pathname === "/internal/member-left" && request.method === "POST") {
      return this.handleMemberLeft(request);
    }

    if (url.pathname === "/internal/status" && request.method === "GET") {
      return Response.json({
        mesh_id: this.meshId,
        sessions: [...this.sessions.keys()],
        members: [...this.members],
        recent: this.recentEnvelopes.size,
      });
    }

    if (url.pathname === "/internal/recent" && request.method === "GET") {
      return Response.json({ envelopes: this.recentEnvelopes.toArray() });
    }

    const upgrade = request.headers.get("Upgrade");
    if (upgrade?.toLowerCase() === "websocket") {
      return this.handleWebSocketUpgrade(request);
    }

    return new Response("MeshDO: expected WebSocket upgrade", { status: 426 });
  }

  private async handleMemberJoined(request: Request): Promise<Response> {
    let body: { agent_id?: string; mesh_id?: string };
    try {
      body = (await request.json()) as { agent_id?: string; mesh_id?: string };
    } catch {
      return new Response("bad json", { status: 400 });
    }
    if (!body.agent_id) {
      return new Response("agent_id required", { status: 400 });
    }
    if (body.mesh_id) this.ensureMeshId(body.mesh_id);
    this.members.add(body.agent_id);

    try {
      const db = new Db(this.env.PM_DB);
      const agent = await db.getAgent(body.agent_id);
      if (agent) {
        this.putAgentCard(agentToCard(agent));
      }
    } catch {
      /* ignore */
    }

    await this.persistMeta();
    return new Response(null, { status: 204 });
  }

  private async handleMemberLeft(request: Request): Promise<Response> {
    let body: { agent_id?: string; mesh_id?: string };
    try {
      body = (await request.json()) as { agent_id?: string; mesh_id?: string };
    } catch {
      return new Response("bad json", { status: 400 });
    }
    if (!body.agent_id) {
      return new Response("agent_id required", { status: 400 });
    }
    if (body.mesh_id) this.ensureMeshId(body.mesh_id);

    this.members.delete(body.agent_id);

    const ws = this.sessions.get(body.agent_id);
    if (ws) {
      try {
        ws.close(1000, "leave");
      } catch {
        /* ignore */
      }
      this.removeSession(body.agent_id);
    }

    await this.persistMeta();
    await this.scheduleNextAlarm();
    return new Response(null, { status: 204 });
  }

  private async handleWebSocketUpgrade(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const token =
      url.searchParams.get("token") ||
      request.headers.get("X-PM-Token") ||
      "";
    const meshParam =
      url.searchParams.get("mesh") ||
      request.headers.get("X-PM-Mesh") ||
      "";

    if (!token) {
      return jsonError("unauthorized", "Missing token", 401);
    }

    let claims: JWTPayload;
    try {
      claims = await verifyJwt(token, this.env.JWT_SECRET);
    } catch (e) {
      const err = e as { message?: string; code?: string };
      return jsonError(
        err.code ?? "unauthorized",
        err.message ?? "Invalid token",
        401,
      );
    }

    const meshId = meshParam || claims.mesh;
    if (!meshId || claims.mesh !== meshId) {
      return jsonError(
        "mesh_mismatch",
        "JWT mesh claim does not match requested mesh",
        403,
      );
    }

    this.ensureMeshId(meshId);
    await this.state.storage.put("meshId", meshId);

    const agentId = claims.sub;

    // Membership check against D1 (authoritative)
    let displayName = agentId;
    try {
      const db = new Db(this.env.PM_DB);
      const agent = await db.getAgent(agentId);
      if (!agent) {
        return jsonError("not_found", "Agent not registered", 404);
      }
      if (agent.mesh_id !== meshId) {
        return jsonError(
          "not_a_member",
          "Agent is not a member of this mesh",
          403,
        );
      }
      displayName = agent.display_name;
      this.putAgentCard(agentToCard(agent));
      this.members.add(agent.id);
      try {
        await db.updateLastSeen(agentId);
      } catch {
        /* best-effort */
      }
    } catch (e) {
      console.error("MeshDO membership check failed", e);
      return jsonError(
        "unavailable",
        "Membership check failed; try again",
        503,
      );
    }

    const existing = this.sessions.get(agentId);
    if (!existing && this.sessions.size >= MAX_SESSIONS) {
      return jsonError(
        "mesh_full",
        `Mesh has reached the maximum of ${MAX_SESSIONS} concurrent sessions`,
        503,
      );
    }

    // Replace existing session — SPEC requires 4000 replaced (not 1000)
    if (existing) {
      this.sessions.delete(agentId);
      try {
        existing.close(4000, "replaced");
      } catch {
        /* ignore */
      }
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    const attachment: WsAttachment = {
      v: ATTACHMENT_VERSION,
      agentId,
      meshId,
      tokenExp: claims.exp,
      displayName,
      warnedExpiring: false,
    };

    this.state.acceptWebSocket(server, [agentId, meshId]);
    this.writeAttachment(server, attachment);
    this.sessions.set(agentId, server);
    this.members.add(agentId);
    this.idleSince = null;

    const existingCard = this.agentCards.get(agentId);
    if (!existingCard) {
      this.putAgentCard({
        id: agentId,
        display_name: displayName,
        capabilities: [],
        last_seen: nowIso(),
        mesh_id: meshId,
      });
    } else {
      existingCard.last_seen = nowIso();
      existingCard.display_name = displayName;
      existingCard.mesh_id = meshId;
      this.putAgentCard(existingCard);
    }

    await this.persistMeta();

    sendJson(server, buildMeshJoined(meshId, this.collectMemberCards()));
    this.maybeWarnTokenExpiry(server, attachment);
    await this.scheduleNextAlarm();

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  private maybeWarnTokenExpiry(ws: WebSocket, att: WsAttachment): void {
    const payload: JWTPayload = {
      sub: att.agentId,
      mesh: att.meshId,
      exp: att.tokenExp,
    };
    if (!tokenExpiringSoon(payload, TOKEN_WARN_SEC) || att.warnedExpiring) {
      return;
    }
    const remaining = secondsUntilExpiry(payload);
    const expiresAt = new Date(att.tokenExp * 1000).toISOString();
    sendJson(ws, buildTokenExpiring(expiresAt, remaining));
    att.warnedExpiring = true;
    this.writeAttachment(ws, att);
  }

  /**
   * Single alarm multiplex: token warn/sweep, orphan tasks, idle cleanup.
   */
  private async scheduleNextAlarm(): Promise<void> {
    const now = Date.now();
    let next: number | null = null;

    const consider = (t: number) => {
      if (!Number.isFinite(t)) return;
      const at = t <= now ? now + 1 : t;
      if (next === null || at < next) next = at;
    };

    for (const ws of this.sessions.values()) {
      const att = this.readAttachment(ws);
      if (!att) continue;
      consider(att.tokenExp * 1000);
      if (!att.warnedExpiring) {
        consider((att.tokenExp - TOKEN_WARN_SEC) * 1000);
      }
    }

    if (this.sessions.size > 0 || this.tasks.size > 0) {
      consider(now + SWEEP_INTERVAL_MS);
    }

    if (this.sessions.size === 0) {
      const idleAt = (this.idleSince ?? now) + IDLE_CLEANUP_MS;
      consider(idleAt);
    }

    if (next !== null) {
      await this.state.storage.setAlarm(next);
    }
  }

  async alarm(): Promise<void> {
    const now = Date.now();

    // Token sweep: close expired sockets; warn soon-to-expire
    for (const [agentId, ws] of [...this.sessions.entries()]) {
      const att = this.readAttachment(ws);
      if (!att) continue;
      if (att.tokenExp * 1000 <= now) {
        try {
          ws.close(4001, "token_expired");
        } catch {
          /* ignore */
        }
        this.removeSession(agentId);
        continue;
      }
      this.maybeWarnTokenExpiry(ws, att);
    }

    await this.failOrphanTasks(now);

    // Idle cleanup when no sessions for ≥10 minutes
    if (
      this.sessions.size === 0 &&
      this.idleSince !== null &&
      now - this.idleSince >= IDLE_CLEANUP_MS
    ) {
      await this.persistMeta();
      for (const [taskId] of [...this.tasks.entries()]) {
        this.tasks.delete(taskId);
      }
    }

    await this.scheduleNextAlarm();
  }

  private async failOrphanTasks(now: number): Promise<void> {
    const timeoutMs = TASK_TIMEOUT_SEC * 1000;
    const timedOut: { taskId: string; entry: TaskRouteEntry }[] = [];

    for (const [taskId, entry] of this.tasks.entries()) {
      const age = now - entry.createdAt;
      const bothOffline =
        !this.sessions.has(entry.submitter) &&
        !this.sessions.has(entry.target);
      if (age > timeoutMs || (bothOffline && age > timeoutMs)) {
        timedOut.push({ taskId, entry });
      }
    }

    for (const { taskId, entry } of timedOut) {
      const submitterWs = this.sessions.get(entry.submitter);
      if (submitterWs) {
        sendJson(submitterWs, {
          type: "task.failed",
          task_id: taskId,
          error: "timeout",
        });
      }
      this.tasks.delete(taskId);

      if (this.meshId) {
        try {
          const db = new Db(this.env.PM_DB);
          await db.logEnvelope({
            mesh_id: this.meshId,
            from_agent: entry.target || entry.submitter,
            to_agent: entry.submitter,
            capability: "",
            task_id: taskId,
            type: "failed",
            payload_size: 0,
          });
        } catch {
          /* best-effort */
        }
      }
    }
  }

  // ─── Hibernation WebSocket handlers ───────────────────────────────────────

  async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    const att = this.readAttachment(ws);
    if (!att) {
      try {
        ws.close(1011, "missing_attachment");
      } catch {
        /* ignore */
      }
      return;
    }

    this.sessions.set(att.agentId, ws);
    this.ensureMeshId(att.meshId);

    // Reject binary frames (SPEC §3.3 / §5.8)
    if (typeof message !== "string") {
      try {
        ws.close(1003, "unsupported_data");
      } catch {
        /* ignore */
      }
      return;
    }

    // Reject oversized payloads
    const byteLen = new TextEncoder().encode(message).byteLength;
    if (byteLen > MAX_WS_MESSAGE_BYTES) {
      sendError(ws, "payload_too_large", "Message exceeds 256KiB limit");
      return;
    }

    // Token expiry
    if (att.tokenExp * 1000 <= Date.now()) {
      try {
        ws.close(4001, "token_expired");
      } catch {
        /* ignore */
      }
      this.removeSession(att.agentId);
      await this.scheduleNextAlarm();
      return;
    }

    this.maybeWarnTokenExpiry(ws, att);

    const inbound: WsInboundMessage | ErrorMessage =
      parseInboundMessage(message);

    const ctx = this.makeContext();
    try {
      await handleInboundMessage(
        ctx,
        att.agentId,
        ws,
        inbound,
        this.tasks,
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Internal routing error";
      sendError(ws, "internal_error", msg);
    }

    if (this.tasks.size > 0) {
      await this.scheduleNextAlarm();
    }
  }

  async webSocketClose(
    ws: WebSocket,
    _code: number,
    _reason: string,
    _wasClean: boolean,
  ): Promise<void> {
    const att = this.readAttachment(ws);
    const agentId = att?.agentId;
    if (agentId) {
      if (this.sessions.get(agentId) === ws) {
        this.removeSession(agentId);
      }
      const card = this.agentCards.get(agentId);
      if (card) {
        card.last_seen = nowIso();
      }
      // Do NOT remove from members / D1 — disconnect ≠ leave
      try {
        const db = new Db(this.env.PM_DB);
        await db.updateLastSeen(agentId);
      } catch {
        /* ignore */
      }
      await this.persistMeta();
    }
    await this.scheduleNextAlarm();
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    console.error("MeshDO webSocketError", error);
    const att = this.readAttachment(ws);
    if (att?.agentId && this.sessions.get(att.agentId) === ws) {
      this.removeSession(att.agentId);
      try {
        const db = new Db(this.env.PM_DB);
        await db.updateLastSeen(att.agentId);
      } catch {
        /* ignore */
      }
      await this.persistMeta();
      await this.scheduleNextAlarm();
    }
  }
}

/** Helper used by the Worker to resolve the DO stub for a mesh */
export function getMeshStub(
  env: Env,
  meshId: string,
): DurableObjectStub {
  const id = env.MESH_DO.idFromName(meshId);
  return env.MESH_DO.get(id);
}

export {
  RING_CAPACITY,
  MAX_SESSIONS,
  MAX_AGENT_CARDS,
  MAX_TASKS,
  MAX_WS_MESSAGE_BYTES,
  TASK_TIMEOUT_SEC,
  generateId,
};
