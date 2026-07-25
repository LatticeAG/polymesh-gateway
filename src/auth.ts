/** JWT issue/verify + API key hashing (bcrypt) */

import bcrypt from "bcryptjs";
import { SignJWT, jwtVerify, errors as JoseErrors } from "jose";
import type { JWTPayload } from "./types";
import { nowIso } from "./utils";

const BCRYPT_COST = 10;
const JWT_ALG = "HS256";
const DEFAULT_TTL_SEC = 3600;

/** Store format in D1 api_key_hash: `${keyId}$${bcryptHash}` */
export function formatStoredHash(keyId: string, bcryptHash: string): string {
  return `${keyId}$${bcryptHash}`;
}

export function parseStoredHash(
  stored: string,
): { keyId: string; bcryptHash: string } | null {
  const idx = stored.indexOf("$");
  // bcrypt hashes start with $2a$ / $2b$ — our format is keyId$<bcrypt>
  // keyId has no `$`, bcrypt starts with `$2`
  // So split on first `$` only if remaining looks like bcrypt.
  if (idx <= 0) return null;
  const keyId = stored.slice(0, idx);
  const bcryptHash = stored.slice(idx + 1);
  if (!keyId || !bcryptHash.startsWith("$2")) return null;
  return { keyId, bcryptHash };
}

export async function hashApiKey(apiKey: string): Promise<string> {
  return bcrypt.hash(apiKey, BCRYPT_COST);
}

export async function verifyApiKey(
  apiKey: string,
  hashOrStored: string,
): Promise<boolean> {
  const parsed = parseStoredHash(hashOrStored);
  const hash = parsed ? parsed.bcryptHash : hashOrStored;
  try {
    return await bcrypt.compare(apiKey, hash);
  } catch {
    return false;
  }
}

function secretKey(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

export async function issueJwt(
  payload: { sub: string; mesh: string },
  secret: string,
  expiresInSec = DEFAULT_TTL_SEC,
): Promise<{ token: string; expires_at: string }> {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + expiresInSec;
  const token = await new SignJWT({ mesh: payload.mesh })
    .setProtectedHeader({ alg: JWT_ALG })
    .setSubject(payload.sub)
    .setIssuedAt(now)
    .setExpirationTime(exp)
    .sign(secretKey(secret));

  return {
    token,
    expires_at: new Date(exp * 1000).toISOString(),
  };
}

export async function verifyJwt(
  token: string,
  secret: string,
): Promise<JWTPayload> {
  try {
    const { payload } = await jwtVerify(token, secretKey(secret), {
      algorithms: [JWT_ALG],
    });
    const sub = payload.sub;
    const mesh = payload.mesh;
    if (typeof sub !== "string" || !sub) {
      throw new Error("JWT missing sub");
    }
    if (typeof mesh !== "string" || !mesh) {
      throw new Error("JWT missing mesh claim");
    }
    if (typeof payload.exp !== "number") {
      throw new Error("JWT missing exp");
    }
    return {
      sub,
      mesh,
      exp: payload.exp,
      iat: typeof payload.iat === "number" ? payload.iat : undefined,
    };
  } catch (err) {
    if (err instanceof JoseErrors.JWTExpired) {
      throw Object.assign(new Error("Token expired"), {
        code: "token_expired",
        status: 401,
      });
    }
    throw Object.assign(new Error("Invalid token"), {
      code: "invalid_token",
      status: 401,
    });
  }
}

/** Prefer Authorization: Bearer, fall back to ?token= */
export function extractBearerOrQueryToken(request: Request): string | null {
  const auth = request.headers.get("Authorization");
  if (auth?.toLowerCase().startsWith("bearer ")) {
    const t = auth.slice(7).trim();
    if (t) return t;
  }
  const url = new URL(request.url);
  const q = url.searchParams.get("token");
  return q && q.length > 0 ? q : null;
}

export function secondsUntilExpiry(payload: JWTPayload): number {
  return payload.exp - Math.floor(Date.now() / 1000);
}

export function tokenExpiringSoon(
  payload: JWTPayload,
  thresholdSec = 300,
): boolean {
  return secondsUntilExpiry(payload) <= thresholdSec;
}

/** Convenience for logging */
export function authDebugNow(): string {
  return nowIso();
}
