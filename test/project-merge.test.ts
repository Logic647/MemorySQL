import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'
import { CORE_MIGRATIONS } from '../src/plugins/core-schema/migrations'
import { normalizeProjects } from '../src/plugins/core-schema/project-merge'
import { projectPathKey } from '../src/shared/project-path'

/**
 * 存量项目合并。2026-11-23 测试报告 P2-5:真库实测 MemorySQL / temp / money
 * 各有 `H:\桌面\X` 与 `H:/桌面/X` 两条登记,会话/记忆/总结被劈成两半。
 */
const win = process.platform === 'win32'

/** 同一目录的多种写法(按平台) */
const SAME_DIR = win
  ? ['H:\\桌面\\demo', 'H:/桌面/demo', 'h:\\桌面\\demo\\']
  : ['/dev/demo', '/dev//demo', '/dev/demo/']

let db: Database.Database

function insertProject(p: string, name: string): number {
  return Number(
    db
      .prepare(`INSERT INTO projects (path, name, updated_at, device_id) VALUES (?, ?, ?, 'local')`)
      .run(p, name, Date.now()).lastInsertRowid
  )
}

function insertSession(projectId: number | null, cwd: string, ext: string): number {
  return Number(
    db
      .prepare(
        `INSERT INTO sessions (agent_type, external_id, project_id, cwd, started_at, title, content_hash, updated_at)
         VALUES ('zcode', ?, ?, ?, 1, 't', ?, 1)`
      )
      .run(ext, projectId, cwd, ext).lastInsertRowid
  )
}

beforeEach(() => {
  db = new Database(':memory:')
  for (const m of CORE_MIGRATIONS) db.exec(m.up)
})

describe('normalizeProjects', () => {
  it('同一目录的不同写法合并:保留会话多的,会话/记忆改指过去', () => {
    const a = insertProject(SAME_DIR[0], 'demo')
    const b = insertProject(SAME_DIR[1], 'demo')
    insertProject(SAME_DIR[2], 'demo')
    // a 有 2 条会话,b 1 条,c 0 条 → 保留 a
    insertSession(a, SAME_DIR[0], 's1')
    insertSession(a, SAME_DIR[0], 's2')
    insertSession(b, SAME_DIR[1], 's3')
    db.prepare(
      `INSERT INTO memories (kind, content, source, status, updated_at, device_id, project_id, scope)
       VALUES ('fact', '项目记忆', 'test', 'active', 1, 'local', ?, 'project')`
    ).run(b)

    const res = normalizeProjects(db)

    expect(res.mergedGroups).toBe(1)
    expect(res.removedProjects).toBe(2)
    const projects = db.prepare(`SELECT id, path FROM projects`).all() as Array<{ id: number; path: string }>
    expect(projects).toHaveLength(1)
    expect(projects[0].id).toBe(a)
    expect(projectPathKey(projects[0].path)).toBe(projectPathKey(SAME_DIR[0]))
    // 三条会话都归到保留项目
    const sessions = db.prepare(`SELECT project_id, cwd FROM sessions`).all() as Array<{
      project_id: number
      cwd: string | null
    }>
    expect(sessions).toHaveLength(3)
    expect(new Set(sessions.map((s) => s.project_id))).toEqual(new Set([a]))
    // 记忆也改指过去
    const mem = db.prepare(`SELECT project_id FROM memories`).get() as { project_id: number }
    expect(mem.project_id).toBe(a)
    // cwd 一并规范化(全部同一写法)
    expect(new Set(sessions.map((s) => s.cwd && projectPathKey(s.cwd))).size).toBe(1)
  })

  it('幂等:第二次运行不再改动', () => {
    insertProject(SAME_DIR[0], 'demo')
    insertProject(SAME_DIR[1], 'demo')
    normalizeProjects(db)
    const second = normalizeProjects(db)
    expect(second.mergedGroups).toBe(0)
    expect(second.removedProjects).toBe(0)
    expect(second.canonicalizedPaths).toBe(0)
  })

  it('project_digests / state 存在时一起改指(不存在则安全跳过)', () => {
    const a = insertProject(SAME_DIR[0], 'demo')
    const b = insertProject(SAME_DIR[1], 'demo')
    db.exec(`CREATE TABLE project_digests (
      id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, summary TEXT NOT NULL DEFAULT '',
      updated_at INTEGER NOT NULL DEFAULT 0, deleted INTEGER NOT NULL DEFAULT 0)`)
    db.exec(`CREATE TABLE project_digest_state (project_id INTEGER PRIMARY KEY, status TEXT)`)
    db.prepare(`INSERT INTO project_digests (project_id, summary) VALUES (?, '旧总结')`).run(b)
    db.prepare(`INSERT INTO project_digest_state (project_id, status) VALUES (?, 'idle')`).run(b)

    normalizeProjects(db)

    const d = db.prepare(`SELECT project_id FROM project_digests`).get() as { project_id: number }
    expect(d.project_id).toBe(a)
    // 状态行搬给保留项目(直接丢弃会连 last_covered_ts 水位一起丢)
    const st = db.prepare(`SELECT project_id, status FROM project_digest_state`).get() as {
      project_id: number
      status: string
    }
    expect(st.project_id).toBe(a)
    expect(st.status).toBe('idle')
  })

  it('不同目录不会被误并(同名前缀也算不同)', () => {
    const a = insertProject(win ? 'H:\\a\\demo' : '/a/demo', 'demo')
    const b = insertProject(win ? 'H:\\a\\demo2' : '/a/demo2', 'demo2')
    const res = normalizeProjects(db)
    expect(res.mergedGroups).toBe(0)
    const ids = (db.prepare(`SELECT id FROM projects ORDER BY id`).all() as Array<{ id: number }>).map((r) => r.id)
    expect(ids).toEqual([a, b])
  })
})
