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
  },
  {
    version: 3,
    up: `
-- v3: memories enter the FTS index. Triggers keep memories_fts in sync from
-- every write path (ingest / memory-core / sync-folder / future plugins),
-- so no call site has to remember to maintain the index by hand.
CREATE VIRTUAL TABLE memories_fts USING fts5(content, tokenize='trigram');

INSERT INTO memories_fts (rowid, content)
  SELECT id, content FROM memories WHERE deleted = 0;

CREATE TRIGGER memories_fts_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts (rowid, content) VALUES (new.id, new.content);
END;
CREATE TRIGGER memories_fts_au AFTER UPDATE OF content, deleted ON memories BEGIN
  DELETE FROM memories_fts WHERE rowid = old.id;
  INSERT INTO memories_fts (rowid, content)
    SELECT new.id, new.content WHERE new.deleted = 0;
END;
CREATE TRIGGER memories_fts_ad AFTER DELETE ON memories BEGIN
  DELETE FROM memories_fts WHERE rowid = old.id;
END;
`
  },
  {
    version: 4,
    up: `
-- v4: MCP memory_write attribution (matrix v2) — agent-reported project
-- linkage and free-form tags on memories
ALTER TABLE memories ADD COLUMN tags TEXT;
ALTER TABLE memories ADD COLUMN project_id INTEGER REFERENCES projects(id);
CREATE INDEX idx_memories_project ON memories(project_id);
`
  },
  {
    version: 5,
    up: `
-- v5: session curation (matrix v2 follow-ups)
ALTER TABLE sessions ADD COLUMN title_locked INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN similar_to INTEGER REFERENCES sessions(id);
CREATE INDEX idx_sessions_archived ON sessions(archived, deleted);
`
  }
]
