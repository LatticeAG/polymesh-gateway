/** Raw SQL for D1 — all Db queries use bound `?` placeholders */

// ─── Meshes ───────────────────────────────────────────────────────────────────

export const INSERT_MESH = `INSERT INTO meshes (id, name, owner_agent_id, is_public)
 VALUES (?, ?, ?, ?)`;

export const SELECT_MESH_BY_ID = `SELECT * FROM meshes WHERE id = ?`;

export const SELECT_MESH_BY_NAME = `SELECT * FROM meshes WHERE name = ?`;

// ─── Agents ───────────────────────────────────────────────────────────────────

export const INSERT_AGENT = `INSERT INTO agents (id, mesh_id, display_name, api_key_hash, capabilities)
 VALUES (?, ?, ?, ?, ?)`;

export const SELECT_AGENT_BY_ID = `SELECT * FROM agents WHERE id = ?`;

/** Lookup by keyId prefix stored as `keyId$bcryptHash` in api_key_hash */
export const SELECT_AGENT_BY_KEY_PREFIX = `SELECT * FROM agents WHERE api_key_hash LIKE ? LIMIT 1`;

export const UPDATE_AGENT_MESH = `UPDATE agents SET mesh_id = ? WHERE id = ?`;

export const UPDATE_AGENT_CAPABILITIES = `UPDATE agents SET capabilities = ? WHERE id = ?`;

export const UPDATE_AGENT_LAST_SEEN = `UPDATE agents SET last_seen_at = ? WHERE id = ?`;

export const SELECT_AGENTS_BY_MESH = `SELECT * FROM agents WHERE mesh_id = ? ORDER BY display_name`;

export const SELECT_AGENT_EXISTS = `SELECT 1 AS ok FROM agents WHERE id = ?`;

// ─── Invites ──────────────────────────────────────────────────────────────────

export const INSERT_INVITE = `INSERT INTO invites (code, mesh_id, max_uses, expires_at)
 VALUES (?, ?, ?, ?)`;

export const SELECT_INVITE_BY_CODE = `SELECT * FROM invites WHERE code = ?`;

export const UPDATE_INVITE_USE_COUNT = `UPDATE invites SET use_count = use_count + 1 WHERE code = ?`;

// ─── Envelope log ─────────────────────────────────────────────────────────────

export const INSERT_ENVELOPE_LOG = `INSERT INTO envelope_log
   (mesh_id, from_agent, to_agent, capability, task_id, type, payload_size)
 VALUES (?, ?, ?, ?, ?, ?, ?)`;

export const SELECT_ENVELOPE_LOG_BY_MESH = `SELECT * FROM envelope_log
 WHERE mesh_id = ?
 ORDER BY id DESC
 LIMIT ?`;
