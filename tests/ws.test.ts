import { describe, expect, it } from "vitest";
import type { WsInboundMessage } from "../src/types";
import {
  parseInboundMessage,
  payloadSize,
  routeWsMessage,
  type RouterDeps,
  type SessionContext,
} from "../src/ws/handler";

function ctx(agentId = "alice@latticeag"): SessionContext {
  return {
    agentId,
    meshId: "mesh-1",
    tokenExp: Math.floor(Date.now() / 1000) + 3600,
  };
}

function deps(online: string[] = [], submitters: Record<string, string> = {}): RouterDeps & {
  submitters: Map<string, string>;
} {
  const map = new Map<string, string>(Object.entries(submitters));
  const onlineSet = new Set(online);
  return {
    submitters: map,
    getTaskSubmitter: (id) => map.get(id),
    setTaskSubmitter: (id, from) => map.set(id, from),
    isOnline: (id) => onlineSet.has(id),
  };
}

describe("parseInboundMessage", () => {
  it("parses mesh.leave", () => {
    expect(parseInboundMessage(JSON.stringify({ type: "mesh.leave" }))).toEqual({
      type: "mesh.leave",
    });
  });

  it("returns error for invalid JSON", () => {
    const msg = parseInboundMessage("{");
    expect(msg).toMatchObject({ type: "error", code: "invalid_json" });
  });

  it("returns error for missing type", () => {
    const msg = parseInboundMessage(JSON.stringify({ foo: 1 }));
    expect(msg).toMatchObject({ type: "error", code: "invalid_message" });
  });

  it("returns error for unknown type", () => {
    const msg = parseInboundMessage(JSON.stringify({ type: "nope" }));
    expect(msg).toMatchObject({ type: "error", code: "unknown_type" });
  });

  it("parses card.announce", () => {
    const msg = parseInboundMessage(
      JSON.stringify({
        type: "card.announce",
        capabilities: [{ name: "calendar.check" }],
      }),
    );
    expect(msg).toEqual({
      type: "card.announce",
      capabilities: [{ name: "calendar.check" }],
    });
  });

  it("rejects card.announce without capabilities array", () => {
    const msg = parseInboundMessage(
      JSON.stringify({ type: "card.announce", capabilities: "x" }),
    );
    expect(msg).toMatchObject({ type: "error" });
  });

  it("parses task.submit", () => {
    const msg = parseInboundMessage(
      JSON.stringify({
        type: "task.submit",
        target: "bob@latticeag",
        capability: "calendar.check",
        payload: { day: "mon" },
        task_id: "t1",
      }),
    );
    expect(msg).toMatchObject({ type: "task.submit", task_id: "t1" });
  });

  it("parses task.accept / progress / complete / fail", () => {
    expect(
      parseInboundMessage(JSON.stringify({ type: "task.accept", task_id: "t" })),
    ).toEqual({ type: "task.accept", task_id: "t" });
    expect(
      parseInboundMessage(
        JSON.stringify({ type: "task.progress", task_id: "t", progress: 0.5 }),
      ),
    ).toMatchObject({ type: "task.progress", progress: 0.5 });
    expect(
      parseInboundMessage(
        JSON.stringify({ type: "task.complete", task_id: "t", result: { ok: 1 } }),
      ),
    ).toMatchObject({ type: "task.complete" });
    expect(
      parseInboundMessage(
        JSON.stringify({ type: "task.fail", task_id: "t", error: "unauthorized" }),
      ),
    ).toEqual({ type: "task.fail", task_id: "t", error: "unauthorized" });
  });
});

describe("card.announce", () => {
  it("acks with card.registered and cardUpdate", () => {
    const result = routeWsMessage(
      ctx(),
      {
        type: "card.announce",
        capabilities: [{ name: "calendar.check" }],
      },
      deps(),
    );
    expect(result.reply).toEqual([
      { type: "card.registered", agent_id: "alice@latticeag" },
    ]);
    expect(result.cardUpdate?.capabilities[0]?.name).toBe("calendar.check");
    expect(result.envelope?.type).toBe("announce");
  });
});

describe("task.submit routing", () => {
  it("forwards task.submit to online target", () => {
    const d = deps(["bob@latticeag"]);
    const result = routeWsMessage(
      ctx("alice@latticeag"),
      {
        type: "task.submit",
        target: "bob@latticeag",
        capability: "calendar.check",
        payload: { x: 1 },
        task_id: "task-1",
      },
      d,
    );
    expect(result.forward?.[0]).toEqual({
      to: "bob@latticeag",
      message: {
        type: "task.submit",
        from: "alice@latticeag",
        capability: "calendar.check",
        payload: { x: 1 },
        task_id: "task-1",
      },
    });
    expect(d.getTaskSubmitter("task-1")).toBe("alice@latticeag");
  });

  it("errors when target offline", () => {
    const result = routeWsMessage(
      ctx(),
      {
        type: "task.submit",
        target: "bob@latticeag",
        capability: "c",
        payload: {},
        task_id: "t",
      },
      deps([]),
    );
    expect(result.reply?.[0]).toMatchObject({
      type: "error",
      code: "target_offline",
    });
  });

  it("errors when submitting to self", () => {
    const result = routeWsMessage(
      ctx("alice@latticeag"),
      {
        type: "task.submit",
        target: "alice@latticeag",
        capability: "c",
        payload: {},
        task_id: "t",
      },
      deps(["alice@latticeag"]),
    );
    expect(result.reply?.[0]).toMatchObject({ code: "invalid_target" });
  });
});

describe("lifecycle mapping", () => {
  it("maps task.accept → task.accepted to submitter", () => {
    const result = routeWsMessage(
      ctx("bob@latticeag"),
      { type: "task.accept", task_id: "t1" },
      deps(["alice@latticeag"], { t1: "alice@latticeag" }),
    );
    expect(result.forward?.[0]).toEqual({
      to: "alice@latticeag",
      message: { type: "task.accepted", task_id: "t1" },
    });
  });

  it("maps task.progress → task.progress", () => {
    const result = routeWsMessage(
      ctx("bob@latticeag"),
      { type: "task.progress", task_id: "t1", progress: 0.4, message: "working" },
      deps(["alice@latticeag"], { t1: "alice@latticeag" }),
    );
    expect(result.forward?.[0]?.message).toEqual({
      type: "task.progress",
      task_id: "t1",
      progress: 0.4,
      message: "working",
    });
  });

  it("maps task.complete → task.completed", () => {
    const result = routeWsMessage(
      ctx("bob@latticeag"),
      { type: "task.complete", task_id: "t1", result: { ok: true } },
      deps(["alice@latticeag"], { t1: "alice@latticeag" }),
    );
    expect(result.forward?.[0]?.message).toEqual({
      type: "task.completed",
      task_id: "t1",
      result: { ok: true },
    });
  });

  it("maps task.fail → task.failed", () => {
    const result = routeWsMessage(
      ctx("bob@latticeag"),
      { type: "task.fail", task_id: "t1", error: "unauthorized" },
      deps(["alice@latticeag"], { t1: "alice@latticeag" }),
    );
    expect(result.forward?.[0]?.message).toEqual({
      type: "task.failed",
      task_id: "t1",
      error: "unauthorized",
    });
  });

  it("errors on unknown task_id for accept", () => {
    const result = routeWsMessage(
      ctx("bob@latticeag"),
      { type: "task.accept", task_id: "missing" },
      deps(["alice@latticeag"]),
    );
    expect(result.reply?.[0]).toMatchObject({ code: "unknown_task" });
  });

  it("errors when submitter offline on accept", () => {
    const result = routeWsMessage(
      ctx("bob@latticeag"),
      { type: "task.accept", task_id: "t1" },
      deps([], { t1: "alice@latticeag" }),
    );
    expect(result.reply?.[0]).toMatchObject({ code: "submitter_offline" });
  });
});

describe("mesh.leave", () => {
  it("requests close with envelope", () => {
    const result = routeWsMessage(ctx(), { type: "mesh.leave" }, deps());
    expect(result.close).toEqual({ code: 1000, reason: "mesh.leave" });
    expect(result.envelope?.type).toBe("leave");
  });
});

describe("payloadSize", () => {
  it("measures JSON byte length", () => {
    expect(payloadSize({ a: 1 })).toBeGreaterThan(0);
    expect(payloadSize(null)).toBeGreaterThan(0);
  });
});

describe("type exhaustiveness via cast", () => {
  it("routeWsMessage accepts all inbound variants", () => {
    const messages: WsInboundMessage[] = [
      { type: "card.announce", capabilities: [] },
      {
        type: "task.submit",
        target: "b",
        capability: "c",
        payload: {},
        task_id: "t",
      },
      { type: "task.accept", task_id: "t" },
      { type: "task.progress", task_id: "t", progress: 1 },
      { type: "task.complete", task_id: "t", result: {} },
      { type: "task.fail", task_id: "t", error: "e" },
      { type: "mesh.leave" },
    ];
    for (const m of messages) {
      const r = routeWsMessage(ctx(), m, deps(["b"], { t: "alice@latticeag" }));
      expect(r).toBeTruthy();
    }
  });
});
