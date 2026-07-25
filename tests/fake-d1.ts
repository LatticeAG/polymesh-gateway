/** In-memory D1 mock for unit tests (supports SQL used by Db) */

import type { Agent, Invite, Mesh } from "../src/types";

type EnvelopeRow = {
  id: number;
  mesh_id: string;
  from_agent: string;
  to_agent: string | null;
  capability: string;
  task_id: string | null;
  type: string;
  payload_size: number | null;
  created_at: string;
};

const EMPTY_META: D1Meta & Record<string, unknown> = {
  duration: 0,
  size_after: 0,
  rows_read: 0,
  rows_written: 0,
  last_row_id: 0,
  changed_db: false,
  changes: 0,
};

export class FakeD1 {
  meshes = new Map<string, Mesh>();
  agents = new Map<string, Agent>();
  invites = new Map<string, Invite>();
  envelopeLog: EnvelopeRow[] = [];
  private envelopeId = 1;

  asDatabase(): D1Database {
    return { prepare: (sql: string) => this.prepare(sql) } as D1Database;
  }

  private prepare(sql: string): D1PreparedStatement {
    const normalized = sql.replace(/\s+/g, " ").trim();
    let binds: unknown[] = [];

    const stmt = {
      bind: (...args: unknown[]) => {
        binds = args;
        return stmt;
      },
      first: async <T>() => this.first<T>(normalized, binds),
      all: async <T extends Record<string, unknown>>() =>
        this.all<T>(normalized, binds),
      run: async <T extends Record<string, unknown> = Record<string, unknown>>() => {
        await this.run(normalized, binds);
        return {
          success: true as const,
          meta: { ...EMPTY_META },
          results: [] as T[],
        };
      },
      raw: async <T>() => [] as T[],
    };
    return stmt as unknown as D1PreparedStatement;
  }

  private async run(sql: string, binds: unknown[]): Promise<void> {
    if (sql.startsWith("INSERT INTO meshes")) {
      const [id, name, owner_agent_id, is_public] = binds as [
        string,
        string,
        string,
        number,
      ];
      if ([...this.meshes.values()].some((m) => m.name === name)) {
        throw new Error("UNIQUE constraint failed: meshes.name");
      }
      const mesh: Mesh = {
        id,
        name,
        owner_agent_id,
        created_at: new Date().toISOString(),
        is_public,
      };
      this.meshes.set(id, mesh);
      return;
    }

    if (sql.startsWith("INSERT INTO agents")) {
      const [id, mesh_id, display_name, api_key_hash, capabilities] =
        binds as [string, string, string, string, string];
      if (this.agents.has(id)) {
        throw new Error("UNIQUE constraint failed: agents.id");
      }
      const agent: Agent = {
        id,
        mesh_id,
        display_name,
        api_key_hash,
        capabilities,
        created_at: new Date().toISOString(),
        last_seen_at: null,
      };
      this.agents.set(id, agent);
      return;
    }

    if (sql.startsWith("INSERT INTO invites")) {
      const [code, mesh_id, max_uses, expires_at] = binds as [
        string,
        string,
        number,
        string | null,
      ];
      const invite: Invite = {
        code,
        mesh_id,
        max_uses,
        use_count: 0,
        created_at: new Date().toISOString(),
        expires_at,
      };
      this.invites.set(code, invite);
      return;
    }

    if (sql.startsWith("INSERT INTO envelope_log")) {
      const row: EnvelopeRow = {
        id: this.envelopeId++,
        mesh_id: binds[0] as string,
        from_agent: binds[1] as string,
        to_agent: (binds[2] as string | null) ?? null,
        capability: binds[3] as string,
        task_id: (binds[4] as string | null) ?? null,
        type: binds[5] as string,
        payload_size: (binds[6] as number | null) ?? null,
        created_at: new Date().toISOString(),
      };
      this.envelopeLog.push(row);
      return;
    }

    if (sql.includes("UPDATE agents SET mesh_id")) {
      const [mesh_id, id] = binds as [string, string];
      const a = this.agents.get(id);
      if (a) a.mesh_id = mesh_id;
      return;
    }

    if (sql.includes("UPDATE agents SET capabilities")) {
      const [capabilities, id] = binds as [string, string];
      const a = this.agents.get(id);
      if (a) a.capabilities = capabilities;
      return;
    }

    if (sql.includes("UPDATE agents SET last_seen_at")) {
      const [last_seen_at, id] = binds as [string, string];
      const a = this.agents.get(id);
      if (a) a.last_seen_at = last_seen_at;
      return;
    }

    if (sql.includes("UPDATE invites SET use_count")) {
      const [code] = binds as [string];
      const inv = this.invites.get(code);
      if (inv) inv.use_count += 1;
      return;
    }

    throw new Error(`FakeD1: unsupported run SQL: ${sql}`);
  }

  private async first<T>(sql: string, binds: unknown[]): Promise<T | null> {
    const rows = await this.selectRows(sql, binds);
    return (rows[0] as T) ?? null;
  }

  private async all<T extends Record<string, unknown>>(
    sql: string,
    binds: unknown[],
  ): Promise<D1Result<T>> {
    const results = (await this.selectRows(sql, binds)) as T[];
    return { results, success: true, meta: { ...EMPTY_META } };
  }

  private async selectRows(sql: string, binds: unknown[]): Promise<unknown[]> {
    if (sql.includes("FROM meshes WHERE id =")) {
      const [id] = binds as [string];
      const m = this.meshes.get(id);
      return m ? [m] : [];
    }
    if (sql.includes("FROM meshes WHERE name =")) {
      const [name] = binds as [string];
      const m = [...this.meshes.values()].find((x) => x.name === name);
      return m ? [m] : [];
    }
    if (sql.includes("FROM agents WHERE id =")) {
      const [id] = binds as [string];
      const a = this.agents.get(id);
      return a ? [a] : [];
    }
    if (sql.includes("api_key_hash LIKE")) {
      const [pattern] = binds as [string];
      const prefix = pattern.replace("%", "");
      const a = [...this.agents.values()].find((ag) =>
        ag.api_key_hash.startsWith(prefix),
      );
      return a ? [a] : [];
    }
    if (sql.includes("SELECT 1 AS ok FROM agents")) {
      const [id] = binds as [string];
      return this.agents.has(id) ? [{ ok: 1 }] : [];
    }
    if (sql.includes("FROM agents WHERE mesh_id =")) {
      const [mesh_id] = binds as [string];
      return [...this.agents.values()]
        .filter((a) => a.mesh_id === mesh_id)
        .sort((x, y) => x.display_name.localeCompare(y.display_name));
    }
    if (sql.includes("FROM invites WHERE code =")) {
      const [code] = binds as [string];
      const inv = this.invites.get(code);
      return inv ? [inv] : [];
    }
    if (sql.includes("FROM envelope_log")) {
      const [mesh_id, limit] = binds as [string, number];
      return [...this.envelopeLog]
        .filter((e) => e.mesh_id === mesh_id)
        .sort((a, b) => b.id - a.id)
        .slice(0, limit);
    }
    throw new Error(`FakeD1: unsupported select SQL: ${sql}`);
  }
}

export function makeTestEnv(
  fake: FakeD1,
  jwtSecret = "test-jwt-secret-32chars-min!!",
): {
  PM_DB: D1Database;
  MESH_DO: DurableObjectNamespace;
  JWT_SECRET: string;
} {
  return {
    PM_DB: fake.asDatabase(),
    MESH_DO: {
      idFromName: () => ({ toString: () => "do-id" }) as DurableObjectId,
      get: () =>
        ({
          fetch: async () => new Response(null, { status: 204 }),
        }) as unknown as DurableObjectStub,
    } as unknown as DurableObjectNamespace,
    JWT_SECRET: jwtSecret,
  };
}
