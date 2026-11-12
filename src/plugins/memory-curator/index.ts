import type { MemorySQLPlugin } from '../../main/core/plugin-host'
import { redactWithCount } from '../../main/core/redact'
import {
  applyCuration,
  buildGlobalCurationPrompt,
  buildProjectCurationPrompt,
  globalSystemPrompt,
  parseGlobalOps,
  parseProjectOps,
  projectSystemPrompt,
  type CuratorMemoryRow,
  type ProjectInput
} from './curate'
import { CURATOR_MIGRATIONS } from './migrations'

interface RefineService {
  available(): boolean
  refine(prompt: string, opts?: { system?: string; maxTokens?: number }): Promise<string>
  describe?(): string
}

interface CurationState {
  last_digest_id: number | null
  last_run_at: number | null
  last_error: string | null
  status: string
}

const GLOBAL_STATE_ID = 0

const plugin: MemorySQLPlugin = {
  manifest: {
    id: 'memory-curator',
    name: 'Memory Curator (digest → project/global memories)',
    version: '0.1.0',
    // project-digest must init first: it emits `digest:completed`, the curator's
    // primary trigger. core-schema provides the memories tables.
    requires: ['core-schema', 'project-digest']
  },

  init(ctx) {
    ctx.db.migrate(CURATOR_MIGRATIONS)
    const sqlite = ctx.db.sqlite
    // 上次进程被杀时可能留下 running 状态;状态表只是展示用,启动时归位
    sqlite.prepare("UPDATE memory_curation_state SET status = 'idle' WHERE status = 'running'").run()

    // ctx.settings 会自动加 `memory-curator:` 前缀 —— 这里只能写裸键,
    // 写成 memory-curator:enabled 会变成双前缀、设置页永远读不到。
    const enabled = (): boolean => ctx.settings.get<boolean>('enabled', true)
    const maxProject = (): number =>
      Math.min(200, Math.max(10, Number(ctx.settings.get('maxProject', 80)) || 80))
    const maxGlobal = (): number =>
      Math.min(100, Math.max(10, Number(ctx.settings.get('maxGlobal', 40)) || 40))
    const globalEveryHours = (): number =>
      Math.min(720, Math.max(1, Number(ctx.settings.get('globalEveryHours', 24)) || 24))
    // 跨插件读不到对方命名空间下的设置,只能问 project-digest 自己的 status。
    // 事件触发时已经隐含「总结刚跑完」,这里只用于启动补跑与 UI 展示。
    const isDigestEnabled = async (): Promise<boolean> => {
      try {
        const s = (await ctx.ipc.call('project-digest:status')) as { enabled?: boolean }
        return s.enabled === true
      } catch {
        return false
      }
    }

    const tryUseRefine = (): RefineService | null => {
      try {
        return ctx.services.use<RefineService>('llm-refine')
      } catch {
        return null
      }
    }

    const stmtProject = sqlite.prepare(
      `SELECT id, name, path, tech_stack AS techStack FROM projects WHERE id = ? AND deleted = 0`
    )
    const stmtLatestDigest = sqlite.prepare(
      `SELECT id, summary, recent, todos, decisions, created_at
         FROM project_digests
        WHERE project_id = ? AND deleted = 0
        ORDER BY created_at DESC LIMIT 1`
    )
    const loadLatestDigest = (projectId: number): unknown => {
      try {
        return stmtLatestDigest.get(projectId)
      } catch {
        // 老库/禁用中的 project-digest 可能是 v2(无 recent 列):退到不带 recent 的读法
        try {
          const row = sqlite
            .prepare(
              `SELECT id, summary, todos, decisions, created_at
                 FROM project_digests WHERE project_id = ? AND deleted = 0
                 ORDER BY created_at DESC LIMIT 1`
            )
            .get(projectId) as Record<string, unknown> | undefined
          return row ? { ...row, recent: '' } : undefined
        } catch {
          return undefined
        }
      }
    }
    const stmtState = sqlite.prepare(`SELECT * FROM memory_curation_state WHERE project_id = ?`)
    const stmtUpsertState = sqlite.prepare(
      `INSERT INTO memory_curation_state (project_id, last_digest_id, last_run_at, last_error, status, updated_at)
       VALUES (@project_id, @last_digest_id, @last_run_at, @last_error, @status, @updated_at)
       ON CONFLICT(project_id) DO UPDATE SET
         last_digest_id = excluded.last_digest_id,
         last_run_at = excluded.last_run_at,
         last_error = excluded.last_error,
         status = excluded.status,
         updated_at = excluded.updated_at`
    )
    const stmtProjectMemories = sqlite.prepare(
      `SELECT id, kind, content, locked, confidence, updated_at, access_count, last_access_at
         FROM memories
        WHERE deleted = 0 AND status = 'active' AND scope = 'project' AND project_id = ?
        ORDER BY kind, updated_at DESC LIMIT 120`
    )
    const stmtGlobalMemories = sqlite.prepare(
      `SELECT id, kind, content, locked, confidence, updated_at, access_count, last_access_at
         FROM memories
        WHERE deleted = 0 AND status = 'active' AND scope = 'global'
        ORDER BY kind, updated_at DESC LIMIT 80`
    )
    const stmtAllProjectMemories = sqlite.prepare(
      `SELECT m.id, m.kind, m.content, m.locked, m.confidence, m.updated_at,
              m.access_count, m.last_access_at, p.name AS projectName
         FROM memories m
         JOIN projects p ON p.id = m.project_id
        WHERE m.deleted = 0 AND m.status = 'active' AND m.scope = 'project'
        ORDER BY m.updated_at DESC LIMIT 200`
    )
    const stmtProjectsWithDigest = sqlite.prepare(
      `SELECT p.id, p.name,
              (SELECT d.id FROM project_digests d
                WHERE d.project_id = p.id AND d.deleted = 0
                ORDER BY d.created_at DESC LIMIT 1) AS digestId
         FROM projects p
        WHERE p.deleted = 0
          AND EXISTS (SELECT 1 FROM project_digests d WHERE d.project_id = p.id AND d.deleted = 0)
        ORDER BY p.name`
    )
    const stmtProjectMemoryCount = sqlite.prepare(
      `SELECT COUNT(*) AS n FROM memories
        WHERE deleted = 0 AND status = 'active' AND scope = 'project' AND project_id = ?`
    )
    const stmtGlobalMemoryCount = sqlite.prepare(
      `SELECT COUNT(*) AS n FROM memories WHERE deleted = 0 AND status = 'active' AND scope = 'global'`
    )
    // 自动整理成功后,同项目旧的 digest 候选即被取代;留着它们只会在记忆页
    // 制造重复条目(候选不参与注入)。失败时不 retire,保留原候选链路。
    // distill 候选同理:规则提炼是「每会话 ≤3 条」的粗提取,LLM 整理接管后
    // 它们只剩噪音(一次扫描能灌几十条);log_progress 候选不在此列——
    // 它们还要喂给项目总结的「待确认进度」素材。
    const stmtRetireDigestCandidates = sqlite.prepare(
      `UPDATE memories SET status = 'retired', updated_at = ?
        WHERE deleted = 0 AND status = 'candidate'
          AND project_id = ? AND (source = ? OR source LIKE 'distill:%')`
    )
    const stmtRetireGlobalDistill = sqlite.prepare(
      `UPDATE memories SET status = 'retired', updated_at = ?
        WHERE deleted = 0 AND status = 'candidate' AND scope = 'global' AND source LIKE 'distill:%'`
    )

    /** 项目整理成功(含"无需变更")后,取代掉该项目的旧候选;有清理就刷新 UI */
    const retireAutoCandidates = (projectId: number): void => {
      const n = Number(
        stmtRetireDigestCandidates.run(Date.now(), projectId, `project-digest:${projectId}`).changes
      )
      if (n > 0) notify()
    }

    const hasDigestTable = (): boolean => {
      try {
        sqlite.prepare('SELECT 1 FROM project_digests LIMIT 1').get()
        return true
      } catch {
        return false
      }
    }

    const getState = (projectId: number): CurationState | undefined =>
      stmtState.get(projectId) as CurationState | undefined

    const setState = (
      projectId: number,
      patch: Partial<CurationState> & { status: string }
    ): void => {
      const prev = getState(projectId)
      stmtUpsertState.run({
        project_id: projectId,
        last_digest_id: patch.last_digest_id ?? prev?.last_digest_id ?? null,
        last_run_at: patch.last_run_at ?? prev?.last_run_at ?? null,
        last_error: patch.last_error !== undefined ? patch.last_error : (prev?.last_error ?? null),
        status: patch.status,
        updated_at: Date.now()
      })
    }

    const notify = (): void => {
      ctx.events.emit('sessions:changed')
    }

    // ---- 项目整理 ---------------------------------------------------------
    const running = new Set<number>()
    let chain: Promise<unknown> = Promise.resolve()
    const enqueue = (projectId: number, opts: { manual?: boolean; force?: boolean; digestManual?: boolean } = {}): void => {
      if (running.has(projectId)) return
      chain = chain
        .then(() => (projectId === GLOBAL_STATE_ID ? curateGlobal(opts) : curateProject(projectId, opts)))
        .catch((err) => ctx.log.warn('memory-curator queue error:', err))
    }

    const curateProject = async (
      projectId: number,
      opts: { manual?: boolean; force?: boolean; digestManual?: boolean } = {}
    ): Promise<{ ok: boolean; message: string }> => {
      if (!opts.manual && !enabled()) return { ok: false, message: '记忆自动整理未开启' }
      if (!opts.manual && !opts.digestManual && !(await isDigestEnabled())) return { ok: false, message: '项目总结未开启' }
      if (running.has(projectId)) return { ok: false, message: '该项目正在整理中' }
      const refine = tryUseRefine()
      if (!refine?.available()) return { ok: false, message: 'LLM 未配置或不可用' }
      const project = stmtProject.get(projectId) as ProjectInput | undefined
      if (!project) return { ok: false, message: '项目不存在' }
      const digest = loadLatestDigest(projectId) as
        | { id: number; summary: string; recent: string; todos: string; decisions: string; created_at: number }
        | undefined
      if (!digest) return { ok: false, message: '该项目还没有总结' }
      const prevState = getState(projectId)
      if (!opts.force && prevState?.last_digest_id === digest.id) {
        return { ok: true, message: '这份总结已整理过' }
      }

      running.add(projectId)
      setState(projectId, { status: 'running' })
      try {
        const projectMemories = stmtProjectMemories.all(projectId) as CuratorMemoryRow[]
        const globalMemories = stmtGlobalMemories.all() as CuratorMemoryRow[]
        const prompt = buildProjectCurationPrompt({
          project,
          digest: {
            id: digest.id,
            summary: digest.summary,
            recent: digest.recent ?? '',
            todos: safeArray<{ content: string; status?: string }>(digest.todos),
            decisions: safeArray<string>(digest.decisions),
            createdAt: digest.created_at
          },
          projectMemories,
          globalMemories
        })
        const text = await refine.refine(redactWithCount(prompt).text, {
          system: projectSystemPrompt(),
          maxTokens: 3000
        })
        const allowed = new Set(projectMemories.map((r) => r.id))
        const ops = parseProjectOps(text, allowed)
        if (ops.length === 0 && !/"project"\s*:/.test(text)) {
          throw new Error('LLM 输出无法解析为项目记忆 JSON')
        }
        if (ops.length === 0) {
          setState(projectId, {
            status: 'idle',
            last_digest_id: digest.id,
            last_run_at: Date.now(),
            last_error: null
          })
          retireAutoCandidates(projectId)
          maybeGlobal()
          return { ok: true, message: '没有需要变更的记忆' }
        }
        const res = applyCuration(sqlite, {
          scope: 'project',
          projectId,
          ops,
          cap: maxProject()
        })
        setState(projectId, {
          status: 'idle',
          last_digest_id: digest.id,
          last_run_at: Date.now(),
          last_error: null
        })
        // 自动整理接管后,旧的「项目总结候选」和规则提炼候选不再需要用户逐条确认
        retireAutoCandidates(projectId)
        if (res.added + res.updated + res.retired > 0) {
          notify()
        }
        ctx.log.info(
          `memory curated: ${project.name} +${res.added} ~${res.updated} -${res.retired} (skip ${res.skipped})`
        )
        maybeGlobal()
        return {
          ok: true,
          message: `记忆已整理:新增 ${res.added}、更新 ${res.updated}、停用 ${res.retired}`
        }
      } catch (err) {
        const message = String(err instanceof Error ? err.message : err)
        setState(projectId, { status: 'idle', last_error: message })
        ctx.log.warn(`memory curation failed for project ${projectId}:`, err)
        return { ok: false, message: `整理失败: ${message}` }
      } finally {
        running.delete(projectId)
      }
    }

    // ---- 全局整理 ---------------------------------------------------------
    const curateGlobal = async (opts: { manual?: boolean; force?: boolean } = {}): Promise<{ ok: boolean; message: string }> => {
      if (!opts.manual && !enabled()) return { ok: false, message: '记忆自动整理未开启' }
      if (running.has(GLOBAL_STATE_ID)) return { ok: false, message: '全局整理进行中' }
      const refine = tryUseRefine()
      if (!refine?.available()) return { ok: false, message: 'LLM 未配置或不可用' }
      const prev = getState(GLOBAL_STATE_ID)
      const everyMs = globalEveryHours() * 3_600_000
      if (!opts.manual && !opts.force && prev?.last_run_at && Date.now() - prev.last_run_at < everyMs) {
        return { ok: true, message: '全局记忆尚未到刷新时间' }
      }
      const projectMemories = stmtAllProjectMemories.all() as Array<CuratorMemoryRow & { projectName: string }>
      if (projectMemories.length === 0) return { ok: true, message: '还没有项目记忆可汇总' }
      const globalMemories = stmtGlobalMemories.all() as CuratorMemoryRow[]
      running.add(GLOBAL_STATE_ID)
      setState(GLOBAL_STATE_ID, { status: 'running' })
      try {
        const prompt = buildGlobalCurationPrompt({ projectMemories, globalMemories })
        const text = await refine.refine(redactWithCount(prompt).text, {
          system: globalSystemPrompt(),
          maxTokens: 2400
        })
        const allowed = new Set(globalMemories.map((r) => r.id))
        const ops = parseGlobalOps(text, allowed)
        if (ops.length === 0 && !/"global"\s*:/.test(text)) {
          throw new Error('LLM 输出无法解析为全局记忆 JSON')
        }
        if (ops.length === 0) {
          setState(GLOBAL_STATE_ID, { status: 'idle', last_run_at: Date.now(), last_error: null })
          if (Number(stmtRetireGlobalDistill.run(Date.now()).changes) > 0) notify()
          return { ok: true, message: '没有需要变更的全局记忆' }
        }
        const res = applyCuration(sqlite, {
          scope: 'global',
          projectId: null,
          ops,
          cap: maxGlobal()
        })
        setState(GLOBAL_STATE_ID, { status: 'idle', last_run_at: Date.now(), last_error: null })
        // 全局整理成功后,无主项目会话产生的规则提炼候选同样被接管
        const globalRetired = Number(stmtRetireGlobalDistill.run(Date.now()).changes)
        if (res.added + res.updated + res.retired + globalRetired > 0) notify()
        ctx.log.info(
          `global memory curated: +${res.added} ~${res.updated} -${res.retired} (skip ${res.skipped})`
        )
        return {
          ok: true,
          message: `全局记忆已整理:新增 ${res.added}、更新 ${res.updated}、停用 ${res.retired}`
        }
      } catch (err) {
        const message = String(err instanceof Error ? err.message : err)
        setState(GLOBAL_STATE_ID, { status: 'idle', last_error: message })
        ctx.log.warn('global memory curation failed:', err)
        return { ok: false, message: `全局整理失败: ${message}` }
      } finally {
        running.delete(GLOBAL_STATE_ID)
      }
    }

    const maybeGlobal = (): void => {
      if (!enabled()) return
      const prev = getState(GLOBAL_STATE_ID)
      const everyMs = globalEveryHours() * 3_600_000
      if (!prev?.last_run_at || Date.now() - prev.last_run_at >= everyMs) enqueue(GLOBAL_STATE_ID)
    }

    // ---- 触发 -------------------------------------------------------------
    ctx.events.on('digest:completed', (...args: unknown[]) => {
      const payload = (args[0] ?? {}) as { projectId?: number; digestId?: number; manual?: boolean }
      if (!payload.projectId || !enabled()) return
      enqueue(payload.projectId, { digestManual: payload.manual === true })
    })

    // 启动补跑:上次整理之后又产生了新总结的项目(最多等 5 分钟,不抢首屏)
    const startupTimer = setTimeout(async () => {
      if (!enabled() || !hasDigestTable() || !(await isDigestEnabled())) return
      for (const row of stmtProjectsWithDigest.all() as Array<{ id: number; digestId: number | null }>) {
        if (!row.digestId) continue
        const st = getState(row.id)
        if (st?.last_digest_id !== row.digestId) enqueue(row.id)
      }
      maybeGlobal()
    }, 5 * 60_000)
    startupTimer.unref?.()

    // ---- IPC / UI ---------------------------------------------------------
    ctx.ipc.handle('status', async () => {
      if (!hasDigestTable()) {
        return {
          enabled: enabled(),
          llmReady: Boolean(tryUseRefine()?.available()),
          digestEnabled: await isDigestEnabled(),
          maxProject: maxProject(),
          maxGlobal: maxGlobal(),
          globalEveryHours: globalEveryHours(),
          projects: [],
          global: { lastRunAt: null, lastError: null, status: 'idle', memoryCount: 0 }
        }
      }
      const projects = (stmtProjectsWithDigest.all() as Array<{
        id: number
        name: string
        digestId: number | null
      }>).map((p) => {
        const st = getState(p.id)
        const count = (stmtProjectMemoryCount.get(p.id) as { n: number }).n
        return {
          projectId: p.id,
          name: p.name,
          digestId: p.digestId,
          lastRunAt: st?.last_run_at ?? null,
          lastError: st?.last_error ?? null,
          status: running.has(p.id) ? 'running' : (st?.status ?? 'idle'),
          memoryCount: count,
          curated: st?.last_digest_id != null && st?.last_digest_id === p.digestId
        }
      })
      const gs = getState(GLOBAL_STATE_ID)
      return {
        enabled: enabled(),
        llmReady: Boolean(tryUseRefine()?.available()),
        digestEnabled: await isDigestEnabled(),
        maxProject: maxProject(),
        maxGlobal: maxGlobal(),
        globalEveryHours: globalEveryHours(),
        projects,
        global: {
          lastRunAt: gs?.last_run_at ?? null,
          lastError: gs?.last_error ?? null,
          status: running.has(GLOBAL_STATE_ID) ? 'running' : (gs?.status ?? 'idle'),
          memoryCount: (stmtGlobalMemoryCount.get() as { n: number }).n
        }
      }
    })

    ctx.ipc.handle('runNow', (payload) => {
      const projectId = Number(((payload ?? {}) as { projectId?: number }).projectId)
      if (!Number.isFinite(projectId) || projectId <= 0) throw new Error('runNow requires {projectId}')
      const busy = running.has(projectId)
      if (!busy) enqueue(projectId, { manual: true, force: true })
      return { ok: true, queued: !busy }
    })

    ctx.ipc.handle('runAll', () => {
      let queued = 0
      for (const row of stmtProjectsWithDigest.all() as Array<{ id: number; digestId: number | null }>) {
        if (!row.digestId) continue
        const st = getState(row.id)
        if (st?.last_digest_id !== row.digestId && !running.has(row.id)) {
          enqueue(row.id, { manual: true })
          queued++
        }
      }
      return { ok: true, queued }
    })

    ctx.ipc.handle('runGlobal', () => {
      const busy = running.has(GLOBAL_STATE_ID)
      if (!busy) enqueue(GLOBAL_STATE_ID, { manual: true, force: true })
      return { ok: true, queued: !busy }
    })
  }
}

function safeArray<T>(json: string | null | undefined): T[] {
  if (!json) return []
  try {
    const v = JSON.parse(json) as unknown
    return Array.isArray(v) ? (v as T[]) : []
  } catch {
    return []
  }
}

export default plugin
