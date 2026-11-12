import type { MemorySQLPlugin } from '../../main/core/plugin-host'
import type { MemoriesService } from '../core-schema'
import type { RawMessage } from '../../shared/types'
import { distill } from './distill'
import { buildConflictPrompt, parseConflictResponse } from './conflicts'
import { redactWithCount } from '../../main/core/redact'

/** Memory CRUD for the UI, plus rule-based auto-distillation and conflict detection. */
const VALID_KINDS = new Set(['fact', 'preference', 'persona', 'decision'])
const VALID_SCOPES = new Set(['global', 'project'])

const plugin: MemorySQLPlugin = {
  manifest: {
    id: 'memory-core',
    name: 'Memory Core (CRUD + distill)',
    version: '0.2.0',
    requires: ['core-schema']
  },

  init(ctx) {
    ctx.ipc.handle('save', (payload) => {
      const { id, kind, content, scope, projectId, locked } = (payload ?? {}) as {
        id?: number
        kind?: string
        content?: string
        scope?: string
        projectId?: number | null
        locked?: boolean
      }
      if (kind && !VALID_KINDS.has(kind)) throw new Error(`invalid kind: ${kind}`)
      if (scope && !VALID_SCOPES.has(scope)) throw new Error(`invalid scope: ${scope}`)
      const text = (content ?? '').trim()
      if (!text) throw new Error('content 不能为空')
      const sqlite = ctx.db.sqlite
      if (id) {
        const existing = sqlite
          .prepare('SELECT kind, scope, project_id, locked FROM memories WHERE id = ? AND deleted = 0')
          .get(id) as { kind: string; scope: string; project_id: number | null; locked: number } | undefined
        if (!existing) throw new Error('记忆不存在或已删除')
        const nextScope = scope ?? existing.scope ?? (existing.project_id != null ? 'project' : 'global')
        const nextProject = nextScope === 'global' ? null : (projectId !== undefined ? projectId : existing.project_id)
        if (nextScope === 'project' && nextProject == null) throw new Error('项目记忆必须选择项目')
        // 用户在界面上编辑 = 这条记忆归用户管:默认锁定,自动整理不再覆盖/停用。
        const nextLocked = locked === undefined ? 1 : locked ? 1 : 0
        sqlite
          .prepare(
            `UPDATE memories
                SET kind = ?, content = ?, scope = ?, project_id = ?, locked = ?, updated_at = ?
              WHERE id = ? AND deleted = 0`
          )
          .run(kind ?? existing.kind, text, nextScope, nextProject, nextLocked, Date.now(), id)
        return { id }
      }
      const nextScope = scope ?? (projectId != null ? 'project' : 'global')
      if (nextScope === 'project' && (projectId == null || projectId <= 0)) {
        throw new Error('项目记忆必须选择项目')
      }
      const res = ctx.services.use<MemoriesService>('memories').addMemory({
        kind: kind ?? 'fact',
        content: text,
        source: 'manual',
        projectId: nextScope === 'global' ? null : projectId ?? null,
        scope: nextScope as 'global' | 'project',
        // 手写记忆默认锁定:它是用户明确给出的结论,LLM 只能读不能改
        locked: locked === undefined ? true : locked
      })
      return res
    })

    // 解锁后自动整理可以重新维护这条记忆(用户手动解锁时使用)
    ctx.ipc.handle('setLocked', (payload) => {
      const { id, locked } = (payload ?? {}) as { id?: number; locked?: boolean }
      if (!id) throw new Error('setLocked requires id')
      ctx.db.sqlite
        .prepare('UPDATE memories SET locked = ?, updated_at = ? WHERE id = ? AND deleted = 0')
        .run(locked ? 1 : 0, Date.now(), id)
      return { ok: true }
    })

    ctx.ipc.handle('delete', (payload) => {
      const { id } = (payload ?? {}) as { id?: number }
      if (!id) throw new Error('delete requires id')
      ctx.db.sqlite
        .prepare('UPDATE memories SET deleted = 1, updated_at = ? WHERE id = ?')
        .run(Date.now(), id)
      return { ok: true }
    })

    ctx.ipc.handle('setStatus', (payload) => {
      const { id, status } = (payload ?? {}) as { id?: number; status?: string }
      if (!id || !status || !['candidate', 'active', 'retired'].includes(status)) {
        throw new Error('setStatus requires id + status(candidate|active|retired)')
      }
      ctx.db.sqlite
        .prepare('UPDATE memories SET status = ?, updated_at = ? WHERE id = ?')
        .run(status, Date.now(), id)
      return { ok: true }
    })

    // ---- rule-based distillation: fired after every ingest ----------------
    const distillSession = (sessionId: number): number => {
      const session = ctx.db.sqlite
        .prepare('SELECT agent_type, project_id FROM sessions WHERE id = ? AND deleted = 0')
        .get(sessionId) as { agent_type: string; project_id: number | null } | undefined
      if (!session) return 0
      const source = `distill:${session.agent_type}:${sessionId}`
      // already distilled → skip (upsert-by-source semantics would refresh,
      // but regenerating on every rescan adds churn without new signal)
      if (ctx.db.sqlite.prepare('SELECT id FROM memories WHERE source = ?').get(source)) return 0
      const messages = ctx.db.sqlite
        .prepare('SELECT role, content FROM session_messages WHERE session_id = ? ORDER BY seq')
        .all(sessionId) as Array<{ role: string; content: string }>
      const candidates = distill(session.agent_type, sessionId, messages as RawMessage[])
      const memories = ctx.services.use<MemoriesService>('memories')
      for (const c of candidates) {
        memories.upsertMemory({
          kind: c.kind,
          content: c.content,
          source,
          agentType: session.agent_type,
          status: 'candidate',
          projectId: session.project_id,
          scope: session.project_id != null ? 'project' : 'global'
        })
      }
      return candidates.length
    }

    ctx.events.on('ingest:result', (...args: unknown[]) => {
      const sessionIds = args[0] as number[]
      let produced = 0
      for (const id of sessionIds) produced += distillSession(id)
      if (produced > 0) {
        ctx.log.info(`distilled ${produced} candidate memories from ${sessionIds.length} sessions`)
        ctx.events.emit('sessions:changed')
      }
    })

    // ---- LLM conflict detection: report-only, the user decides -----------
    ctx.ipc.handle('detectConflicts', async () => {
      let refine: { available(): boolean; refine(prompt: string): Promise<string> }
      try {
        refine = ctx.services.use('llm-refine')
      } catch {
        return { ok: false as const, conflicts: [], message: 'LLM 模块未加载' }
      }
      if (!refine.available()) {
        return { ok: false as const, conflicts: [], message: 'LLM 未配置 — 冲突检测需要 LLM(设置页配置摘要引擎后可用)' }
      }
      const rows = ctx.db.sqlite
        .prepare(
          `SELECT id, kind, content FROM memories
           WHERE deleted = 0 AND status IN ('active', 'candidate')
           ORDER BY updated_at DESC LIMIT 60`
        )
        .all() as Array<{ id: number; kind: string; content: string }>
      if (rows.length < 2) return { ok: true as const, conflicts: [], message: '记忆太少,无需检测' }
      const text = await refine.refine(redactWithCount(buildConflictPrompt(rows)).text)
      const validIds = new Set(rows.map((r) => r.id))
      const pairs = parseConflictResponse(text, validIds)
      const byId = new Map(rows.map((r) => [r.id, r]))
      const conflicts = pairs.map((p) => ({
        aId: p.aId,
        bId: p.bId,
        reason: p.reason,
        aExcerpt: byId.get(p.aId)?.content ?? '',
        bExcerpt: byId.get(p.bId)?.content ?? ''
      }))
      return {
        ok: true as const,
        conflicts,
        message: conflicts.length > 0 ? `发现 ${conflicts.length} 组疑似矛盾记忆` : '未发现互相矛盾的记忆'
      }
    })
  }
}

export default plugin
