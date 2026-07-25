/**
 * Integration lifecycle tests for PolyMesh Gateway (SPEC §14.3).
 * Uses FakeD1 + REST handlers + WS routeWsMessage (no live CF runtime).
 */

import { describe, expect, it, beforeEach } from "vitest";
import { handleCreateAgent, handleGetAgentCard } from "../src/api/agents";
import { handleTokenExchange } from "../src/api/auth";
import {
  handleCreateInvite,
  handleCreateMesh,
  handleJoinMesh,
  handleListAgents,
} from "../src/api/meshes";
import { Db } from "../src/db/schema";
import { globalRateLimiter } from "../src/utils";
import {
  createTaskRoutingTable,
  parseInboundMessage,
  routeWsMessage,
  type RouterDeps,
  type SessionContext,
} from "../src/ws/handler";
import { FakeD1, makeTestEnv } from "./fake-d1";

function jsonRequest(url: string, method: string, body?: unknown): Request {
  return new Request(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

async function readJson<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

function session(agentId: string, meshId = "mesh-1"): SessionContext {
  return {
    agentId,
    meshId,
    tokenExp: Math.floor(Date.now() / 1000) + 3600,
  };
}

function makeDeps(
  online: string[],
  tasks = createTaskRoutingTable(),
): RouterDeps & { tasks: ReturnType<typeof createTaskRoutingTable> } {
  return {
    tasks,
    getTaskSubmitter: (id) => tasks.get(id)?.submitter,
    setTaskSubmitter: (id, from) => {
      const existing = tasks.get(id);
      if (existing) {
        tasks.set(id, { ...existing, submitter: from });
      } else {
        tasks.set(id, {
          submitter: from,
          target: "",
          createdAt: Date.now(),
          state: "submitted",
        });
      }
    },
    isOnline: (id) => online.includes(id),
    hasActiveTask: (id) => tasks.hasActive(id),
    setTaskRoute: (id, route) => {
      tasks.set(id, {
        submitter: route.submitter,
        target: route.target,
        createdAt: Date.now(),
        state: "submitted",
      });
    },
    setTaskState: (id, state) => {
      const existing = tasks.get(id);
      if (existing) tasks.set(id, { ...existing, state });
    },
    clearTask: (id) => {
      tasks.delete(id);
    },
  };
}

describe("gateway lifecycle integration", () => {
  beforeEach(() => {
    globalRateLimiter.reset();
  });

  it("register → token → create mesh → join → discover", async () => {
    const fake = new FakeD1();
    const env = makeTestEnv(fake);

    const aliceRes = await handleCreateAgent(
      jsonRequest("https://gw/api/v1/agents", "POST", {
        display_name: "Alice",
      }),
      env,
    );
    expect(aliceRes.status).toBe(201);
    const alice = await readJson<{
      agent_id: string;
      api_key: string;
      mesh_id: string;
    }>(aliceRes);

    const tokenRes = await handleTokenExchange(
      jsonRequest("https://gw/api/v1/auth/token", "POST", {
        api_key: alice.api_key,
      }),
      env,
    );
    expect(tokenRes.status).toBe(200);
    const { token, expires_at } = await readJson<{
      token: string;
      expires_at: string;
    }>(tokenRes);
    expect(token.split(".")).toHaveLength(3);
    expect(Date.parse(expires_at)).toBeGreaterThan(Date.now());

    const meshRes = await handleCreateMesh(
      jsonRequest("https://gw/api/v1/meshes", "POST", {
        name: "friends",
        agent_id: alice.agent_id,
      }),
      env,
    );
    expect(meshRes.status).toBe(201);
    const mesh = await readJson<{ mesh_id: string; invite_code: string }>(
      meshRes,
    );

    const bobRes = await handleCreateAgent(
      jsonRequest("https://gw/api/v1/agents", "POST", {
        display_name: "Bob",
      }),
      env,
    );
    const bob = await readJson<{ agent_id: string; api_key: string }>(bobRes);

    const joinRes = await handleJoinMesh(
      jsonRequest(`https://gw/api/v1/meshes/${mesh.mesh_id}/join`, "POST", {
        agent_id: bob.agent_id,
        invite_code: mesh.invite_code,
      }),
      env,
      mesh.mesh_id,
    );
    expect(joinRes.status).toBe(200);
    const joined = await readJson<{
      mesh_id: string;
      agent_id: string;
      members: Array<{ id: string }>;
    }>(joinRes);
    expect(joined.members.map((m) => m.id).sort()).toEqual(
      [alice.agent_id, bob.agent_id].sort(),
    );

    // Announce capabilities via Db (WS announce would do the same)
    const db = new Db(env.PM_DB);
    await db.updateAgentCapabilities(bob.agent_id, [
      { name: "calendar.check" },
    ]);

    const listRes = await handleListAgents(
      new Request(
        `https://gw/api/v1/meshes/${mesh.mesh_id}/agents?capability=calendar.check`,
      ),
      env,
      mesh.mesh_id,
    );
    expect(listRes.status).toBe(200);
    const list = await readJson<{ agents: Array<{ id: string }> }>(listRes);
    expect(list.agents.map((a) => a.id)).toEqual([bob.agent_id]);

    const cardRes = await handleGetAgentCard(
      new Request(`https://gw/api/v1/agents/${bob.agent_id}/card`),
      env,
      bob.agent_id,
    );
    expect(cardRes.status).toBe(200);
  });

  it("rejects invalid API key on token exchange", async () => {
    const env = makeTestEnv(new FakeD1());
    const res = await handleTokenExchange(
      jsonRequest("https://gw/api/v1/auth/token", "POST", {
        api_key: "pmgk_badkeyid_badsecret",
      }),
      env,
    );
    expect(res.status).toBe(401);
  });

  it("rejects bad invite / expired / exhausted", async () => {
    const fake = new FakeD1();
    const env = makeTestEnv(fake);

    const aliceRes = await handleCreateAgent(
      jsonRequest("https://gw/agents", "POST", { display_name: "Alice" }),
      env,
    );
    const alice = await readJson<{ agent_id: string }>(aliceRes);
    const meshRes = await handleCreateMesh(
      jsonRequest("https://gw/meshes", "POST", {
        name: "room",
        agent_id: alice.agent_id,
      }),
      env,
    );
    const mesh = await readJson<{ mesh_id: string; invite_code: string }>(
      meshRes,
    );

    const bobRes = await handleCreateAgent(
      jsonRequest("https://gw/agents", "POST", { display_name: "Bob" }),
      env,
    );
    const bob = await readJson<{ agent_id: string }>(bobRes);

    const bad = await handleJoinMesh(
      jsonRequest(`https://gw/meshes/${mesh.mesh_id}/join`, "POST", {
        agent_id: bob.agent_id,
        invite_code: "NOPE-XXXXXX",
      }),
      env,
      mesh.mesh_id,
    );
    expect(bad.status).toBe(403);

    // Exhausted invite
    const db = new Db(env.PM_DB);
    const limited = await db.createInvite({
      code: "ROOM-LIMIT1",
      mesh_id: mesh.mesh_id,
      max_uses: 1,
    });
    await db.incrementInviteUse(limited.code);
    const exhausted = await handleJoinMesh(
      jsonRequest(`https://gw/meshes/${mesh.mesh_id}/join`, "POST", {
        agent_id: bob.agent_id,
        invite_code: limited.code,
      }),
      env,
      mesh.mesh_id,
    );
    expect(exhausted.status).toBe(403);
    const exhaustedBody = await readJson<{ error: { code: string } }>(
      exhausted,
    );
    expect(exhaustedBody.error.code).toBe("invite_exhausted");

    // Expired invite
    await db.createInvite({
      code: "ROOM-OLD001",
      mesh_id: mesh.mesh_id,
      max_uses: 0,
      expires_at: new Date(Date.now() - 60_000).toISOString(),
    });
    const expired = await handleJoinMesh(
      jsonRequest(`https://gw/meshes/${mesh.mesh_id}/join`, "POST", {
        agent_id: bob.agent_id,
        invite_code: "ROOM-OLD001",
      }),
      env,
      mesh.mesh_id,
    );
    expect(expired.status).toBe(403);
    const expiredBody = await readJson<{ error: { code: string } }>(expired);
    expect(expiredBody.error.code).toBe("invite_expired");
  });

  it("duplicate join is idempotent membership", async () => {
    const fake = new FakeD1();
    const env = makeTestEnv(fake);
    const alice = await readJson<{ agent_id: string }>(
      await handleCreateAgent(
        jsonRequest("https://gw/agents", "POST", { display_name: "Alice" }),
        env,
      ),
    );
    const mesh = await readJson<{ mesh_id: string; invite_code: string }>(
      await handleCreateMesh(
        jsonRequest("https://gw/meshes", "POST", {
          name: "dup-join",
          agent_id: alice.agent_id,
        }),
        env,
      ),
    );
    const bob = await readJson<{ agent_id: string }>(
      await handleCreateAgent(
        jsonRequest("https://gw/agents", "POST", { display_name: "Bob" }),
        env,
      ),
    );

    const first = await handleJoinMesh(
      jsonRequest(`https://gw/meshes/${mesh.mesh_id}/join`, "POST", {
        agent_id: bob.agent_id,
        invite_code: mesh.invite_code,
      }),
      env,
      mesh.mesh_id,
    );
    const second = await handleJoinMesh(
      jsonRequest(`https://gw/meshes/${mesh.mesh_id}/join`, "POST", {
        agent_id: bob.agent_id,
        invite_code: mesh.invite_code,
      }),
      env,
      mesh.mesh_id,
    );
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(fake.agents.get(bob.agent_id)?.mesh_id).toBe(mesh.mesh_id);
  });

  it("mesh name conflict returns 409", async () => {
    const env = makeTestEnv(new FakeD1());
    const alice = await readJson<{ agent_id: string }>(
      await handleCreateAgent(
        jsonRequest("https://gw/agents", "POST", { display_name: "Alice" }),
        env,
      ),
    );
    const first = await handleCreateMesh(
      jsonRequest("https://gw/meshes", "POST", {
        name: "clash",
        agent_id: alice.agent_id,
      }),
      env,
    );
    expect(first.status).toBe(201);
    const second = await handleCreateMesh(
      jsonRequest("https://gw/meshes", "POST", {
        name: "clash",
        agent_id: alice.agent_id,
      }),
      env,
    );
    expect(second.status).toBe(409);
  });

  it("owner can create additional invites", async () => {
    const env = makeTestEnv(new FakeD1());
    const alice = await readJson<{ agent_id: string; api_key: string }>(
      await handleCreateAgent(
        jsonRequest("https://gw/agents", "POST", { display_name: "Alice" }),
        env,
      ),
    );
    const mesh = await readJson<{ mesh_id: string }>(
      await handleCreateMesh(
        jsonRequest("https://gw/meshes", "POST", {
          name: "invites",
          agent_id: alice.agent_id,
        }),
        env,
      ),
    );
    const inviteRes = await handleCreateInvite(
      jsonRequest(`https://gw/meshes/${mesh.mesh_id}/invite`, "POST", {
        agent_id: alice.agent_id,
        api_key: alice.api_key,
        max_uses: 5,
        prefix: "FRIENDS",
      }),
      env,
      mesh.mesh_id,
    );
    expect(inviteRes.status).toBe(201);
    const body = await readJson<{ invite_code: string; max_uses: number }>(
      inviteRes,
    );
    expect(body.invite_code.startsWith("FRIENDS-")).toBe(true);
    expect(body.max_uses).toBe(5);
  });
});

describe("WS connect + task submit/route + disconnect", () => {
  it("full task lifecycle: submit → accept → progress → complete", () => {
    const tasks = createTaskRoutingTable();
    const online = ["alice@latticeag", "bob@latticeag"];
    const deps = makeDeps(online, tasks);

    const submit = routeWsMessage(
      session("alice@latticeag"),
      {
        type: "task.submit",
        target: "bob@latticeag",
        capability: "calendar.check",
        payload: { date: "2026-07-25" },
        task_id: "t-1",
      },
      deps,
    );
    expect(submit.forward?.[0]?.to).toBe("bob@latticeag");
    expect(tasks.get("t-1")?.submitter).toBe("alice@latticeag");

    const accept = routeWsMessage(
      session("bob@latticeag"),
      { type: "task.accept", task_id: "t-1" },
      deps,
    );
    expect(accept.forward?.[0]?.message).toEqual({
      type: "task.accepted",
      task_id: "t-1",
    });

    const progress = routeWsMessage(
      session("bob@latticeag"),
      { type: "task.progress", task_id: "t-1", progress: 0.5, message: "halfway" },
      deps,
    );
    expect(progress.forward?.[0]?.message).toMatchObject({
      type: "task.progress",
      progress: 0.5,
    });

    const complete = routeWsMessage(
      session("bob@latticeag"),
      { type: "task.complete", task_id: "t-1", result: { free: true } },
      deps,
    );
    expect(complete.forward?.[0]?.message).toMatchObject({
      type: "task.completed",
      result: { free: true },
    });
    expect(tasks.hasActive("t-1")).toBe(false);
  });

  it("task.fail routes to submitter and clears", () => {
    const tasks = createTaskRoutingTable();
    const deps = makeDeps(["alice@latticeag", "bob@latticeag"], tasks);
    routeWsMessage(
      session("alice@latticeag"),
      {
        type: "task.submit",
        target: "bob@latticeag",
        capability: "c",
        payload: {},
        task_id: "t-fail",
      },
      deps,
    );
    const fail = routeWsMessage(
      session("bob@latticeag"),
      { type: "task.fail", task_id: "t-fail", error: "unauthorized" },
      deps,
    );
    expect(fail.forward?.[0]?.message).toEqual({
      type: "task.failed",
      task_id: "t-fail",
      error: "unauthorized",
    });
    expect(tasks.hasActive("t-fail")).toBe(false);
  });

  it("target_offline / self-target / duplicate_task_id errors", () => {
    const tasks = createTaskRoutingTable();
    const deps = makeDeps(["bob@latticeag"], tasks);

    expect(
      routeWsMessage(
        session("alice@latticeag"),
        {
          type: "task.submit",
          target: "offline@latticeag",
          capability: "c",
          payload: {},
          task_id: "t",
        },
        deps,
      ).reply?.[0],
    ).toMatchObject({ code: "target_offline" });

    expect(
      routeWsMessage(
        session("alice@latticeag"),
        {
          type: "task.submit",
          target: "alice@latticeag",
          capability: "c",
          payload: {},
          task_id: "t",
        },
        makeDeps(["alice@latticeag"]),
      ).reply?.[0],
    ).toMatchObject({ code: "invalid_target" });

    routeWsMessage(
      session("alice@latticeag"),
      {
        type: "task.submit",
        target: "bob@latticeag",
        capability: "c",
        payload: {},
        task_id: "dup",
      },
      deps,
    );
    expect(
      routeWsMessage(
        session("alice@latticeag"),
        {
          type: "task.submit",
          target: "bob@latticeag",
          capability: "c",
          payload: {},
          task_id: "dup",
        },
        deps,
      ).reply?.[0],
    ).toMatchObject({ code: "duplicate_task_id" });
  });

  it("mesh.leave closes socket (disconnect)", () => {
    const result = routeWsMessage(
      session("alice@latticeag"),
      { type: "mesh.leave" },
      makeDeps([]),
    );
    expect(result.close).toEqual({ code: 1000, reason: "mesh.leave" });
    expect(result.envelope?.type).toBe("leave");
  });

  it("rejects invalid progress and binary/invalid JSON", () => {
    expect(
      parseInboundMessage(
        JSON.stringify({ type: "task.progress", task_id: "t", progress: 2 }),
      ),
    ).toMatchObject({ type: "error", code: "invalid_message" });
    expect(parseInboundMessage("{")).toMatchObject({
      type: "error",
      code: "invalid_json",
    });
    expect(parseInboundMessage(new ArrayBuffer(8))).toMatchObject({
      type: "error",
      code: "invalid_message",
    });
  });

  it("capability prefix / wildcard discovery filters", async () => {
    const fake = new FakeD1();
    const env = makeTestEnv(fake);
    const alice = await readJson<{ agent_id: string }>(
      await handleCreateAgent(
        jsonRequest("https://gw/agents", "POST", { display_name: "Alice" }),
        env,
      ),
    );
    const mesh = await readJson<{ mesh_id: string }>(
      await handleCreateMesh(
        jsonRequest("https://gw/meshes", "POST", {
          name: "caps",
          agent_id: alice.agent_id,
        }),
        env,
      ),
    );
    const db = new Db(env.PM_DB);
    await db.updateAgentCapabilities(alice.agent_id, [
      { name: "calendar.check" },
      { name: "calendar.create" },
    ]);

    const prefix = await handleListAgents(
      new Request(
        `https://gw/meshes/${mesh.mesh_id}/agents?capability=calendar.&capability_match=prefix`,
      ),
      env,
      mesh.mesh_id,
    );
    expect((await readJson<{ agents: unknown[] }>(prefix)).agents).toHaveLength(
      1,
    );

    const wild = await handleListAgents(
      new Request(
        `https://gw/meshes/${mesh.mesh_id}/agents?capability=calendar.*&capability_match=wildcard`,
      ),
      env,
      mesh.mesh_id,
    );
    expect((await readJson<{ agents: unknown[] }>(wild)).agents).toHaveLength(1);
  });
});

describe("error scenarios", () => {
  it("bad_request and not_found", async () => {
    const env = makeTestEnv(new FakeD1());
    const bad = await handleCreateAgent(
      jsonRequest("https://gw/agents", "POST", {}),
      env,
    );
    expect(bad.status).toBe(400);

    const missing = await handleGetAgentCard(
      new Request("https://gw/agents/nope@latticeag/card"),
      env,
      "nope@latticeag",
    );
    expect(missing.status).toBe(404);

    const missingMesh = await handleListAgents(
      new Request("https://gw/meshes/missing/agents"),
      env,
      "missing",
    );
    expect(missingMesh.status).toBe(404);
  });
});
