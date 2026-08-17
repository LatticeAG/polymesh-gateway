/** Agent registration + card lookup */

import {
  formatStoredHash,
  hashApiKey,
} from "../auth";
import { Db, agentToCard } from "../db/schema";
import type {
  Capability,
  CreateAgentRequest,
  CreateAgentResponse,
  Env,
} from "../types";
import {
  errorResponse,
  generateApiKey,
  generateId,
  generateInviteCode,
  jsonResponse,
  makeAgentId,
  parseJsonBody,
} from "../utils";

/** Constant-time string comparison to avoid timing leaks. */
function constantTimeCompare(a: string, b: string): boolean {
  let mismatch = a.length !== b.length ? 1 : 0;
  const maxLen = Math.max(a.length, b.length);
  for (let i = 0; i < maxLen; i++) {
    const aCode = i < a.length ? a.charCodeAt(i) : 0;
    const bCode = i < b.length ? b.charCodeAt(i) : 0;
    mismatch |= aCode ^ bCode;
  }
  return mismatch === 0;
}

/**
 * Normalize the capabilities field of an agent-creation request into the
 * Capability[] shape stored on the AgentCard (SPEC §9). Accepts both the
 * canonical object form ({name, schema?, scope?, security?}) and plain
 * strings ("echo" -> {name: "echo"}) for ergonomics. Unparseable entries
 * are dropped.
 */
function normalizeCapabilities(raw: unknown): Capability[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: Capability[] = [];
  for (const entry of raw) {
    if (typeof entry === "string" && entry.trim()) {
      out.push({ name: entry.trim().slice(0, 128) });
    } else if (
      entry &&
      typeof entry === "object" &&
      typeof (entry as { name?: unknown }).name === "string" &&
      (entry as { name: string }).name.trim()
    ) {
      const name = (entry as { name: string }).name.trim().slice(0, 128);
      const cap: Capability = { name };
      if (typeof (entry as { schema?: unknown }).schema !== "undefined") {
        cap.schema = (entry as { schema?: unknown }).schema;
      }
      if (typeof (entry as { scope?: unknown }).scope === "string") {
        cap.scope = (entry as { scope: string }).scope;
      }
      if (typeof (entry as { security?: unknown }).security === "string") {
        cap.security = (entry as { security: string }).security;
      }
      out.push(cap);
    }
  }
  return out;
}

export async function handleCreateAgent(
  request: Request,
  env: Env,
): Promise<Response> {
  let body: CreateAgentRequest;
  try {
    body = await parseJsonBody<CreateAgentRequest>(request);
  } catch (e) {
    const err = e as { message?: string; status?: number; code?: string };
    return errorResponse(
      err.code ?? "bad_request",
      err.message ?? "Invalid body",
      err.status ?? 400,
    );
  }

  if (!body.display_name || typeof body.display_name !== "string") {
    return errorResponse(
      "bad_request",
      "display_name is required",
      400,
    );
  }
  const displayName = body.display_name.trim();
  if (displayName.length < 1 || displayName.length > 128) {
    return errorResponse(
      "bad_request",
      "display_name must be 1–128 characters",
      400,
    );
  }

  if (env.GATEWAY_PSK && !constantTimeCompare(env.GATEWAY_PSK, body.psk ?? "")) {
    return errorResponse(
      "psk_required",
      "Gateway requires a pre-shared key. Set GATEWAY_PSK on the deployer side or pass the correct psk.",
      403,
    );
  }

  const db = new Db(env.PM_DB);
  let agentId = makeAgentId(displayName);
  if (await db.agentIdExists(agentId)) {
    agentId = makeAgentId(displayName, generateId().slice(0, 8));
  }

  const { apiKey, keyId } = generateApiKey();
  const bcryptHash = await hashApiKey(apiKey);
  const storedHash = formatStoredHash(keyId, bcryptHash);

  let meshId = body.mesh_id;

  if (meshId) {
    const mesh = await db.getMesh(meshId);
    if (!mesh) {
      return errorResponse("not_found", `Mesh not found: ${meshId}`, 404);
    }
  } else {
    // Personal mesh owned by this agent (chicken-egg: mesh before agent row)
    meshId = generateId();
    const meshName = `personal-${agentId.replace(/[^a-z0-9-]/gi, "-").slice(0, 40)}`;
    // Ensure unique mesh name
    let finalName = meshName;
    let n = 0;
    while (await db.getMeshByName(finalName)) {
      n += 1;
      finalName = `${meshName}-${n}`;
    }
    await db.createMesh({
      id: meshId,
      name: finalName,
      owner_agent_id: agentId,
      is_public: false,
    });
    await db.createInvite({
      code: generateInviteCode("PERSONAL"),
      mesh_id: meshId,
      max_uses: 0,
    });
  }

  try {
    await db.createAgent({
      id: agentId,
      mesh_id: meshId,
      display_name: displayName,
      api_key_hash: storedHash,
      capabilities: normalizeCapabilities(body.capabilities),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "create failed";
    if (msg.includes("UNIQUE") || msg.toLowerCase().includes("unique")) {
      return errorResponse("conflict", "Agent id already exists", 409);
    }
    throw e;
  }

  const res: CreateAgentResponse = {
    agent_id: agentId,
    api_key: apiKey,
    mesh_id: meshId,
  };
  return jsonResponse(res, 201);
}

export async function handleGetAgentCard(
  _request: Request,
  env: Env,
  agentId: string,
): Promise<Response> {
  const db = new Db(env.PM_DB);
  const agent = await db.getAgent(agentId);
  if (!agent) {
    return errorResponse("not_found", `Agent not found: ${agentId}`, 404);
  }
  return jsonResponse(agentToCard(agent));
}
