/** PolyMesh Gateway — shared helpers */

import type { ApiErrorBody } from "./types";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
};

export function generateId(): string {
  return crypto.randomUUID();
}

/** Invite code like FRIENDS-ABC123 */
export function generateInviteCode(prefix = "MESH"): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  let suffix = "";
  for (let i = 0; i < 6; i++) {
    suffix += alphabet[bytes[i]! % alphabet.length];
  }
  const clean = prefix
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 12);
  return `${clean || "MESH"}-${suffix}`;
}

export interface GeneratedApiKey {
  apiKey: string;
  keyId: string;
  secret: string;
}

/** Format: pmgk_<key_id>_<secret> */
export function generateApiKey(): GeneratedApiKey {
  const keyId = toBase62(crypto.getRandomValues(new Uint8Array(9)));
  const secret = toBase62(crypto.getRandomValues(new Uint8Array(24)));
  return {
    apiKey: `pmgk_${keyId}_${secret}`,
    keyId,
    secret,
  };
}

function toBase62(bytes: Uint8Array): string {
  const alphabet =
    "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  let out = "";
  for (const b of bytes) {
    out += alphabet[b % 62]!;
  }
  return out;
}

/** Parse pmgk_<keyId>_<secret>; returns null if malformed */
export function parseApiKey(
  apiKey: string,
): { keyId: string; secret: string } | null {
  if (!apiKey || typeof apiKey !== "string") return null;
  const parts = apiKey.split("_");
  if (parts.length !== 3 || parts[0] !== "pmgk") return null;
  const keyId = parts[1];
  const secret = parts[2];
  if (!keyId || !secret) return null;
  return { keyId, secret };
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function slugifyDisplayName(displayName: string): string {
  const slug = displayName
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "agent";
}

/** Prefer alice@latticeag style ids */
export function makeAgentId(displayName: string, suffix?: string): string {
  const base = slugifyDisplayName(displayName);
  return suffix ? `${base}-${suffix}@latticeag` : `${base}@latticeag`;
}

export function jsonResponse(
  data: unknown,
  status = 200,
  extraHeaders?: HeadersInit,
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...CORS_HEADERS,
      ...Object.fromEntries(new Headers(extraHeaders).entries()),
    },
  });
}

export function errorResponse(
  code: string,
  message: string,
  status: number,
): Response {
  const body: ApiErrorBody = { error: { code, message } };
  return jsonResponse(body, status);
}

export function corsHeaders(): Record<string, string> {
  return { ...CORS_HEADERS };
}

export function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(CORS_HEADERS)) {
    headers.set(k, v);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export async function parseJsonBody<T>(request: Request): Promise<T> {
  const text = await request.text();
  if (!text) {
    throw Object.assign(new Error("Request body is required"), {
      code: "bad_request",
      status: 400,
    });
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw Object.assign(new Error("Invalid JSON body"), {
      code: "bad_request",
      status: 400,
    });
  }
}

/** Simple in-memory sliding-window rate limiter (per isolate). */
export class RateLimiter {
  private hits = new Map<string, number[]>();

  check(agentId: string, limitPerMinute: number): boolean {
    const now = Date.now();
    const windowMs = 60_000;
    const cutoff = now - windowMs;
    const prev = this.hits.get(agentId) ?? [];
    const recent = prev.filter((t) => t > cutoff);
    if (recent.length >= limitPerMinute) {
      this.hits.set(agentId, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(agentId, recent);
    return true;
  }

  reset(agentId?: string): void {
    if (agentId) this.hits.delete(agentId);
    else this.hits.clear();
  }
}

export const globalRateLimiter = new RateLimiter();

export function getRateLimit(env: { RATE_LIMIT_PER_MINUTE?: string }): number {
  const n = Number(env.RATE_LIMIT_PER_MINUTE ?? "100");
  return Number.isFinite(n) && n > 0 ? n : 100;
}
