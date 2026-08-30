import type { Migration } from '../../main/core/db'

export const CORE_MIGRATIONS: Migration[] = [
  {
    version: 1,
    up: `
CREATE TABLE projects (
  id         INTEGER PRIMARY KEY,
  path       TEXT UNIQUE,
  name       TEXT NOT NULL,
  tech_stack TEXT,
  updated_at INTEGER NOT NULL,
  device_id  TEXT,
  deleted    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE sessions (
  id              INTEGER PRIMARY KEY,
  agent_type      TEXT NOT NULL,
  external_id     TEXT NOT NULL,
  project_id      INTEGER REFERENCES projects(id),
  cwd             TEXT,
  started_at      INTEGER,
  ended_at        INTEGER,
  title           TEXT,
  summary         TEXT,
  raw_path        TEXT,
  content_hash    TEXT NOT NULL,
  message_count   INTEGER NOT NULL DEFAULT 0,
  tool_call_count INTEGER NOT NULL DEFAULT 0,
  updated_at      INTEGER NOT NULL,
  device_id       TEXT,
  deleted         INTEGER NOT NULL DEFAULT 0,
  UNIQUE (agent_type, external_id)
);
CREATE INDEX idx_sessions_agent ON sessions(agent_type, started_at DESC);

CREATE TABLE session_messages (
  id         INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL,
  role       TEXT NOT NULL,
  content    TEXT NOT NULL,
  ts         INTEGER,
  tool_name  TEXT,
  meta       TEXT,
  UNIQUE (session_id, seq)
);

CREATE TABLE memories (
  id                INTEGER PRIMARY KEY,
  kind              TEXT NOT NULL,
  content           TEXT NOT NULL,
  source            TEXT,
  source_session_id INTEGER,
  confidence        REAL NOT NULL DEFAULT 1.0,
  status            TEXT NOT NULL DEFAULT 'active',
  updated_at        INTEGER NOT NULL,
  device_id         TEXT,
  deleted           INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_memories_kind ON memories(kind, status);

CREATE TABLE devices (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- FTS5 with trigram tokenizer: substring search that works for CJK text
-- without a segmenter. rowid mirrors the source table id.
CREATE VIRTUAL TABLE sessions_fts USING fts5(title, summary, tokenize='trigram');
CREATE VIRTUAL TABLE messages_fts USING fts5(content, tokenize='trigram');
`
  },
  {
    version: 2,
    up: `
-- v2: per-agent memory dimension (NULL = global across agents)
ALTER TABLE memories ADD COLUMN agent_type TEXT;
CREATE INDEX idx_memories_agent ON memories(agent_type, kind, status);
`
  }
]
