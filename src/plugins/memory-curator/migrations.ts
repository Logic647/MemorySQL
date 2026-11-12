import type { Migration } from '../../main/core/db'

/**
 * memory-curator 的私有状态表。
 *
 * project_id = 0 这一行表示「全局整理」——项目 id 从 1 开始,不会撞。
 * last_digest_id 是幂等键:同一个 digest 只整理一次,重复事件/重启补跑都靠它。
 */
export const CURATOR_MIGRATIONS: Migration[] = [
  {
    version: 1,
    up: `
CREATE TABLE IF NOT EXISTS memory_curation_state (
  project_id     INTEGER PRIMARY KEY,
  last_digest_id INTEGER,
  last_run_at    INTEGER,
  last_error     TEXT,
  status         TEXT NOT NULL DEFAULT 'idle',
  updated_at     INTEGER NOT NULL DEFAULT 0
);
`
  }
]
