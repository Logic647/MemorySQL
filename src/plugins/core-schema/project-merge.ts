import type Database from 'better-sqlite3'
import { canonicalProjectPath, projectPathKey } from '../../shared/project-path'

/**
 * 存量项目合并 —— 把「同一物理目录、不同分隔符写法」的项目并成一个。
 *
 * 2026-11-23 测试报告 P2-5:真库实测 MemorySQL / temp / money 各有两条登记
 * (`H:\桌面\X` 与 `H:/桌面/X`),会话、记忆、总结被劈成两半。写入侧已在
 * `ensureProject` 归一(shared/project-path.ts),这里负责一次性把存量并掉。
 *
 * 合并规则:
 *   - 分组键 = projectPathKey(path)(Windows 大小写不敏感)
 *   - 保留会话最多的那条(并列取 id 最小),其余行的 sessions / memories /
 *     project_digests / *_state 全部改指保留行,然后删除多余行
 *   - 保留行的 path 写回规范形式;该项目的会话 cwd 也一并规范化
 *   - project_digests / project_digest_state / memory_curation_state 可能尚未
 *     建表(首次安装时 project-digest / memory-curator 还没 migrate),用
 *     sqlite_master 探测后跳过
 */

interface ProjectRow {
  id: number
  path: string
  name: string | null
  deleted: number
}

export interface ProjectMergeResult {
  mergedGroups: number
  removedProjects: number
  repointedRows: number
  canonicalizedPaths: number
}

const tableExists = (sqlite: Database.Database, name: string): boolean =>
  !!sqlite
    .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(name)

export function normalizeProjects(sqlite: Database.Database): ProjectMergeResult {
  const result: ProjectMergeResult = {
    mergedGroups: 0,
    removedProjects: 0,
    repointedRows: 0,
    canonicalizedPaths: 0
  }
  const rows = sqlite
    .prepare(`SELECT id, path, name, deleted FROM projects WHERE path IS NOT NULL AND path != ''`)
    .all() as ProjectRow[]
  if (rows.length === 0) return result

  const groups = new Map<string, ProjectRow[]>()
  for (const r of rows) {
    const key = projectPathKey(r.path)
    const bucket = groups.get(key)
    if (bucket) bucket.push(r)
    else groups.set(key, [r])
  }

  const hasDigests = tableExists(sqlite, 'project_digests')
  const hasDigestState = tableExists(sqlite, 'project_digest_state')
  const hasCurationState = tableExists(sqlite, 'memory_curation_state')

  const countSessions = sqlite.prepare(
    `SELECT COUNT(*) AS n FROM sessions WHERE project_id = ? AND deleted = 0`
  )
  const stmtSessionsRepoint = sqlite.prepare(`UPDATE sessions SET project_id = ? WHERE project_id = ?`)
  const stmtMemoriesRepoint = sqlite.prepare(`UPDATE memories SET project_id = ? WHERE project_id = ?`)
  const stmtDigestsRepoint = hasDigests
    ? sqlite.prepare(`UPDATE project_digests SET project_id = ? WHERE project_id = ?`)
    : null
  const stmtDigestStateDel = hasDigestState
    ? sqlite.prepare(`DELETE FROM project_digest_state WHERE project_id = ?`)
    : null
  const stmtCurationDel = hasCurationState
    ? sqlite.prepare(`DELETE FROM memory_curation_state WHERE project_id = ?`)
    : null
  const stmtDigestStateMove = hasDigestState
    ? sqlite.prepare(`UPDATE project_digest_state SET project_id = ? WHERE project_id = ?`)
    : null
  const stmtDigestStateHas = hasDigestState
    ? sqlite.prepare(`SELECT 1 FROM project_digest_state WHERE project_id = ?`)
    : null
  const stmtCurationMove = hasCurationState
    ? sqlite.prepare(`UPDATE memory_curation_state SET project_id = ? WHERE project_id = ?`)
    : null
  const stmtCurationHas = hasCurationState
    ? sqlite.prepare(`SELECT 1 FROM memory_curation_state WHERE project_id = ?`)
    : null
  const stmtProjectDel = sqlite.prepare(`DELETE FROM projects WHERE id = ?`)
  const stmtProjectPath = sqlite.prepare(`UPDATE projects SET path = ?, updated_at = ? WHERE id = ?`)
  const stmtSessionCwds = sqlite.prepare(`SELECT id, cwd FROM sessions WHERE project_id = ? AND cwd IS NOT NULL`)

  const tx = sqlite.transaction(() => {
    for (const list of groups.values()) {
      const canonical = canonicalProjectPath(list[0].path)
      if (list.length === 1) {
        const only = list[0]
        if (only.path !== canonical) {
          stmtProjectPath.run(canonical, Date.now(), only.id)
          result.canonicalizedPaths += 1
        }
        canonicalizeSessionCwds(only.id)
        continue
      }

      // 保留行:会话最多的;并列取 id 最小
      const ranked = [...list].sort((a, b) => {
        const na = (countSessions.get(a.id) as { n: number }).n
        const nb = (countSessions.get(b.id) as { n: number }).n
        return nb - na || a.id - b.id
      })
      const keeper = ranked[0]

      for (const dup of ranked.slice(1)) {
        const s = stmtSessionsRepoint.run(keeper.id, dup.id)
        const m = stmtMemoriesRepoint.run(keeper.id, dup.id)
        const d = stmtDigestsRepoint?.run(keeper.id, dup.id).changes ?? 0
        result.repointedRows += s.changes + m.changes + d
        // 状态表以 project_id 为主键:保留行已有状态时重复行丢弃;否则**搬过去**
        // (直接删会连 last_covered_ts 水位一起丢,下次总结会把老会话重嚼一遍)
        moveOrDrop(stmtDigestStateHas, stmtDigestStateMove, stmtDigestStateDel, keeper.id, dup.id)
        moveOrDrop(stmtCurationHas, stmtCurationMove, stmtCurationDel, keeper.id, dup.id)
        stmtProjectDel.run(dup.id)
        result.removedProjects += 1
      }
      if (keeper.path !== canonical) {
        stmtProjectPath.run(canonical, Date.now(), keeper.id)
        result.canonicalizedPaths += 1
      }
      canonicalizeSessionCwds(keeper.id)
      result.mergedGroups += 1
    }
  })

  function moveOrDrop(
    has: Database.Statement | null,
    move: Database.Statement | null,
    del: Database.Statement | null,
    keeperId: number,
    dupId: number
  ): void {
    if (!has || !move || !del) return
    try {
      if (has.get(keeperId) == null) move.run(keeperId, dupId)
      else del.run(dupId)
    } catch {
      /* 状态表结构差异(旧版本)不影响项目合并本身 */
    }
  }

  function canonicalizeSessionCwds(projectId: number): void {
    const cwds = stmtSessionCwds.all(projectId) as Array<{ id: number; cwd: string }>
    for (const row of cwds) {
      const next = canonicalProjectPath(row.cwd)
      if (next !== row.cwd) {
        sqlite.prepare(`UPDATE sessions SET cwd = ? WHERE id = ?`).run(next, row.id)
        result.canonicalizedPaths += 1
      }
    }
  }

  tx()
  return result
}
