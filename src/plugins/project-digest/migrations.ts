import type { Migration } from '../../main/core/db'

/**
 * project-digest 表(插件私有命名空间,经 ctx.db.migrate 迁移):
 * - project_digests:每次总结的产物(历史保留,latest 即最新)
 * - project_digest_state:每项目一行 —— 运行状态/覆盖水位/错误信息
 *
 * 时间单位沿用全库约定:period_*、last_covered_ts 与会话域一致用「秒」;
 * created_at/updated_at/last_digest_at 是墙钟,用「毫秒」(与 memories 一致)。
 */
export const DIGEST_MIGRATIONS: Migration[] = [
  {
    version: 1,
    up: `
CREATE TABLE IF NOT EXISTS project_digests (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id       INTEGER NOT NULL REFERENCES projects(id),
  period_start     INTEGER,
  period_end       INTEGER,
  summary          TEXT NOT NULL DEFAULT '',
  todos            TEXT NOT NULL DEFAULT '[]',
  decisions        TEXT NOT NULL DEFAULT '[]',
  model            TEXT NOT NULL DEFAULT '',
  sessions_covered INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  device_id        TEXT NOT NULL DEFAULT '',
  deleted          INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_digests_project ON project_digests(project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS project_digest_state (
  project_id     INTEGER PRIMARY KEY REFERENCES projects(id),
  status         TEXT NOT NULL DEFAULT 'idle',
  last_digest_at INTEGER,
  last_covered_ts INTEGER,
  last_error     TEXT,
  updated_at     INTEGER NOT NULL DEFAULT 0
);
`
  },
  {
    version: 2,
    up: `
-- v2: 按会话分类(用户 2026-10-26):每个覆盖的会话一条 {id,title,note}
ALTER TABLE project_digests ADD COLUMN per_session TEXT NOT NULL DEFAULT '[]';
`
  }
]
