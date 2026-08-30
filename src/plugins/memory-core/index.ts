import type { MemorySQLPlugin } from '../../main/core/plugin-host'
import type { MemoriesService } from '../core-schema'
import type { RawMessage } from '../../shared/types'
import { distill } from './distill'

/** Memory CRUD for the UI, plus rule-based auto-distillation and LLM refinement. */
const VALID_KINDS = new Set(['fact', 'preference', 'persona', 'decision'])

const plugin: MemorySQLPlugin = {
  manifest: {
    id: 'memory-core',
    name: 'Memory Core (CRUD + distill)',
    version: '0.2.0',
    requires: ['core-schema']
  },

  init(ctx) {
    ctx.ipc.handle('save', (payload) => {
      const { id, kind, content } = (payload ?? {}) as {
        id?: number
        kind?: string
        content?: string
      }
      if (kind && !VALID_KINDS.has(kind)) throw new Error(`invalid kind: ${kind}`)
      const text = (content ?? '').trim()
      if (!text) throw new Error('content 不能为空')
      const sqlite = ctx.db.sqlite
      if (id) {
        sqlite
          .prepare('UPDATE memories SET kind = ?, content = ?, updated_at = ? WHERE id = ? AND deleted = 0')
          .run(kind ?? 'fact', text, Date.now(), id)
        return { id }
      }
      const res = ctx.services.use<MemoriesService>('memories').addMemory({
        kind: kind ?? 'fact',
        content: text,
        source: 'manual'
      })
      return res
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
        .prepare('SELECT agent_type FROM sessions WHERE id = ? AND deleted = 0')
        .get(sessionId) as { agent_type: string } | undefined
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
          status: 'candidate'
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

    // ---- LLM refinement of candidates ------------------------------------
    ctx.ipc.handle('refine', async (payload) => {
      const { agentType } = (payload ?? {}) as { agentType?: string }
      let refine: { available(): boolean; refine(prompt: string): Promise<string> }
      try {
        refine = ctx.services.use('llm-refine')
      } catch {
        return { ok: false as const, message: 'LLM 模块未加载' }
      }
      if (!refine.available()) {
        return { ok: false as const, message: 'LLM 未配置或不可用 — 请先在设置页配置摘要引擎' }
      }
      const rows = ctx.db.sqlite
        .prepare(
          `SELECT id, kind, content, agent_type FROM memories
           WHERE status = 'candidate' AND deleted = 0
             AND (source LIKE 'distill:%' OR source LIKE 'manual:%')
             ${agentType ? 'AND agent_type = ?' : ''}
           ORDER BY updated_at DESC LIMIT 60`
        )
        .all(...(agentType ? [agentType] : [])) as Array<{ id: number; kind: string; content: string; agent_type: string | null }>
      if (rows.length === 0) {
        return { ok: true as const, inserted: 0, message: '没有可精炼的候选记忆' }
      }
      const prompt =
        '下面是若干条自动提取的候选记忆(JSON)。请去重、合并同类项,改写为不超过 15 条精炼、互不重复的记忆。' +
        'kind 只能是 fact/preference/persona/decision。只输出 JSON 数组,格式 [{"kind":"…","content":"…"}],不要其它文字。\n' +
        JSON.stringify(rows.map((r) => ({ kind: r.kind, content: r.content })))
      const text = await refine.refine(prompt)
      const cleaned = text.replace(/```json|```/g, '').trim()
      let items: Array<{ kind?: string; content?: string }>
      try {
        items = JSON.parse(cleaned) as Array<{ kind?: string; content?: string }>
      } catch {
        return { ok: false as const, message: `模型输出无法解析: ${text.slice(0, 120)}` }
      }
      const valid = items.filter(
        (i): i is { kind: string; content: string } =>
          typeof i.kind === 'string' && VALID_KINDS.has(i.kind) && typeof i.content === 'string' && i.content.trim().length > 0
      )
      if (valid.length === 0) return { ok: false as const, message: '模型未返回有效记忆' }

      // retire exactly the rows that went into the prompt (incl. manual), and
      // refined products stay candidates until the user confirms them
      const ids = rows.map((r) => r.id)
      const retire = ctx.db.sqlite.prepare(
        `UPDATE memories SET status = 'retired', updated_at = ? WHERE id IN (${ids.map(() => '?').join(',')})`
      )
      const insert = ctx.db.sqlite.prepare(
        `INSERT INTO memories (kind, content, source, agent_type, confidence, status, updated_at, device_id)
         VALUES (?, ?, ?, ?, 0.9, 'candidate', ?, 'local')`
      )
      const run = ctx.db.sqlite.transaction(() => {
        retire.run(Date.now(), ...ids)
        for (const v of valid.slice(0, 20)) {
          insert.run(v.kind, v.content.trim(), `refined:${agentType ?? 'global'}`, agentType ?? null, Date.now())
        }
      })
      run()
      ctx.events.emit('sessions:changed')
      ctx.log.info(`refined ${rows.length} candidates into ${valid.length} candidates awaiting confirmation`)
      return { ok: true as const, inserted: valid.length, message: `已精炼为 ${valid.length} 条` }
    })
  }
}

export default plugin
