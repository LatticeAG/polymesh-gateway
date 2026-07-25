/** POST /api/v1/auth/token — API key → JWT exchange */

import {
  formatStoredHash,
  issueJwt,
  parseStoredHash,
  verifyApiKey,
} from "../auth";
import { Db } from "../db/schema";
import type { Env, TokenRequest, TokenResponse } from "../types";
import {
  errorResponse,
  globalRateLimiter,
  jsonResponse,
  parseApiKey,
  parseJsonBody,
} from "../utils";

/** Spec §6.6: token endpoint uses stricter 20/min/key_id */
const TOKEN_RATE_LIMIT = 20;

// re-export for tests that may poke storage format
export { formatStoredHash, parseStoredHash };

export async function handleTokenExchange(
  request: Request,
  env: Env,
): Promise<Response> {
  if (!env.JWT_SECRET) {
    return errorResponse(
      "misconfigured",
      "JWT_SECRET is not configured",
      500,
    );
  }

  let body: TokenRequest;
  try {
    body = await parseJsonBody<TokenRequest>(request);
  } catch (e) {
    const err = e as { message?: string; status?: number; code?: string };
    return errorResponse(
      err.code ?? "bad_request",
      err.message ?? "Invalid body",
      err.status ?? 400,
    );
  }

  if (!body.api_key || typeof body.api_key !== "string") {
    return errorResponse("bad_request", "api_key is required", 400);
  }

  const parsed = parseApiKey(body.api_key);
  if (!parsed) {
    return errorResponse(
      "invalid_api_key",
      "API key must be pmgk_<key_id>_<secret>",
      401,
    );
  }

  if (!globalRateLimiter.check(`token:${parsed.keyId}`, TOKEN_RATE_LIMIT)) {
    return errorResponse(
      "rate_limited",
      "Too many token requests for this API key",
      429,
    );
  }

  const db = new Db(env.PM_DB);
  const agent = await db.getAgentByKeyId(parsed.keyId);
  if (!agent) {
    return errorResponse("invalid_api_key", "Invalid API key", 401);
  }

  const ok = await verifyApiKey(body.api_key, agent.api_key_hash);
  if (!ok) {
    return errorResponse("invalid_api_key", "Invalid API key", 401);
  }

  const { token, expires_at } = await issueJwt(
    { sub: agent.id, mesh: agent.mesh_id },
    env.JWT_SECRET,
    3600,
  );

  try {
    await db.updateLastSeen(agent.id);
  } catch {
    /* best-effort */
  }

  const res: TokenResponse = { token, expires_at };
  return jsonResponse(res);
}
