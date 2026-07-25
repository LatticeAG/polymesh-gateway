CREATE TABLE IF NOT EXISTS meshes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  owner_agent_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  is_public INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  mesh_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  api_key_hash TEXT NOT NULL,
  capabilities TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT,
  FOREIGN KEY (mesh_id) REFERENCES meshes(id)
);
CREATE TABLE IF NOT EXISTS invites (
  code TEXT PRIMARY KEY,
  mesh_id TEXT NOT NULL,
  max_uses INTEGER DEFAULT 0,
  use_count INTEGER DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT,
  FOREIGN KEY (mesh_id) REFERENCES meshes(id)
);
CREATE TABLE IF NOT EXISTS envelope_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mesh_id TEXT NOT NULL,
  from_agent TEXT NOT NULL,
  to_agent TEXT,
  capability TEXT NOT NULL,
  task_id TEXT,
  type TEXT NOT NULL,
  payload_size INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_agents_mesh ON agents(mesh_id);
CREATE INDEX IF NOT EXISTS idx_envelope_mesh ON envelope_log(mesh_id);
CREATE INDEX IF NOT EXISTS idx_envelope_task ON envelope_log(task_id);
