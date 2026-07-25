import { describe, expect, it } from "vitest";
import { SignJWT } from "jose";
import {
  extractBearerOrQueryToken,
  formatStoredHash,
  hashApiKey,
  issueJwt,
  parseStoredHash,
  verifyApiKey,
  verifyJwt,
} from "../src/auth";
import { Db } from "../src/db/schema";
import {
  generateApiKey,
  parseApiKey,
} from "../src/utils";
import {
  secondsUntilExpiry,
  tokenExpiringSoon,
} from "../src/auth";
import { FakeD1 } from "./fake-d1";

const JWT_SECRET = "unit-test-jwt-secret-key-32b";

describe("generateApiKey", () => {
  it("returns pmgk_ prefix format", () => {
    const { apiKey, keyId, secret } = generateApiKey();
    expect(apiKey.startsWith("pmgk_")).toBe(true);
    expect(apiKey).toBe(`pmgk_${keyId}_${secret}`);
  });

  it("parseApiKey round-trips key parts", () => {
    const { apiKey, keyId, secret } = generateApiKey();
    const parsed = parseApiKey(apiKey);
    expect(parsed).toEqual({ keyId, secret });
  });

  it("rejects malformed keys", () => {
    expect(parseApiKey("")).toBeNull();
    expect(parseApiKey("fmsgk_x_y")).toBeNull();
    expect(parseApiKey("pmgk_only")).toBeNull();
  });

  it("generates distinct keys each call", () => {
    const a = generateApiKey().apiKey;
    const b = generateApiKey().apiKey;
    expect(a).not.toBe(b);
  });
});

describe("hashApiKey / verifyApiKey", () => {
  it("verifies correct secret against raw bcrypt hash", async () => {
    const apiKey = generateApiKey().apiKey;
    const hash = await hashApiKey(apiKey);
    expect(await verifyApiKey(apiKey, hash)).toBe(true);
    expect(await verifyApiKey(apiKey + "x", hash)).toBe(false);
  });

  it("verifies against formatStoredHash blob", async () => {
    const { apiKey, keyId } = generateApiKey();
    const bcryptHash = await hashApiKey(apiKey);
    const stored = formatStoredHash(keyId, bcryptHash);
    expect(await verifyApiKey(apiKey, stored)).toBe(true);
  });

  it("returns false for corrupt bcrypt", async () => {
    expect(await verifyApiKey("pmgk_a_b", "not-a-hash")).toBe(false);
  });
});

describe("formatStoredHash / parseStoredHash", () => {
  it("joins keyId and bcrypt with single delimiter", () => {
    const bcrypt = "$2a$10$abcdefghijklmnopqrstuv";
    expect(formatStoredHash("kid123", bcrypt)).toBe("kid123$" + bcrypt);
  });

  it("parses valid stored hash", () => {
    const bcrypt = "$2b$10$N9qo8uLOickgx2ZMRZoMye";
    const parsed = parseStoredHash(`mykey$${bcrypt}`);
    expect(parsed).toEqual({ keyId: "mykey", bcryptHash: bcrypt });
  });

  it("rejects missing keyId or non-bcrypt tail", () => {
    expect(parseStoredHash("$2a$10$abc")).toBeNull();
    expect(parseStoredHash("key$plain")).toBeNull();
    expect(parseStoredHash("")).toBeNull();
  });
});

describe("getAgentByKeyId (D1 pattern)", () => {
  it("finds agent by keyId prefix in api_key_hash", async () => {
    const fake = new FakeD1();
    const db = new Db(fake.asDatabase());
    const meshId = crypto.randomUUID();
    await db.createMesh({
      id: meshId,
      name: "auth-mesh",
      owner_agent_id: "owner@latticeag",
    });
    const { apiKey, keyId } = generateApiKey();
    const stored = formatStoredHash(keyId, await hashApiKey(apiKey));
    await db.createAgent({
      id: "alice@latticeag",
      mesh_id: meshId,
      display_name: "Alice",
      api_key_hash: stored,
    });
    const found = await db.getAgentByKeyId(keyId);
    expect(found?.id).toBe("alice@latticeag");
    expect(found?.api_key_hash).toBe(stored);
    expect(await db.getAgentByKeyId("wrong-id")).toBeNull();
  });
});

describe("issueJwt / verifyJwt", () => {
  it("issues verifiable JWT with sub and mesh", async () => {
    const { token, expires_at } = await issueJwt(
      { sub: "bob@latticeag", mesh: "mesh-1" },
      JWT_SECRET,
    );
    expect(expires_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const payload = await verifyJwt(token, JWT_SECRET);
    expect(payload.sub).toBe("bob@latticeag");
    expect(payload.mesh).toBe("mesh-1");
    expect(payload.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it("rejects expired token", async () => {
    const { token } = await issueJwt(
      { sub: "bob@latticeag", mesh: "mesh-1" },
      JWT_SECRET,
      -60,
    );
    await expect(verifyJwt(token, JWT_SECRET)).rejects.toMatchObject({
      code: "token_expired",
      status: 401,
    });
  });

  it("rejects wrong signing secret", async () => {
    const { token } = await issueJwt(
      { sub: "bob@latticeag", mesh: "mesh-1" },
      JWT_SECRET,
    );
    await expect(verifyJwt(token, "other-secret-key-32chars-minimum!")).rejects.toMatchObject({
      code: "invalid_token",
    });
  });

  it("rejects token missing mesh claim", async () => {
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("bob@latticeag")
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode(JWT_SECRET));
    await expect(verifyJwt(token, JWT_SECRET)).rejects.toMatchObject({
      code: "invalid_token",
    });
  });

  it("tokenExpiringSoon respects threshold", async () => {
    const { token } = await issueJwt(
      { sub: "a@latticeag", mesh: "m" },
      JWT_SECRET,
      120,
    );
    const payload = await verifyJwt(token, JWT_SECRET);
    expect(tokenExpiringSoon(payload, 300)).toBe(true);
    expect(secondsUntilExpiry(payload)).toBeLessThanOrEqual(120);
  });
});

describe("extractBearerOrQueryToken", () => {
  it("reads Authorization Bearer header", () => {
    const req = new Request("https://gw.example/api", {
      headers: { Authorization: "Bearer abc.def.ghi" },
    });
    expect(extractBearerOrQueryToken(req)).toBe("abc.def.ghi");
  });

  it("is case-insensitive on bearer scheme", () => {
    const req = new Request("https://gw.example/api", {
      headers: { Authorization: "bearer tok" },
    });
    expect(extractBearerOrQueryToken(req)).toBe("tok");
  });

  it("falls back to ?token= query param", () => {
    const req = new Request("https://gw.example/ws?token=query-jwt");
    expect(extractBearerOrQueryToken(req)).toBe("query-jwt");
  });

  it("prefers Bearer over query token", () => {
    const req = new Request("https://gw.example/ws?token=q", {
      headers: { Authorization: "Bearer header-jwt" },
    });
    expect(extractBearerOrQueryToken(req)).toBe("header-jwt");
  });

  it("returns null when no token present", () => {
    const req = new Request("https://gw.example/api");
    expect(extractBearerOrQueryToken(req)).toBeNull();
  });
});
