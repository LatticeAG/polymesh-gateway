/**
 * WebSocket message type definitions (agent ↔ gateway), both directions.
 * Re-exported from src/types.ts for shared use.
 */

import type { AgentCard, Capability } from "../types";

// ─── Agent → Gateway ──────────────────────────────────────────────────────────

export interface CardAnnounceMessage {
  type: "card.announce";
  capabilities: Capability[];
}

export interface TaskSubmitOutbound {
  type: "task.submit";
  target: string;
  capability: string;
  payload?: unknown;
  task_id: string;
}

export interface TaskAcceptMessage {
  type: "task.accept";
  task_id: string;
}

export interface TaskProgressOutbound {
  type: "task.progress";
  task_id: string;
  progress: number;
  message?: string;
}

export interface TaskCompleteMessage {
  type: "task.complete";
  task_id: string;
  result?: unknown;
}

export interface TaskFailMessage {
  type: "task.fail";
  task_id: string;
  error: string;
}

export interface MeshLeaveMessage {
  type: "mesh.leave";
}

export interface PingMessage {
  type: "ping";
}

export type WsInboundMessage =
  | CardAnnounceMessage
  | TaskSubmitOutbound
  | TaskAcceptMessage
  | TaskProgressOutbound
  | TaskCompleteMessage
  | TaskFailMessage
  | MeshLeaveMessage
  | PingMessage;

// ─── Gateway → Agent ──────────────────────────────────────────────────────────

export interface CardRegisteredMessage {
  type: "card.registered";
  agent_id: string;
}

export interface MeshJoinedMessage {
  type: "mesh.joined";
  mesh_id: string;
  members: AgentCard[];
}

export interface TaskSubmitInbound {
  type: "task.submit";
  from: string;
  capability: string;
  payload?: unknown;
  task_id: string;
}

export interface TaskAcceptedMessage {
  type: "task.accepted";
  task_id: string;
}

export interface TaskProgressInbound {
  type: "task.progress";
  task_id: string;
  progress: number;
  message?: string;
}

export interface TaskCompletedMessage {
  type: "task.completed";
  task_id: string;
  result?: unknown;
}

export interface TaskFailedMessage {
  type: "task.failed";
  task_id: string;
  error: string;
}

export interface ErrorMessage {
  type: "error";
  code: string;
  message: string;
}

export interface TokenExpiringMessage {
  type: "token.expiring";
  expires_at: string;
  seconds_remaining: number;
}

export interface PongMessage {
  type: "pong";
  ts: string;
}

export type WsOutboundMessage =
  | CardRegisteredMessage
  | MeshJoinedMessage
  | TaskSubmitInbound
  | TaskAcceptedMessage
  | TaskProgressInbound
  | TaskCompletedMessage
  | TaskFailedMessage
  | ErrorMessage
  | TokenExpiringMessage
  | PongMessage;
