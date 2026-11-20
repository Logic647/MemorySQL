// 内置知识库的 schema —— MemorySQL 核心表的一个子集，够插件独立使用：
// projects / sessions / session_messages / memories + FTS5。
//
// 时间口径与 MemorySQL 保持一致：sessions 的时间是 **unix 秒**，
// projects/memories.updated_at 是 **毫秒**。
export const SCHEMA_VERSION = 2

const TABLES = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS projects (
  id         INTEGER PRIMARY KEY,
  path       TEXT UNIQUE,
  name       TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted    INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sessions (
  id              INTEGER PRIMARY KEY,
  agent_type      TEXT NOT NULL,
  external_id     TEXT NOT NULL,
  project_id      INTEGER REFERENCES projects(id),
  cwd             TEXT,
  started_at      INTEGER,
  ended_at        INTEGER,
  last_message_at INTEGER,
  title           TEXT,
  summary         TEXT,
  raw_path        TEXT,
  message_count   INTEGER NOT NULL DEFAULT 0,
  tool_call_count INTEGER NOT NULL DEFAULT 0,
  distilled_at    INTEGER,
  distilled_count INTEGER,
  updated_at      INTEGER NOT NULL,
  deleted         INTEGER NOT NULL DEFAULT 0,
  UNIQUE (agent_type, external_id)
);
CREATE TABLE IF NOT EXISTS session_messages (
  id         INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL,
  role       TEXT NOT NULL,
  content    TEXT NOT NULL,
  ts         INTEGER,
  tool_name  TEXT,
  UNIQUE (session_id, seq)
);
CREATE TABLE IF NOT EXISTS memories (
  id             INTEGER PRIMARY KEY,
  kind           TEXT NOT NULL,
  content        TEXT NOT NULL,
  source         TEXT,
  agent_type     TEXT,
  status         TEXT NOT NULL DEFAULT 'active',
  scope          TEXT NOT NULL DEFAULT 'global',
  project_id     INTEGER REFERENCES projects(id),
  tags           TEXT,
  locked         INTEGER NOT NULL DEFAULT 0,
  confidence     REAL NOT NULL DEFAULT 1.0,
  access_count   INTEGER NOT NULL DEFAULT 0,
  last_access_at INTEGER,
  source_session_id INTEGER,
  why            TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  deleted        INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_sessions_agent ON sessions(agent_type, last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id, last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_session ON session_messages(session_id, seq);
CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(scope, project_id, status);
CREATE INDEX IF NOT EXISTS idx_memories_status ON memories(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_memories_content ON memories(content);
`

function createFts(db, name, columns, contentTable) {
  // trigram 对中文检索最好；老 SQLite 没有这个 tokenizer 就退回默认
  try {
    db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS ${name} USING fts5(${columns}, content='${contentTable}', content_rowid='id', tokenize='trigram')`
    )
  } catch {
    db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS ${name} USING fts5(${columns}, content='${contentTable}', content_rowid='id')`
    )
  }
}

const TRIGGERS = `
CREATE TRIGGER IF NOT EXISTS sessions_ai AFTER INSERT ON sessions BEGIN
  INSERT INTO sessions_fts(rowid, title, summary) VALUES (new.id, new.title, new.summary);
END;
CREATE TRIGGER IF NOT EXISTS sessions_ad AFTER DELETE ON sessions BEGIN
  INSERT INTO sessions_fts(sessions_fts, rowid, title, summary) VALUES ('delete', old.id, old.title, old.summary);
END;
CREATE TRIGGER IF NOT EXISTS sessions_au AFTER UPDATE ON sessions BEGIN
  INSERT INTO sessions_fts(sessions_fts, rowid, title, summary) VALUES ('delete', old.id, old.title, old.summary);
  INSERT INTO sessions_fts(rowid, title, summary) VALUES (new.id, new.title, new.summary);
END;
CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON session_messages BEGIN
  INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
END;
CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON session_messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.id, old.content);
END;
CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON session_messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.id, old.content);
  INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
END;
CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
END;
CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.id, old.content);
END;
CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.id, old.content);
  INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
END;
`

const DIGESTS = `
CREATE TABLE IF NOT EXISTS project_digests (
  id               INTEGER PRIMARY KEY,
  project_id       INTEGER NOT NULL REFERENCES projects(id),
  summary          TEXT NOT NULL DEFAULT '',
  recent           TEXT NOT NULL DEFAULT '',
  todos            TEXT NOT NULL DEFAULT '[]',
  model            TEXT NOT NULL DEFAULT '',
  sessions_covered INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  deleted          INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_digests_project ON project_digests(project_id, created_at DESC);
`

function hasColumn(db, table, column) {
  return db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .some((row) => row.name === column)
}

export function migrate(db) {
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()
  let current = row ? Number(row.value) : 0
  if (current < 1) {
    db.exec(TABLES)
    createFts(db, 'sessions_fts', 'title, summary', 'sessions')
    createFts(db, 'messages_fts', 'content', 'session_messages')
    createFts(db, 'memories_fts', 'content', 'memories')
    db.exec(TRIGGERS)
    current = 1
    db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', '1')").run()
  }
  // v2 的补列/建表每次都检查（不只看版本号）：曾经有中间版本把版本写成 2
  // 却没有 ALTER，真库因此缺列；自愈比相信版本号可靠。
  if (!hasColumn(db, 'sessions', 'distilled_at')) {
    db.exec('ALTER TABLE sessions ADD COLUMN distilled_at INTEGER')
  }
  if (!hasColumn(db, 'sessions', 'distilled_count')) {
    db.exec('ALTER TABLE sessions ADD COLUMN distilled_count INTEGER')
  }
  if (!hasColumn(db, 'memories', 'source_session_id')) {
    db.exec('ALTER TABLE memories ADD COLUMN source_session_id INTEGER')
  }
  if (!hasColumn(db, 'memories', 'why')) {
    db.exec('ALTER TABLE memories ADD COLUMN why TEXT')
  }
  db.exec(DIGESTS)
  if (current < 2) {
    db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', '2')").run()
  }
}
