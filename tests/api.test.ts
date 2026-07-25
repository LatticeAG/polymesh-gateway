import { describe, expect, it, beforeEach } from "vitest";
import { handleCreateAgent, handleGetAgentCard } from "../src/api/agents";
import { handleTokenExchange } from "../src/api/auth";
import {
  handleCreateMesh,
  handleJoinMesh,
  handleListAgents,
} from "../src/api/meshes";
import { Db } from "../src/db/schema";
import { formatStoredHash, hashApiKey } from "../src/auth";
import { generateApiKey } from "../src/utils";
import { FakeD1, makeTestEnv } from "./fake-d1";

function jsonRequest(
  url: string,
  method: string,
  body?: unknown,
): Request {
  return new Request(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

async function readJson<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

describe("POST /api/v1/agents", () => {
  it("creates agent with personal mesh when mesh_id omitted", async () => {
    const fake = new FakeD1();
    const env = makeTestEnv(fake);
    const res = await handleCreateAgent(
      jsonRequest("https://gw/agents", "POST", { display_name: "Alice" }),
      env,
    );
    expect(res.status).toBe(201);
    const body = await readJson<{
      agent_id: string;
      api_key: string;
      mesh_id: string;
    }>(res);
    expect(body.agent_id).toContain("@latticeag");
    expect(body.api_key.startsWith("pmgk_")).toBe(true);
    expect(fake.meshes.size).toBe(1);
    expect(fake.agents.size).toBe(1);
  });

  it("rejects missing display_name", async () => {
    const env = makeTestEnv(new FakeD1());
    const res = await handleCreateAgent(
      jsonRequest("https://gw/agents", "POST", {}),
      env,
    );
    expect(res.status).toBe(400);
  });

  it("rejects unknown mesh_id", async () => {
    const env = makeTestEnv(new FakeD1());
    const res = await handleCreateAgent(
      jsonRequest("https://gw/agents", "POST", {
        display_name: "Bob",
        mesh_id: "missing-mesh",
      }),
      env,
    );
    expect(res.status).toBe(404);
  });

  it("rejects invalid JSON body", async () => {
    const env = makeTestEnv(new FakeD1());
    const res = await handleCreateAgent(
      new Request("https://gw/agents", {
        method: "POST",
        body: "not-json",
      }),
      env,
    );
    expect(res.status).toBe(400);
  });
});

describe("GET /api/v1/agents/:id/card", () => {
  it("returns agent card", async () => {
    const fake = new FakeD1();
    const env = makeTestEnv(fake);
    const createRes = await handleCreateAgent(
      jsonRequest("https://gw/agents", "POST", { display_name: "Carol" }),
      env,
    );
    const { agent_id } = await readJson<{ agent_id: string }>(createRes);
    const cardRes = await handleGetAgentCard(
      new Request(`https://gw/agents/${agent_id}/card`),
      env,
      agent_id,
    );
    expect(cardRes.status).toBe(200);
    const card = await readJson<{ id: string; display_name: string }>(cardRes);
    expect(card.id).toBe(agent_id);
    expect(card.display_name).toBe("Carol");
  });

  it("404 for unknown agent", async () => {
    const res = await handleGetAgentCard(
      new Request("https://gw/agents/nobody@latticeag/card"),
      makeTestEnv(new FakeD1()),
      "nobody@latticeag",
    );
    expect(res.status).toBe(404);
  });
});

describe("POST /api/v1/meshes", () => {
  let fake: FakeD1;
  let env: ReturnType<typeof makeTestEnv>;
  let agentId: string;

  beforeEach(async () => {
    fake = new FakeD1();
    env = makeTestEnv(fake);
    const res = await handleCreateAgent(
      jsonRequest("https://gw/agents", "POST", { display_name: "Owner" }),
      env,
    );
    agentId = (await readJson<{ agent_id: string }>(res)).agent_id;
  });

  it("creates mesh and invite code", async () => {
    const res = await handleCreateMesh(
      jsonRequest("https://gw/meshes", "POST", {
        name: "friends",
        agent_id: agentId,
      }),
      env,
    );
    expect(res.status).toBe(201);
    const body = await readJson<{ mesh_id: string; invite_code: string }>(res);
    expect(body.mesh_id).toBeTruthy();
    expect(body.invite_code).toMatch(/^[A-Z0-9]+-[A-Z0-9]{6}$/);
  });

  it("conflicts on duplicate mesh name", async () => {
    await handleCreateMesh(
      jsonRequest("https://gw/meshes", "POST", {
        name: "dev",
        agent_id: agentId,
      }),
      env,
    );
    const res = await handleCreateMesh(
      jsonRequest("https://gw/meshes", "POST", {
        name: "dev",
        agent_id: agentId,
      }),
      env,
    );
    expect(res.status).toBe(409);
  });

  it("requires name and agent_id", async () => {
    const res = await handleCreateMesh(
      jsonRequest("https://gw/meshes", "POST", { name: "x" }),
      env,
    );
    expect(res.status).toBe(400);
  });

  it("404 when agent_id unknown", async () => {
    const res = await handleCreateMesh(
      jsonRequest("https://gw/meshes", "POST", {
        name: "ghost",
        agent_id: "ghost@latticeag",
      }),
      env,
    );
    expect(res.status).toBe(404);
  });
});

describe("GET /api/v1/meshes/:id/agents", () => {
  it("lists agents and filters by capability", async () => {
    const fake = new FakeD1();
    const env = makeTestEnv(fake);
    const db = new Db(env.PM_DB);
    const meshId = crypto.randomUUID();
    await db.createMesh({
      id: meshId,
      name: "cap-mesh",
      owner_agent_id: "o@latticeag",
    });
    await db.createAgent({
      id: "a1@latticeag",
      mesh_id: meshId,
      display_name: "A1",
      api_key_hash: "k1$$2b$10$abcdefghijklmnopqrstuv",
      capabilities: [{ name: "calendar.check" }],
    });
    await db.createAgent({
      id: "a2@latticeag",
      mesh_id: meshId,
      display_name: "A2",
      api_key_hash: "k2$$2b$10$abcdefghijklmnopqrstuv",
      capabilities: [{ name: "notes.write" }],
    });

    const allRes = await handleListAgents(
      new Request(`https://gw/meshes/${meshId}/agents`),
      env,
      meshId,
    );
    const all = await readJson<{ agents: { id: string }[] }>(allRes);
    expect(all.agents).toHaveLength(2);

    const filteredRes = await handleListAgents(
      new Request(
        `https://gw/meshes/${meshId}/agents?capability=calendar.check`,
      ),
      env,
      meshId,
    );
    const filtered = await readJson<{ agents: { id: string }[] }>(filteredRes);
    expect(filtered.agents).toHaveLength(1);
    expect(filtered.agents[0]!.id).toBe("a1@latticeag");
  });

  it("404 for unknown mesh", async () => {
    const res = await handleListAgents(
      new Request("https://gw/meshes/nope/agents"),
      makeTestEnv(new FakeD1()),
      "nope",
    );
    expect(res.status).toBe(404);
  });
});

describe("POST /api/v1/meshes/:id/join", () => {
  it("joins mesh with valid invite", async () => {
    const fake = new FakeD1();
    const env = makeTestEnv(fake);
    const ownerRes = await handleCreateAgent(
      jsonRequest("https://gw/agents", "POST", { display_name: "Owner" }),
      env,
    );
    const ownerId = (await readJson<{ agent_id: string }>(ownerRes)).agent_id;
    const meshRes = await handleCreateMesh(
      jsonRequest("https://gw/meshes", "POST", {
        name: "team",
        agent_id: ownerId,
      }),
      env,
    );
    const { mesh_id, invite_code } = await readJson<{
      mesh_id: string;
      invite_code: string;
    }>(meshRes);

    const guestRes = await handleCreateAgent(
      jsonRequest("https://gw/agents", "POST", { display_name: "Guest" }),
      env,
    );
    const guestId = (await readJson<{ agent_id: string }>(guestRes)).agent_id;

    const joinRes = await handleJoinMesh(
      jsonRequest(`https://gw/meshes/${mesh_id}/join`, "POST", {
        agent_id: guestId,
        invite_code,
      }),
      env,
      mesh_id,
    );
    expect(joinRes.status).toBe(200);
    const joined = await readJson<{ members: unknown[]; agent_id: string }>(
      joinRes,
    );
    expect(joined.agent_id).toBe(guestId);
    expect(joined.members.length).toBeGreaterThanOrEqual(2);
  });

  it("rejects bad invite code", async () => {
    const fake = new FakeD1();
    const env = makeTestEnv(fake);
    const res = await handleCreateAgent(
      jsonRequest("https://gw/agents", "POST", { display_name: "Solo" }),
      env,
    );
    const { agent_id, mesh_id } = await readJson<{
      agent_id: string;
      mesh_id: string;
    }>(res);
    const joinRes = await handleJoinMesh(
      jsonRequest(`https://gw/meshes/${mesh_id}/join`, "POST", {
        agent_id,
        invite_code: "FAKE-CODE",
      }),
      env,
      mesh_id,
    );
    expect(joinRes.status).toBe(403);
  });

  it("rejects expired invite", async () => {
    const fake = new FakeD1();
    const env = makeTestEnv(fake);
    const db = new Db(env.PM_DB);
    const meshId = crypto.randomUUID();
    await db.createMesh({
      id: meshId,
      name: "expired-mesh",
      owner_agent_id: "o@latticeag",
    });
    const code = "OLD-INVITE";
    await db.createInvite({
      code,
      mesh_id: meshId,
      expires_at: new Date(Date.now() - 86_400_000).toISOString(),
    });
    await db.createAgent({
      id: "joiner@latticeag",
      mesh_id: meshId,
      display_name: "Joiner",
      api_key_hash: "k$$2b$10$abcdefghijklmnopqrstuv",
    });
    const joinRes = await handleJoinMesh(
      jsonRequest(`https://gw/meshes/${meshId}/join`, "POST", {
        agent_id: "joiner@latticeag",
        invite_code: code,
      }),
      env,
      meshId,
    );
    expect(joinRes.status).toBe(403);
    const err = await readJson<{ error: { code: string } }>(joinRes);
    expect(err.error.code).toBe("invite_expired");
  });

  it("requires agent_id and invite_code", async () => {
    const res = await handleJoinMesh(
      jsonRequest("https://gw/meshes/m/join", "POST", {}),
      makeTestEnv(new FakeD1()),
      "m",
    );
    expect(res.status).toBe(400);
  });
});

describe("POST /api/v1/auth/token", () => {
  it("exchanges valid API key for JWT", async () => {
    const fake = new FakeD1();
    const env = makeTestEnv(fake);
    const createRes = await handleCreateAgent(
      jsonRequest("https://gw/agents", "POST", { display_name: "TokenUser" }),
      env,
    );
    const { agent_id, api_key, mesh_id } = await readJson<{
      agent_id: string;
      api_key: string;
      mesh_id: string;
    }>(createRes);

    const tokenRes = await handleTokenExchange(
      jsonRequest("https://gw/auth/token", "POST", { api_key }),
      env,
    );
    expect(tokenRes.status).toBe(200);
    const body = await readJson<{ token: string; expires_at: string }>(
      tokenRes,
    );
    expect(body.token.split(".")).toHaveLength(3);
    expect(body.expires_at).toBeTruthy();

    const { verifyJwt } = await import("../src/auth");
    const payload = await verifyJwt(body.token, env.JWT_SECRET);
    expect(payload.sub).toBe(agent_id);
    expect(payload.mesh).toBe(mesh_id);
  });

  it("fails for wrong API key secret", async () => {
    const fake = new FakeD1();
    const env = makeTestEnv(fake);
    const createRes = await handleCreateAgent(
      jsonRequest("https://gw/agents", "POST", { display_name: "X" }),
      env,
    );
    const { api_key } = await readJson<{ api_key: string }>(createRes);
    const tokenRes = await handleTokenExchange(
      jsonRequest("https://gw/auth/token", "POST", {
        api_key: api_key + "z",
      }),
      env,
    );
    expect(tokenRes.status).toBe(401);
  });

  it("fails for malformed key format", async () => {
    const res = await handleTokenExchange(
      jsonRequest("https://gw/auth/token", "POST", { api_key: "bad" }),
      makeTestEnv(new FakeD1()),
    );
    expect(res.status).toBe(401);
  });

  it("fails when keyId not in database", async () => {
    const { apiKey } = generateApiKey();
    const res = await handleTokenExchange(
      jsonRequest("https://gw/auth/token", "POST", { api_key: apiKey }),
      makeTestEnv(new FakeD1()),
    );
    expect(res.status).toBe(401);
  });

  it("fails without JWT_SECRET", async () => {
    const fake = new FakeD1();
    const env = makeTestEnv(fake);
    const createRes = await handleCreateAgent(
      jsonRequest("https://gw/agents", "POST", { display_name: "Y" }),
      env,
    );
    const { api_key } = await readJson<{ api_key: string }>(createRes);
    const res = await handleTokenExchange(
      jsonRequest("https://gw/auth/token", "POST", { api_key }),
      { ...env, JWT_SECRET: "" },
    );
    expect(res.status).toBe(500);
  });

  it("manual hash mismatch returns 401", async () => {
    const fake = new FakeD1();
    const env = makeTestEnv(fake);
    const db = new Db(env.PM_DB);
    const meshId = crypto.randomUUID();
    await db.createMesh({
      id: meshId,
      name: "tok-mesh",
      owner_agent_id: "o@latticeag",
    });
    const { apiKey, keyId } = generateApiKey();
    const otherKey = generateApiKey().apiKey;
    const stored = formatStoredHash(keyId, await hashApiKey(otherKey));
    await db.createAgent({
      id: "z@latticeag",
      mesh_id: meshId,
      display_name: "Z",
      api_key_hash: stored,
    });
    const res = await handleTokenExchange(
      jsonRequest("https://gw/auth/token", "POST", { api_key: apiKey }),
      env,
    );
    expect(res.status).toBe(401);
  });
});
