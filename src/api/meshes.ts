/** Mesh CRUD, invite codes, join, discovery */

import { extractBearerOrQueryToken, verifyApiKey, verifyJwt } from "../auth";
import { Db, agentToCard } from "../db/schema";
import type {
  AgentCard,
  Capability,
  CreateInviteRequest,
  CreateInviteResponse,
  CreateMeshRequest,
  CreateMeshResponse,
  Env,
  JoinMeshRequest,
  JoinMeshResponse,
  ListAgentsResponse,
} from "../types";
import {
  errorResponse,
  generateId,
  generateInviteCode,
  globalRateLimiter,
  jsonResponse,
  parseApiKey,
  parseJsonBody,
} from "../utils";

type CapabilityMatch = "exact" | "prefix" | "wildcard";

function matchCapabilityName(
  name: string,
  filter: string,
  mode: CapabilityMatch,
): boolean {
  switch (mode) {
    case "exact":
      return name === filter;
    case "prefix":
      return name.startsWith(filter);
    case "wildcard": {
      const escaped = filter
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*")
        .replace(/\?/g, ".");
      return new RegExp(`^${escaped}$`).test(name);
    }
    default: {
      const _exhaustive: never = mode;
      void _exhaustive;
      return false;
    }
  }
}

function filterAgents(
  agents: AgentCard[],
  opts: {
    capability?: string;
    capabilityMatch: CapabilityMatch;
    q?: string;
  },
): AgentCard[] {
  let out = agents;
  if (opts.capability) {
    const cap = opts.capability;
    const mode = opts.capabilityMatch;
    out = out.filter((a) =>
      a.capabilities.some((c: Capability) =>
        matchCapabilityName(c.name, cap, mode),
      ),
    );
  }
  if (opts.q) {
    const q = opts.q.toLowerCase();
    out = out.filter(
      (a) =>
        a.display_name.toLowerCase().includes(q) ||
        a.id.toLowerCase().includes(q),
    );
  }
  return out;
}

async function fetchOnlineSet(
  env: Env,
  meshId: string,
): Promise<Set<string> | null> {
  try {
    const stub = env.MESH_DO.get(env.MESH_DO.idFromName(meshId));
    const res = await stub.fetch(
      new Request("https://mesh-do/internal/status", { method: "GET" }),
    );
    if (!res.ok) return null;
    const body = (await res.json()) as { sessions?: string[] };
    return new Set(body.sessions ?? []);
  } catch {
    return null;
  }
}

export async function handleCreateMesh(
  request: Request,
  env: Env,
): Promise<Response> {
  let body: CreateMeshRequest;
  try {
    body = await parseJsonBody<CreateMeshRequest>(request);
  } catch (e) {
    const err = e as { message?: string; status?: number; code?: string };
    return errorResponse(
      err.code ?? "bad_request",
      err.message ?? "Invalid body",
      err.status ?? 400,
    );
  }

  if (!body.name || typeof body.name !== "string") {
    return errorResponse("bad_request", "name is required", 400);
  }
  if (!body.agent_id || typeof body.agent_id !== "string") {
    return errorResponse("bad_request", "agent_id is required", 400);
  }

  const name = body.name.trim();
  if (name.length < 1 || name.length > 64) {
    return errorResponse("bad_request", "name must be 1–64 characters", 400);
  }

  const db = new Db(env.PM_DB);
  const agent = await db.getAgent(body.agent_id);
  if (!agent) {
    return errorResponse("not_found", `Agent not found: ${body.agent_id}`, 404);
  }

  const existing = await db.getMeshByName(name);
  if (existing) {
    return errorResponse("conflict", `Mesh name already taken: ${name}`, 409);
  }

  const meshId = generateId();
  const inviteCode = generateInviteCode(
    name.replace(/[^a-zA-Z0-9]/g, "").slice(0, 12) || "MESH",
  );

  await db.createMesh({
    id: meshId,
    name,
    owner_agent_id: body.agent_id,
    is_public: !!body.is_public,
  });
  await db.createInvite({
    code: inviteCode,
    mesh_id: meshId,
    max_uses: 0,
  });
  await db.updateAgentMesh(body.agent_id, meshId);
  void notifyMeshDoMembership(env, meshId, body.agent_id);

  const res: CreateMeshResponse = {
    mesh_id: meshId,
    invite_code: inviteCode,
  };
  return jsonResponse(res, 201);
}

export async function handleListAgents(
  request: Request,
  env: Env,
  meshId: string,
): Promise<Response> {
  const db = new Db(env.PM_DB);
  const mesh = await db.getMesh(meshId);
  if (!mesh) {
    return errorResponse("not_found", `Mesh not found: ${meshId}`, 404);
  }

  const url = new URL(request.url);
  const capability = url.searchParams.get("capability") ?? undefined;
  const matchRaw = url.searchParams.get("capability_match") ?? "exact";
  const capabilityMatch: CapabilityMatch =
    matchRaw === "prefix" || matchRaw === "wildcard" ? matchRaw : "exact";
  const q = url.searchParams.get("q") ?? undefined;
  const onlineOnly = url.searchParams.get("online") === "true";

  let agents = await db.listAgentsByMesh(meshId);
  agents = filterAgents(agents, { capability, capabilityMatch, q });

  const onlineSet = onlineOnly || url.searchParams.has("online")
    ? await fetchOnlineSet(env, meshId)
    : null;

  if (onlineSet) {
    agents = agents.map((a) => ({
      ...a,
      online: onlineSet.has(a.id),
    }));
    if (onlineOnly) {
      agents = agents.filter((a) => a.online);
    }
    agents.sort((a, b) => {
      const aOn = a.online ? 0 : 1;
      const bOn = b.online ? 0 : 1;
      if (aOn !== bOn) return aOn - bOn;
      return a.display_name.localeCompare(b.display_name);
    });
  }

  const res: ListAgentsResponse = { agents };
  return jsonResponse(res);
}

export async function handleJoinMesh(
  request: Request,
  env: Env,
  meshId: string,
): Promise<Response> {
  let body: JoinMeshRequest;
  try {
    body = await parseJsonBody<JoinMeshRequest>(request);
  } catch (e) {
    const err = e as { message?: string; status?: number; code?: string };
    return errorResponse(
      err.code ?? "bad_request",
      err.message ?? "Invalid body",
      err.status ?? 400,
    );
  }

  if (!body.agent_id || !body.invite_code) {
    return errorResponse(
      "bad_request",
      "agent_id and invite_code are required",
      400,
    );
  }

  const db = new Db(env.PM_DB);
  const mesh = await db.getMesh(meshId);
  if (!mesh) {
    return errorResponse("not_found", `Mesh not found: ${meshId}`, 404);
  }

  const agent = await db.getAgent(body.agent_id);
  if (!agent) {
    return errorResponse("not_found", `Agent not found: ${body.agent_id}`, 404);
  }

  const invite = await db.getInvite(body.invite_code);
  if (!invite) {
    return errorResponse("invalid_invite", "Invite code not found", 403);
  }
  if (invite.mesh_id !== meshId) {
    return errorResponse(
      "invalid_invite",
      "Invite code does not match this mesh",
      403,
    );
  }
  if (invite.expires_at) {
    const exp = Date.parse(invite.expires_at);
    if (!Number.isNaN(exp) && exp < Date.now()) {
      return errorResponse("invite_expired", "Invite code has expired", 403);
    }
  }
  if (invite.max_uses > 0 && invite.use_count >= invite.max_uses) {
    return errorResponse(
      "invite_exhausted",
      "Invite code has reached max uses",
      403,
    );
  }

  if (agent.mesh_id !== meshId) {
    await db.updateAgentMesh(body.agent_id, meshId);
  }
  await db.incrementInviteUse(body.invite_code);
  await db.updateLastSeen(body.agent_id);
  void notifyMeshDoMembership(env, meshId, body.agent_id);

  const members = await db.listAgentsByMesh(meshId);
  const res: JoinMeshResponse = {
    mesh_id: meshId,
    members,
    agent_id: body.agent_id,
  };
  return jsonResponse(res);
}

export async function handleCreateInvite(
  request: Request,
  env: Env,
  meshId: string,
): Promise<Response> {
  let body: CreateInviteRequest;
  try {
    body = await parseJsonBody<CreateInviteRequest>(request);
  } catch (e) {
    const err = e as { message?: string; status?: number; code?: string };
    return errorResponse(
      err.code ?? "bad_request",
      err.message ?? "Invalid body",
      err.status ?? 400,
    );
  }

  if (!body.agent_id || typeof body.agent_id !== "string") {
    return errorResponse("bad_request", "agent_id is required", 400);
  }

  const db = new Db(env.PM_DB);
  const mesh = await db.getMesh(meshId);
  if (!mesh) {
    return errorResponse("not_found", `Mesh not found: ${meshId}`, 404);
  }

  const authenticated = await proveAgentIdentity(
    request,
    env,
    body.agent_id,
    meshId,
    body.api_key,
  );
  if (!authenticated) {
    return errorResponse(
      "unauthorized",
      "Valid JWT or api_key required for invite creation",
      401,
    );
  }

  if (mesh.owner_agent_id !== body.agent_id) {
    return errorResponse(
      "forbidden",
      "Only the mesh owner can create invites",
      403,
    );
  }

  if (!globalRateLimiter.check(`invite:${body.agent_id}`, 10)) {
    return errorResponse("rate_limited", "Too many invite creations", 429);
  }

  if (
    body.max_uses !== undefined &&
    (typeof body.max_uses !== "number" ||
      body.max_uses < 0 ||
      body.max_uses > 100_000)
  ) {
    return errorResponse(
      "bad_request",
      "max_uses must be 0..100000",
      400,
    );
  }

  let expiresAt: string | null = null;
  if (body.expires_in_seconds !== undefined) {
    if (
      typeof body.expires_in_seconds !== "number" ||
      body.expires_in_seconds < 60 ||
      body.expires_in_seconds > 2_592_000
    ) {
      return errorResponse(
        "bad_request",
        "expires_in_seconds must be 60..2592000",
        400,
      );
    }
    expiresAt = new Date(
      Date.now() + body.expires_in_seconds * 1000,
    ).toISOString();
  }

  if (
    body.prefix !== undefined &&
    (typeof body.prefix !== "string" ||
      body.prefix.length < 1 ||
      body.prefix.length > 12 ||
      !/^[A-Za-z0-9]+$/.test(body.prefix))
  ) {
    return errorResponse(
      "bad_request",
      "prefix must be 1–12 alphanumeric characters",
      400,
    );
  }

  const prefix =
    body.prefix ??
    (mesh.name.replace(/[^a-zA-Z0-9]/g, "").slice(0, 12) || "MESH");

  let invite;
  let lastErr: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateInviteCode(prefix);
    try {
      invite = await db.createInvite({
        code,
        mesh_id: meshId,
        max_uses: body.max_uses ?? 0,
        expires_at: expiresAt,
      });
      break;
    } catch (e) {
      lastErr = e;
    }
  }

  if (!invite) {
    return errorResponse(
      "conflict",
      lastErr instanceof Error ? lastErr.message : "Invite code collision",
      409,
    );
  }

  const res: CreateInviteResponse = {
    mesh_id: meshId,
    invite_code: invite.code,
    max_uses: invite.max_uses,
    use_count: invite.use_count,
    expires_at: invite.expires_at,
    created_at: invite.created_at,
  };
  return jsonResponse(res, 201);
}

async function proveAgentIdentity(
  request: Request,
  env: Env,
  agentId: string,
  meshId: string,
  apiKey?: string,
): Promise<boolean> {
  const token = extractBearerOrQueryToken(request);
  if (token && env.JWT_SECRET) {
    try {
      const claims = await verifyJwt(token, env.JWT_SECRET);
      if (claims.sub === agentId && claims.mesh === meshId) return true;
    } catch {
      /* fall through to api_key */
    }
  }

  if (apiKey) {
    const parsed = parseApiKey(apiKey);
    if (!parsed) return false;
    const db = new Db(env.PM_DB);
    const agent = await db.getAgent(agentId);
    if (!agent) return false;
    return verifyApiKey(apiKey, agent.api_key_hash);
  }

  return false;
}

/** Notify MeshDO that membership changed (best-effort). */
export async function notifyMeshDoMembership(
  env: Env,
  meshId: string,
  agentId: string,
): Promise<void> {
  try {
    const id = env.MESH_DO.idFromName(meshId);
    const stub = env.MESH_DO.get(id);
    await stub.fetch(
      new Request("https://mesh-do/internal/member-joined", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent_id: agentId, mesh_id: meshId }),
      }),
    );
  } catch {
    // DO may not be awake; membership is authoritative in D1
  }
}

export { agentToCard };
