import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { normalizeProjects } from '../src/plugins/core-schema/project-merge'

/**
 * 真库副本上的项目合并验收(默认跳过,只在显式指定副本时跑)。
 *
 *   MEMORYSQL_MERGE_DB=<memory.db 副本路径> npx vitest run test/real-db-merge-check.test.ts
 *
 * ⚠ 只指向**副本**:这个用例会真实写库。指向正在运行的装机版真库会破坏数据
 * (WAL 并发写 + 单实例缓存),所以变量名和注释都写明副本。
 */
const copy = process.env.MEMORYSQL_MERGE_DB

describe.skipIf(!copy)('real DB copy: project merge', () => {
  it('合并同路径不同写法:行数守恒、无孤儿、幂等', () => {
    const db = new Database(copy!, { fileMustExist: true })
    const count = (sql: string): number => (db.prepare(sql).get() as { n: number }).n
    const snapshot = (): Record<string, number> => ({
      projects: count('SELECT COUNT(*) n FROM projects'),
      sessions: count('SELECT COUNT(*) n FROM sessions'),
      memories: count('SELECT COUNT(*) n FROM memories'),
      digests: count('SELECT COUNT(*) n FROM project_digests')
    })
    const before = snapshot()

    const res = normalizeProjects(db)
    const after = snapshot()

    // 只删重复的项目行;业务行一个都不能少
    expect(after.projects).toBe(before.projects - res.removedProjects)
    expect(after.sessions).toBe(before.sessions)
    expect(after.memories).toBe(before.memories)
    expect(after.digests).toBe(before.digests)
    // 改指之后不允许留下指向不存在项目的行
    expect(
      count(
        `SELECT COUNT(*) n FROM sessions s WHERE s.project_id IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM projects p WHERE p.id = s.project_id)`
      )
    ).toBe(0)
    expect(
      count(
        `SELECT COUNT(*) n FROM memories m WHERE m.project_id IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM projects p WHERE p.id = m.project_id)`
      )
    ).toBe(0)
    // 幂等
    const second = normalizeProjects(db)
    expect(second.mergedGroups).toBe(0)
    expect(second.removedProjects).toBe(0)
    db.close()
  })
})
