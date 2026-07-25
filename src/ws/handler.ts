/**
 * WebSocket message router — parses inbound JSON and produces outbound routes.
 * Permission enforcement is LOCAL (agents decide); gateway is a blind router.
 */

import type {
  AgentCard,
  Capability,
  Envelope,
  EnvelopeLogType,
  ErrorMessage,
  MeshJoinedMessage,
  TokenExpiringMessage,
  WsInboundMessage,
  WsOutboundMessage,
} from "../types";
import { generateId, nowIso } from "../utils";

const MAX_WS_MESSAGE_BYTES = 256 * 1024;
const TASK_ID_MIN = 1;
const TASK_ID_MAX = 128;

const TERMINAL_STATES = new Set(["completed", "failed"]);

// ─── Session / routing result (kept for unit tests) ───────────────────────────

export interface SessionContext {
  agentId: string;
  meshId: string;
  tokenExp: number; // unix seconds
}

export interface RouteResult {
  /** Messages to send to the originating agent */
  reply?: WsOutboundMessage[];
  /** Messages to forward to a specific peer */
  forward?: { to: string; message: WsOutboundMessage }[];
  /** Update local card cache */
  cardUpdate?: { agentId: string; capabilities: Capability[] };
  /** Append to recent envelope ring buffer + D1 audit */
  envelope?: Envelope;
  /** Close this agent's socket after handling */
  close?: { code: number; reason: string };
}

export type TaskRouteState =
  | "submitted"
  | "accepted"
  | "progress"
  | "completed"
  | "failed";

export interface TaskRouteEntry {
  submitter: string;
  target: string;
  createdAt: number;
  state: TaskRouteState;
}

/** In-memory task_id → route mapping used by MeshDO */
export interface TaskRoutingTable {
  get(taskId: string): TaskRouteEntry | undefined;
  set(taskId: string, entry: TaskRouteEntry): void;
  delete(taskId: string): void;
  hasActive(taskId: string): boolean;
  entries(): IterableIterator<[string, TaskRouteEntry]>;
  readonly size: number;
}

/** Session-facing surface implemented by MeshDO */
export interface WsMeshContext {
  meshId: string;
  getSession(agentId: string): WebSocket | undefined;
  getAllSessions(): Map<string, WebSocket>;
  getAgentCard(agentId: string): AgentCard | undefined;
  getMemberCards(): AgentCard[];
  setAgentCapabilities(agentId: string, capabilities: Capability[]): void;
  pushEnvelope(envelope: Envelope): void;
  logEnvelope(input: {
    from_agent: string;
    to_agent?: string | null;
    capability: string;
    task_id?: string | null;
    type: EnvelopeLogType | string;
    payload_size?: number | null;
  }): Promise<void>;
  closeSession(agentId: string, code?: number, reason?: string): void;
}

export interface RouterDeps {
  /** Resolve which agent originally submitted a task (for lifecycle replies) */
  getTaskSubmitter: (taskId: string) => string | undefined;
  /** Record submitter for a new task */
  setTaskSubmitter: (taskId: string, fromAgentId: string) => void;
  /** Is target currently connected? */
  isOnline: (agentId: string) => boolean;
  /** Current members as cards (for leave broadcasts etc.) */
  getMemberCards?: () => AgentCard[];
  /** Reject submit when task_id is already active (non-terminal) */
  hasActiveTask?: (taskId: string) => boolean;
  /** Full route mapping including target */
  setTaskRoute?: (
    taskId: string,
    route: { submitter: string; target: string },
  ) => void;
  /** Update lifecycle state */
  setTaskState?: (taskId: string, state: TaskRouteState) => void;
  /** Clear mapping on terminal complete/fail */
  clearTask?: (taskId: string) => void;
}

function err(code: string, message: string): ErrorMessage {
  return { type: "error", code, message };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isValidTaskId(taskId: unknown): taskId is string {
  return (
    typeof taskId === "string" &&
    taskId.length >= TASK_ID_MIN &&
    taskId.length <= TASK_ID_MAX
  );
}

// ─── Builders / send helpers (MeshDO) ─────────────────────────────────────────

export function buildMeshJoined(
  meshId: string,
  members: AgentCard[],
): MeshJoinedMessage {
  return { type: "mesh.joined", mesh_id: meshId, members };
}

export function buildTokenExpiring(
  expiresAt: string,
  secondsRemaining: number,
): TokenExpiringMessage {
  return {
    type: "token.expiring",
    expires_at: expiresAt,
    seconds_remaining: Math.max(0, secondsRemaining),
  };
}

export function sendJson(ws: WebSocket, msg: WsOutboundMessage): void {
  try {
    ws.send(JSON.stringify(msg));
  } catch {
    // Socket may already be closing
  }
}

export function sendError(ws: WebSocket, code: string, message: string): void {
  sendJson(ws, err(code, message));
}

export function createTaskRoutingTable(): TaskRoutingTable {
  const map = new Map<string, TaskRouteEntry>();
  return {
    get: (taskId) => map.get(taskId),
    set: (taskId, entry) => {
      map.set(taskId, entry);
    },
    delete: (taskId) => {
      map.delete(taskId);
    },
    hasActive: (taskId) => {
      const entry = map.get(taskId);
      return !!entry && !TERMINAL_STATES.has(entry.state);
    },
    entries: () => map.entries(),
    get size() {
      return map.size;
    },
  };
}

// ─── Parse ────────────────────────────────────────────────────────────────────

/**
 * Parse an inbound WS frame. Accepts text frames (`string`) only.
 * Binary frames (`ArrayBuffer`) are rejected per SPEC §5.
 */
export function parseInboundMessage(
  raw: string | ArrayBuffer,
): WsInboundMessage | ErrorMessage {
  if (typeof raw !== "string") {
    return err("invalid_message", "Binary frames are not supported");
  }
  if (raw.length > MAX_WS_MESSAGE_BYTES) {
    return err(
      "payload_too_large",
      `Message exceeds ${MAX_WS_MESSAGE_BYTES} bytes`,
    );
  }

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return err("invalid_json", "Message must be valid JSON");
  }
  if (!isObject(data) || typeof data.type !== "string") {
    return err("invalid_message", "Message must include a string type");
  }

  switch (data.type) {
    case "ping":
      return { type: "ping" };

    case "card.announce": {
      if (!Array.isArray(data.capabilities)) {
        return err("invalid_message", "capabilities must be an array");
      }
      return {
        type: "card.announce",
        capabilities: data.capabilities as Capability[],
      };
    }

    case "task.submit": {
      if (typeof data.target !== "string" || !data.target) {
        return err("invalid_message", "target is required");
      }
      if (typeof data.capability !== "string" || !data.capability) {
        return err("invalid_message", "capability is required");
      }
      if (!isValidTaskId(data.task_id)) {
        return err(
          "invalid_message",
          "task_id must be a string of length 1-128",
        );
      }
      return {
        type: "task.submit",
        target: data.target,
        capability: data.capability,
        payload: data.payload,
        task_id: data.task_id,
      };
    }

    case "task.accept": {
      if (typeof data.task_id !== "string" || !data.task_id) {
        return err("invalid_message", "task_id is required");
      }
      return { type: "task.accept", task_id: data.task_id };
    }

    case "task.progress": {
      if (typeof data.task_id !== "string" || !data.task_id) {
        return err("invalid_message", "task_id is required");
      }
      if (
        typeof data.progress !== "number" ||
        !Number.isFinite(data.progress) ||
        data.progress < 0 ||
        data.progress > 1
      ) {
        return err(
          "invalid_message",
          "progress must be a finite number in [0, 1]",
        );
      }
      return {
        type: "task.progress",
        task_id: data.task_id,
        progress: data.progress,
        message: typeof data.message === "string" ? data.message : undefined,
      };
    }

    case "task.complete": {
      if (typeof data.task_id !== "string" || !data.task_id) {
        return err("invalid_message", "task_id is required");
      }
      return {
        type: "task.complete",
        task_id: data.task_id,
        result: data.result,
      };
    }

    case "task.fail": {
      if (typeof data.task_id !== "string" || !data.task_id) {
        return err("invalid_message", "task_id is required");
      }
      if (typeof data.error !== "string") {
        return err("invalid_message", "error is required");
      }
      return {
        type: "task.fail",
        task_id: data.task_id,
        error: data.error,
      };
    }

    case "mesh.leave":
      return { type: "mesh.leave" };

    default:
      return err("unknown_type", `Unknown message type: ${data.type}`);
  }
}

// ─── Route ────────────────────────────────────────────────────────────────────

/**
 * Route a single inbound WS message for an authenticated session.
 */
export function routeWsMessage(
  ctx: SessionContext,
  message: WsInboundMessage,
  deps: RouterDeps,
): RouteResult {
  switch (message.type) {
    case "ping":
      return { reply: [{ type: "pong", ts: nowIso() }] };

    case "card.announce": {
      const envelope: Envelope = {
        id: generateId(),
        mesh_id: ctx.meshId,
        from: ctx.agentId,
        type: "announce",
        ts: nowIso(),
      };
      return {
        reply: [{ type: "card.registered", agent_id: ctx.agentId }],
        cardUpdate: {
          agentId: ctx.agentId,
          capabilities: message.capabilities,
        },
        envelope,
      };
    }

    case "task.submit": {
      if (message.target === ctx.agentId) {
        return {
          reply: [err("invalid_target", "Cannot submit a task to yourself")],
        };
      }
      if (!deps.isOnline(message.target)) {
        return {
          reply: [
            err(
              "target_offline",
              `Target agent is not connected: ${message.target}`,
            ),
          ],
        };
      }
      if (deps.hasActiveTask?.(message.task_id)) {
        return {
          reply: [
            err(
              "duplicate_task_id",
              `Active task already exists for task_id: ${message.task_id}`,
            ),
          ],
        };
      }

      if (deps.setTaskRoute) {
        deps.setTaskRoute(message.task_id, {
          submitter: ctx.agentId,
          target: message.target,
        });
      } else {
        deps.setTaskSubmitter(message.task_id, ctx.agentId);
      }

      const forwardMsg: WsOutboundMessage = {
        type: "task.submit",
        from: ctx.agentId,
        capability: message.capability,
        payload: message.payload,
        task_id: message.task_id,
      };
      const envelope: Envelope = {
        id: generateId(),
        mesh_id: ctx.meshId,
        from: ctx.agentId,
        to: message.target,
        type: "submit",
        capability: message.capability,
        task_id: message.task_id,
        payload: message.payload,
        ts: nowIso(),
      };
      return {
        forward: [{ to: message.target, message: forwardMsg }],
        envelope,
      };
    }

    case "task.accept": {
      const submitter = deps.getTaskSubmitter(message.task_id);
      if (!submitter) {
        return {
          reply: [err("unknown_task", `Unknown task_id: ${message.task_id}`)],
        };
      }
      if (!deps.isOnline(submitter)) {
        return {
          reply: [err("submitter_offline", "Task submitter is offline")],
        };
      }
      deps.setTaskState?.(message.task_id, "accepted");
      return {
        forward: [
          {
            to: submitter,
            message: { type: "task.accepted", task_id: message.task_id },
          },
        ],
        envelope: {
          id: generateId(),
          mesh_id: ctx.meshId,
          from: ctx.agentId,
          to: submitter,
          type: "accepted",
          task_id: message.task_id,
          ts: nowIso(),
        },
      };
    }

    case "task.progress": {
      const submitter = deps.getTaskSubmitter(message.task_id);
      if (!submitter) {
        return {
          reply: [err("unknown_task", `Unknown task_id: ${message.task_id}`)],
        };
      }
      if (!deps.isOnline(submitter)) {
        return { reply: [] }; // drop progress if submitter gone
      }
      deps.setTaskState?.(message.task_id, "progress");
      const out: WsOutboundMessage = {
        type: "task.progress",
        task_id: message.task_id,
        progress: message.progress,
        message: message.message,
      };
      return {
        forward: [{ to: submitter, message: out }],
        envelope: {
          id: generateId(),
          mesh_id: ctx.meshId,
          from: ctx.agentId,
          to: submitter,
          type: "progress",
          task_id: message.task_id,
          ts: nowIso(),
        },
      };
    }

    case "task.complete": {
      const submitter = deps.getTaskSubmitter(message.task_id);
      if (!submitter) {
        return {
          reply: [err("unknown_task", `Unknown task_id: ${message.task_id}`)],
        };
      }
      const result: RouteResult = {
        envelope: {
          id: generateId(),
          mesh_id: ctx.meshId,
          from: ctx.agentId,
          to: submitter,
          type: "completed",
          task_id: message.task_id,
          payload: message.result,
          ts: nowIso(),
        },
      };
      if (deps.isOnline(submitter)) {
        result.forward = [
          {
            to: submitter,
            message: {
              type: "task.completed",
              task_id: message.task_id,
              result: message.result,
            },
          },
        ];
      } else {
        result.reply = [err("submitter_offline", "Task submitter is offline")];
      }
      deps.clearTask?.(message.task_id);
      return result;
    }

    case "task.fail": {
      const submitter = deps.getTaskSubmitter(message.task_id);
      if (!submitter) {
        return {
          reply: [err("unknown_task", `Unknown task_id: ${message.task_id}`)],
        };
      }
      const result: RouteResult = {
        envelope: {
          id: generateId(),
          mesh_id: ctx.meshId,
          from: ctx.agentId,
          to: submitter,
          type: "failed",
          task_id: message.task_id,
          ts: nowIso(),
        },
      };
      if (deps.isOnline(submitter)) {
        result.forward = [
          {
            to: submitter,
            message: {
              type: "task.failed",
              task_id: message.task_id,
              error: message.error,
            },
          },
        ];
      }
      deps.clearTask?.(message.task_id);
      return result;
    }

    case "mesh.leave": {
      return {
        envelope: {
          id: generateId(),
          mesh_id: ctx.meshId,
          from: ctx.agentId,
          type: "leave",
          ts: nowIso(),
        },
        close: { code: 1000, reason: "mesh.leave" },
      };
    }

    default: {
      // Exhaustiveness
      const _never: never = message;
      void _never;
      return { reply: [err("unknown_type", "Unhandled message type")] };
    }
  }
}

export function payloadSize(payload: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(payload ?? null)).length;
  } catch {
    return 0;
  }
}

// ─── Apply route results (MeshDO entry) ───────────────────────────────────────

function depsFromTasks(
  ctx: WsMeshContext,
  tasks: TaskRoutingTable,
): RouterDeps {
  return {
    getTaskSubmitter: (taskId) => tasks.get(taskId)?.submitter,
    setTaskSubmitter: (taskId, fromAgentId) => {
      const existing = tasks.get(taskId);
      if (existing) {
        tasks.set(taskId, { ...existing, submitter: fromAgentId });
      } else {
        tasks.set(taskId, {
          submitter: fromAgentId,
          target: "",
          createdAt: Date.now(),
          state: "submitted",
        });
      }
    },
    isOnline: (agentId) => ctx.getSession(agentId) !== undefined,
    getMemberCards: () => ctx.getMemberCards(),
    hasActiveTask: (taskId) => tasks.hasActive(taskId),
    setTaskRoute: (taskId, route) => {
      tasks.set(taskId, {
        submitter: route.submitter,
        target: route.target,
        createdAt: Date.now(),
        state: "submitted",
      });
    },
    setTaskState: (taskId, state) => {
      const existing = tasks.get(taskId);
      if (!existing) return;
      tasks.set(taskId, { ...existing, state });
    },
    clearTask: (taskId) => {
      tasks.delete(taskId);
    },
  };
}

async function applyRouteResult(
  ctx: WsMeshContext,
  agentId: string,
  ws: WebSocket,
  result: RouteResult,
): Promise<void> {
  if (result.cardUpdate) {
    ctx.setAgentCapabilities(
      result.cardUpdate.agentId,
      result.cardUpdate.capabilities,
    );
  }

  if (result.envelope) {
    ctx.pushEnvelope(result.envelope);
    await ctx.logEnvelope({
      from_agent: result.envelope.from,
      to_agent: result.envelope.to ?? null,
      capability: result.envelope.capability ?? "",
      task_id: result.envelope.task_id ?? null,
      type: result.envelope.type,
      payload_size: payloadSize(result.envelope.payload),
    });
  }

  if (result.reply) {
    for (const msg of result.reply) {
      sendJson(ws, msg);
    }
  }

  if (result.forward) {
    for (const item of result.forward) {
      const peer = ctx.getSession(item.to);
      if (peer) {
        sendJson(peer, item.message);
      }
    }
  }

  if (result.close) {
    ctx.closeSession(agentId, result.close.code, result.close.reason);
  }
}

/**
 * Full inbound path used by MeshDO: parse errors, ping/pong, route, apply.
 */
export async function handleInboundMessage(
  ctx: WsMeshContext,
  agentId: string,
  ws: WebSocket,
  inbound: WsInboundMessage | ErrorMessage,
  tasks: TaskRoutingTable,
): Promise<void> {
  if (inbound.type === "error") {
    sendJson(ws, inbound);
    return;
  }

  if (inbound.type === "ping") {
    sendJson(ws, { type: "pong", ts: nowIso() });
    return;
  }

  const session: SessionContext = {
    agentId,
    meshId: ctx.meshId,
    tokenExp: 0,
  };

  const result = routeWsMessage(session, inbound, depsFromTasks(ctx, tasks));
  await applyRouteResult(ctx, agentId, ws, result);
}
