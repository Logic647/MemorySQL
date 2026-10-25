import fs from 'node:fs'
import path from 'node:path'
import type { MemorySQLPlugin } from '../../main/core/plugin-host'
import { DIGEST_MIGRATIONS } from './migrations'
import {
  buildDigestMd,
  buildDigestMcpText,
  buildDigestPrompt,
  buildRulesDigest,
  DIGEST_MAX_SESSIONS_PER_RUN,
  DIGEST_SYSTEM_PROMPT,
  parseDigestResponse,
  shouldRunCatchup,
  type DigestResult,
  type DigestSessionInput,
  type DigestTodo
} from './digest'

/**
 * Project Digest —— hindsight 式项目滚动总结:
 * 每个项目把「上次总结之后的新会话」滚动总结成 摘要+待办+决策,产物进
 * project_digests 表(权威)与 vault/digest/*.md(人读);agent 用
 * memory_get_project_digest 读这一份代替翻大量会话。
 *
 * 隐私总开关 `project-digest:enabled` 默认关闭 —— 开启前不挂任何自动触发、
 * 不外发任何数据。开启后:LLM 引擎可用 → LLM 总结(素材先 redact 脱敏);
 * 不可用 → 规则式本地总结(零外发)。手动触发(立即总结按钮 / --digest CLI)
 * 视为显式用户意图,不受开关拦截。
 */
const plugin: MemorySQLPlugin = {
  manifest: {
    id: 'project-digest',
    name: 'Project Digest (rolling summary)',
    version: '0.1.0',
    requires: ['core-schema']
  },

  init(ctx) {
    ctx.db.migrate(DIGEST_MIGRATIONS)
    const sqlite = ctx.db.sqlite
    const enabled = (): boolean => ctx.settings.get<boolean>('enabled', false)
    const quietMinutes = (): number => Math.max(1, Number(ctx.settings.get<number>('quietMinutes', 30)) || 30)

    // ---- statements -------------------------------------------------------
    const stmtProject = sqlite.prepare('SELECT id, name FROM projects WHERE id = ? AND deleted = 0')
    const stmtState = sqlite.prepare('SELECT * FROM project_digest_state WHERE project_id = ?')
    const stmtUpsertState = sqlite.prepare(`
      INSERT INTO project_digest_state (project_id, status, last_digest_at, last_covered_ts, last_error, updated_at)
      VALUES (@project_id, @status, @last_digest_at, @last_covered_ts, @last_error, @updated_at)
      ON CONFLICT(project_id) DO UPDATE SET
        status = excluded.status,
        last_digest_at = COALESCE(excluded.last_digest_at, project_digest_state.last_digest_at),
        last_covered_ts = COALESCE(excluded.last_covered_ts, project_digest_state.last_covered_ts),
        last_error = excluded.last_error,
        updated_at = excluded.updated_at
    `)
    const stmtLatestDigest = sqlite.prepare(`
      SELECT * FROM project_digests WHERE project_id = ? AND deleted = 0
      ORDER BY created_at DESC LIMIT 1
    `)
    const stmtInsertDigest = sqlite.prepare(`
      INSERT INTO project_digests
        (project_id, period_start, period_end, summary, todos, decisions, model, sessions_covered,
         created_at, updated_at, device_id)
      VALUES (@project_id, @period_start, @period_end, @summary, @todos, @decisions, @model, @sessions_covered,
              @created_at, @updated_at, 'local')
    `)
    const stmtSessions = sqlite.prepare(`
      SELECT s.id, s.agent_type AS agentType, s.title, s.summary,
             s.message_count AS messageCount, s.tool_call_count AS toolCallCount,
             COALESCE(s.last_message_at, s.started_at) AS ts,
             (SELECT m.content FROM session_messages m WHERE m.session_id = s.id AND m.role = 'user' ORDER BY m.seq LIMIT 1) AS firstUser,
             (SELECT m.content FROM session_messages m WHERE m.session_id = s.id AND m.role = 'assistant' ORDER BY m.seq DESC LIMIT 1) AS lastAssistant
      FROM sessions s
      WHERE s.deleted = 0 AND s.project_id = ?
        AND COALESCE(s.last_message_at, s.started_at) IS NOT NULL
        AND COALESCE(s.last_message_at, s.started_at) > ?
      ORDER BY ts ASC
      LIMIT ${DIGEST_MAX_SESSIONS_PER_RUN}
    `)
    const stmtPendingProgress = sqlite.prepare(`
      SELECT content FROM memories
      WHERE status = 'candidate' AND deleted = 0 AND source LIKE 'agent:mcp:log_progress%'
      ORDER BY updated_at DESC LIMIT 8
    `)
    const stmtInsertCandidate = sqlite.prepare(`
      INSERT INTO memories (kind, content, source, updated_at, device_id, status, project_id)
      VALUES (?, ?, ?, ?, 'local', 'candidate', ?)
    `)
    const stmtCandidateDup = sqlite.prepare(
      `SELECT 1 FROM memories WHERE deleted = 0 AND source = ? AND content = ?`
    )
    const stmtProjectsWithSessions = sqlite.prepare(`
      SELECT p.id FROM projects p
      WHERE p.deleted = 0 AND EXISTS (SELECT 1 FROM sessions s WHERE s.deleted = 0 AND s.project_id = p.id)
    `)
    const stmtActiveProject = sqlite.prepare(`
      SELECT p.id, p.name FROM projects p
      JOIN sessions s ON s.project_id = p.id AND s.deleted = 0
      WHERE p.deleted = 0
      ORDER BY COALESCE(s.last_message_at, s.started_at) DESC LIMIT 1
    `)
    const stmtProjectByKeyword = sqlite.prepare(`
      SELECT p.id, p.name FROM projects p
      WHERE p.deleted = 0 AND (p.name LIKE ? OR p.path LIKE ?)
      ORDER BY p.updated_at DESC LIMIT 1
    `)

    // ---- llm-refine(懒取:summarizer-llm 被停用时消化成规则模式,不炸) ---
    interface RefineService {
      available(): boolean
      refine(prompt: string, opts?: { system?: string; maxTokens?: number }): Promise<string>
      describe?(): string
    }
    const tryUseRefine = (): RefineService | null => {
      try {
        return ctx.services.use<RefineService>('llm-refine')
      } catch {
        return null
      }
    }

    // ---- 运行核心 ----------------------------------------------------------
    const running = new Set<number>()
    const notify = (projectId: number): void => {
      ctx.events.emit('digest:changed', { projectId })
    }

    const setState = (
      projectId: number,
      patch: { status: string; last_digest_at?: number | null; last_covered_ts?: number | null; last_error?: string | null }
    ): void => {
      stmtUpsertState.run({
        project_id: projectId,
        status: patch.status,
        last_digest_at: patch.last_digest_at ?? null,
        last_covered_ts: patch.last_covered_ts ?? null,
        last_error: patch.last_error ?? null,
        updated_at: Date.now()
      })
    }

    const writeVaultMd = (projectName: string, result: DigestResult, meta: Parameters<typeof buildDigestMd>[1]): void => {
      const safe = projectName.replace(/[\\/:*?"<>|\n\r]/g, '_').slice(0, 60) || 'project'
      const dir = path.join(ctx.env.vaultDir, 'digest')
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, `${safe}.md`), buildDigestMd(result, meta), 'utf-8')
    }

    const runDigest = async (
      projectId: number,
      opts: { manual?: boolean } = {}
    ): Promise<{ ok: boolean; message: string }> => {
      if (!opts.manual && !enabled()) return { ok: false, message: '项目总结未开启' }
      if (running.has(projectId)) return { ok: false, message: '该项目正在总结中' }
      const project = stmtProject.get(projectId) as { id: number; name: string } | undefined
      if (!project) return { ok: false, message: '项目不存在' }
      running.add(projectId)
      setState(projectId, { status: 'running' })
      notify(projectId)
      try {
        const state = stmtState.get(projectId) as
          | { last_digest_at: number | null; last_covered_ts: number | null }
          | undefined
        const coveredBefore = state?.last_covered_ts ?? 0
        const sessions = stmtSessions.all(projectId, coveredBefore) as DigestSessionInput[]
        if (sessions.length === 0) {
          setState(projectId, { status: 'idle' })
          return { ok: true, message: '没有新会话需要总结' }
        }
        const prevRow = stmtLatestDigest.get(projectId) as
          | { summary: string; todos: string }
          | undefined
        const prev =
          prevRow != null
            ? { summary: prevRow.summary, todos: JSON.parse(prevRow.todos || '[]') as DigestTodo[] }
            : null

        const prompt = buildDigestPrompt(project.name, sessions, prev)
        let result: DigestResult | null = null
        let model = 'rules'
        let llmError: string | null = null
        const refine = tryUseRefine()
        if (refine?.available()) {
          try {
            const text = await refine.refine(prompt, { system: DIGEST_SYSTEM_PROMPT, maxTokens: 2000 })
            const parsed = parseDigestResponse(text)
            if (parsed) {
              result = parsed
              model = `llm:${refine.describe?.() ?? 'configured'}`
            } else {
              llmError = 'LLM 返回无法解析为 JSON,已回落规则总结'
            }
          } catch (err) {
            llmError = `LLM 调用失败: ${String(err instanceof Error ? err.message : err)}`
          }
        }
        if (!result) {
          result = buildRulesDigest(
            project.name,
            sessions,
            prev,
            (stmtPendingProgress.all() as Array<{ content: string }>).map((r) => r.content)
          )
        }

        const now = Date.now()
        const periodStart = coveredBefore > 0 ? coveredBefore : sessions[0].ts
        const periodEnd = sessions[sessions.length - 1].ts
        stmtInsertDigest.run({
          project_id: projectId,
          period_start: periodStart,
          period_end: periodEnd,
          summary: result.summary,
          todos: JSON.stringify(result.todos),
          decisions: JSON.stringify(result.decisions),
          model,
          sessions_covered: sessions.length,
          created_at: now,
          updated_at: now
        })
        // 候选记忆:同源同内容去重后进入现有「候选 → 用户确认」链路
        const source = `project-digest:${projectId}`
        for (const c of result.candidates) {
          const content = c.content.trim()
          if (!content || stmtCandidateDup.get(source, content)) continue
          const kind = ['fact', 'preference', 'decision'].includes(c.kind) ? c.kind : 'fact'
          stmtInsertCandidate.run(kind, content.slice(0, 1000), source, now, projectId)
        }
        setState(projectId, {
          status: 'idle',
          last_digest_at: now,
          last_covered_ts: periodEnd,
          last_error: llmError
        })
        writeVaultMd(project.name, result, {
          projectName: project.name,
          periodStart,
          periodEnd,
          model,
          sessionsCovered: sessions.length,
          generatedAt: new Date(now)
        })
        notify(projectId)
        ctx.log.info(`digest ok: ${project.name} +${sessions.length} sessions (${model})${llmError ? ` — ${llmError}` : ''}`)
        return { ok: true, message: `已总结 ${sessions.length} 个会话(${model})` }
      } catch (err) {
        setState(projectId, { status: 'idle', last_error: String(err instanceof Error ? err.message : err) })
        notify(projectId)
        ctx.log.error('digest failed:', err)
        return { ok: false, message: `总结失败: ${String(err instanceof Error ? err.message : err)}` }
      } finally {
        running.delete(projectId)
      }
    }

    // 串行队列:一次只总结一个项目,防并发把 LLM 配额和库写打满
    let chain: Promise<unknown> = Promise.resolve()
    const enqueue = (projectId: number): void => {
      chain = chain.then(() => runDigest(projectId)).catch(() => {})
    }

    // ---- 自动触发:安静期防抖(监听常挂,开火时才检查开关 —— 开关即时生效) --
    const quietTimers = new Map<number, NodeJS.Timeout>()
    ctx.events.on('ingest:result', (...args: unknown[]) => {
      if (!enabled()) return
      const sessionIds = (args[0] as number[] | undefined) ?? []
      if (sessionIds.length === 0) return
      const ph = sessionIds.map(() => '?').join(',')
      const ids = (
        sqlite
          .prepare(
            `SELECT DISTINCT project_id FROM sessions WHERE id IN (${ph}) AND project_id IS NOT NULL`
          )
          .all(...sessionIds) as Array<{ project_id: number }>
      ).map((r) => r.project_id)
      for (const pid of ids) {
        const prev = quietTimers.get(pid)
        if (prev) clearTimeout(prev)
        const t = setTimeout(() => {
          quietTimers.delete(pid)
          if (enabled()) enqueue(pid)
        }, quietMinutes() * 60_000)
        t.unref?.()
        quietTimers.set(pid, t)
      }
    })

    // 启动补跑:应用常关着会错过安静期;3 分钟后把「有未覆盖会话且 >24h 没总结」的补上
    const catchup = setTimeout(() => {
      if (!enabled()) return
      const now = Date.now()
      for (const { id } of stmtProjectsWithSessions.all() as Array<{ id: number }>) {
        const state = stmtState.get(id) as { last_digest_at: number | null; last_covered_ts: number | null } | undefined
        const uncovered = (
          sqlite
            .prepare(
              `SELECT COUNT(*) AS n FROM sessions WHERE deleted = 0 AND project_id = ?
                 AND COALESCE(last_message_at, started_at) IS NOT NULL
                 AND COALESCE(last_message_at, started_at) > ?`
            )
            .get(id, state?.last_covered_ts ?? 0) as { n: number }
        ).n
        if (shouldRunCatchup(state, uncovered, now)) enqueue(id)
      }
    }, 3 * 60_000)
    catchup.unref?.()

    // ---- IPC ----------------------------------------------------------------
    ctx.ipc.handle('status', () => {
      const rows = sqlite
        .prepare(
          `SELECT p.id AS projectId, p.name,
                  st.status, st.last_digest_at AS lastDigestAt, st.last_error AS lastError,
                  EXISTS(SELECT 1 FROM project_digests d WHERE d.project_id = p.id AND d.deleted = 0) AS hasDigest,
                  (SELECT COUNT(*) FROM sessions s
                     WHERE s.deleted = 0 AND s.project_id = p.id
                       AND COALESCE(s.last_message_at, s.started_at) IS NOT NULL
                       AND COALESCE(s.last_message_at, s.started_at) > COALESCE(st.last_covered_ts, 0)) AS uncovered
             FROM projects p
             LEFT JOIN project_digest_state st ON st.project_id = p.id
             WHERE p.deleted = 0 AND EXISTS (SELECT 1 FROM sessions s WHERE s.deleted = 0 AND s.project_id = p.id)`
        )
        .all() as Array<Record<string, unknown>>
      return {
        enabled: enabled(),
        quietMinutes: quietMinutes(),
        projects: rows.map((r) => ({ ...r, status: running.has(Number(r.projectId)) ? 'running' : r.status ?? 'idle' }))
      }
    })

    ctx.ipc.handle('latest', (payload) => {
      const projectId = Number(((payload ?? {}) as { projectId?: number }).projectId)
      const project = stmtProject.get(projectId) as { id: number; name: string } | undefined
      if (!project) return null
      const d = stmtLatestDigest.get(projectId) as
        | {
            summary: string
            todos: string
            decisions: string
            model: string
            period_start: number | null
            period_end: number | null
            sessions_covered: number
            created_at: number
          }
        | undefined
      if (!d) return null
      return {
        projectId,
        projectName: project.name,
        summary: d.summary,
        todos: JSON.parse(d.todos || '[]') as DigestTodo[],
        decisions: JSON.parse(d.decisions || '[]') as string[],
        model: d.model,
        periodStart: d.period_start,
        periodEnd: d.period_end,
        sessionsCovered: d.sessions_covered,
        createdAt: d.created_at
      }
    })

    ctx.ipc.handle('runNow', (payload) => {
      const projectId = Number(((payload ?? {}) as { projectId?: number }).projectId)
      if (!Number.isFinite(projectId) || projectId <= 0) throw new Error('runNow requires {projectId}')
      const busy = running.has(projectId)
      if (!busy) enqueue(projectId)
      return { ok: true, queued: !busy }
    })

    // CLI(--digest)与批量场景:显式用户意图,绕过总开关
    ctx.ipc.handle('runAll', async () => {
      const results: Record<string, { ok: boolean; message: string }> = {}
      for (const { id } of stmtProjectsWithSessions.all() as Array<{ id: number }>) {
        results[String(id)] = await runDigest(id, { manual: true })
      }
      return results
    })

    // ---- MCP:agent 读这一份代替翻大量会话 ----------------------------------
    ctx.mcp.registerTool({
      name: 'memory_get_project_digest',
      description:
        '获取项目滚动总结:定期把项目新会话总结成 摘要+待办+决策(带覆盖时间范围)。接手项目先读它,成本远低于逐个翻历史会话;需要细节再配合 memory_list_sessions / memory_get_session。',
      inputSchema: {
        type: 'object',
        properties: {
          project: { type: 'string', description: '项目名或路径关键词,缺省取最近活跃项目' }
        }
      },
      handler: (args) => {
        if (!enabled()) {
          return '项目总结功能未开启。请用户在 MemorySQL 设置 → 智能引擎 → 项目总结 中开启后重试;当前可先调用 memory_get_project_brief 获取规则汇编的交接简报。'
        }
        const keyword = typeof args.project === 'string' ? args.project.trim() : ''
        const project = keyword
          ? (stmtProjectByKeyword.get(`%${keyword}%`, `%${keyword}%`) as { id: number; name: string } | undefined)
          : (stmtActiveProject.get() as { id: number; name: string } | undefined)
        if (!project) return keyword ? `(未找到匹配「${keyword}」的项目)` : '(库中还没有带会话的项目)'
        const d = stmtLatestDigest.get(project.id) as
          | {
              summary: string
              todos: string
              decisions: string
              model: string
              period_start: number | null
              period_end: number | null
              sessions_covered: number
            }
          | undefined
        if (!d) {
          return `项目「${project.name}」还没有总结 —— 等待自动总结,或让用户在该项目上点「立即总结」。可先调用 memory_get_project_brief。`
        }
        return buildDigestMcpText(
          {
            summary: d.summary,
            todos: JSON.parse(d.todos || '[]') as DigestTodo[],
            decisions: JSON.parse(d.decisions || '[]') as string[],
            candidates: []
          },
          {
            projectName: project.name,
            periodStart: d.period_start,
            periodEnd: d.period_end,
            model: d.model,
            sessionsCovered: d.sessions_covered,
            generatedAt: new Date()
          }
        )
      }
    })
  }
}

export default plugin
