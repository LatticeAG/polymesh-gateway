/** PolyMesh Gateway Worker — HTTP router (itty-router) + WSS upgrade entry */

import { AutoRouter, type IRequest } from "itty-router";
import { handleCreateAgent, handleGetAgentCard } from "./api/agents";
import { handleTokenExchange } from "./api/auth";
import {
  handleCreateInvite,
  handleCreateMesh,
  handleJoinMesh,
  handleListAgents,
} from "./api/meshes";
import { extractBearerOrQueryToken, verifyJwt } from "./auth";
import { MeshDO, getMeshStub } from "./do/mesh-do";
import type { Env } from "./types";
import {
  corsHeaders,
  errorResponse,
  jsonResponse,
  withCors,
} from "./utils";

export { MeshDO };

const HEALTH = {
  service: "polymesh-gateway",
  version: "1.0.0",
  protocol: "polymesh-v5",
  ok: true as const,
};

type CFArgs = [Env, ExecutionContext];

const router = AutoRouter<IRequest, CFArgs>({
  base: "",
});

router.options("*", () => new Response(null, { status: 204, headers: corsHeaders() }));

router.get("/", () => jsonResponse(HEALTH));
router.get("/health", () => jsonResponse(HEALTH));
router.get("/api/v1/health", () => jsonResponse(HEALTH));

router.post("/api/v1/agents", (req, env) => handleCreateAgent(req, env));
router.get("/api/v1/agents/:id/card", (req, env) =>
  handleGetAgentCard(req, env, decodeURIComponent(req.params.id)),
);

router.post("/api/v1/auth/token", (req, env) => handleTokenExchange(req, env));

router.post("/api/v1/meshes", (req, env) => handleCreateMesh(req, env));
router.get("/api/v1/meshes/:id/agents", (req, env) =>
  handleListAgents(req, env, decodeURIComponent(req.params.id)),
);
router.post("/api/v1/meshes/:id/join", (req, env) =>
  handleJoinMesh(req, env, decodeURIComponent(req.params.id)),
);
router.post("/api/v1/meshes/:id/invite", (req, env) =>
  handleCreateInvite(req, env, decodeURIComponent(req.params.id)),
);

router.all("/api/v1/ws", (req, env) => handleWsUpgrade(req, env));

router.all("*", (req) =>
  errorResponse(
    "not_found",
    `No route for ${req.method} ${new URL(req.url).pathname}`,
    404,
  ),
);

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    // WebSocket upgrades must be returned raw: the DO's 101+webSocket
    // response cannot be re-constructed (withCors would throw "status
    // codes in the range 200 to 599" - see workerd#3047). Detect the
    // upgrade BEFORE the router and hand it straight back.
    const url = new URL(request.url);
    if (
      url.pathname === "/api/v1/ws" &&
      (request.headers.get("Upgrade") ?? "").toLowerCase() === "websocket"
    ) {
      try {
        return await handleWsUpgrade(request, env);
      } catch (e) {
        console.error("Unhandled gateway error", e);
        return errorResponse(
          "internal_error",
          e instanceof Error ? e.message : "Internal server error",
          500,
        );
      }
    }

    try {
      const response = await router.fetch(request, env, ctx);
      return withCors(response);
    } catch (e) {
      console.error("Unhandled gateway error", e);
      return withCors(
        errorResponse(
          "internal_error",
          e instanceof Error ? e.message : "Internal server error",
          500,
        ),
      );
    }
  },
};

/**
 * Authenticate JWT, then proxy the WebSocket upgrade to the per-mesh Durable Object.
 * Query: /api/v1/ws?token=<jwt>&mesh=<mesh_id>
 */
async function handleWsUpgrade(request: Request, env: Env): Promise<Response> {
  const upgrade = request.headers.get("Upgrade");
  if (!upgrade || upgrade.toLowerCase() !== "websocket") {
    return errorResponse(
      "upgrade_required",
      "Expected WebSocket Upgrade",
      426,
    );
  }

  if (!env.JWT_SECRET) {
    return errorResponse(
      "misconfigured",
      "JWT_SECRET is not configured",
      500,
    );
  }

  const url = new URL(request.url);
  const token = extractBearerOrQueryToken(request);
  const meshId = url.searchParams.get("mesh");

  if (!token) {
    return errorResponse("unauthorized", "Missing token query parameter", 401);
  }
  if (!meshId) {
    return errorResponse("bad_request", "Missing mesh query parameter", 400);
  }

  let claims;
  try {
    claims = await verifyJwt(token, env.JWT_SECRET);
  } catch (e) {
    const err = e as { code?: string; message?: string; status?: number };
    return errorResponse(
      err.code ?? "unauthorized",
      err.message ?? "Invalid token",
      err.status ?? 401,
    );
  }

  if (claims.mesh !== meshId) {
    return errorResponse(
      "mesh_mismatch",
      "JWT mesh claim does not match requested mesh",
      403,
    );
  }

  const stub = getMeshStub(env, meshId);

  const doUrl = new URL("https://mesh-do/ws");
  doUrl.searchParams.set("token", token);
  doUrl.searchParams.set("mesh", meshId);

  const headers = new Headers(request.headers);
  headers.set("X-PM-Token", token);
  headers.set("X-PM-Mesh", meshId);
  headers.set("X-PM-Agent", claims.sub);

  return stub.fetch(
    new Request(doUrl.toString(), {
      method: request.method,
      headers,
      body: request.body,
    }),
  );
}
