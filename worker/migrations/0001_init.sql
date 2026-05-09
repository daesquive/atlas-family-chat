-- Atlas Family Chat — Phase 4 schema
-- Tiered TTL policy decided 2026-05-09. See plan.md for full spec.

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  is_private INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_user_time ON messages(user, created_at);

CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user TEXT NOT NULL,
  fact TEXT NOT NULL,
  tier TEXT NOT NULL,
  source_message_id INTEGER,
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  superseded_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_memories_user_active ON memories(user, expires_at, superseded_at);
CREATE INDEX IF NOT EXISTS idx_memories_user_tier ON memories(user, tier);
