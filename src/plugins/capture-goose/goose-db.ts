import type { RawMessage, RawSession } from '../../shared/types'
import { openForeignDb } from '../../main/core/sqlite-ro.ts'

/**
 * Goose (Block → aaif-goose/goose,Rust)会话库。2026-11 源码核对
 * (crates/goose/src/session/session_manager.rs + crates/goose-provider-types):
 *
 *   <data_dir>/sessions/sessions.db
 *     data_dir = etcetera AppStrategy("Block","goose"):
 *       Windows  %APPDATA%\Block\goose
 *       macOS    ~/Library/Application Support/Block/goose
 *       Linux    ~/.local/share/goose
 *     (GOOSE_PATH_ROOT 覆盖时为 <root>/data —— 用户可在设置里指 sourceRoot)
 *
 * 表(schema_version 迁移链,≥10):
 *   sessions(id TEXT PK, name, description, user_set_name,
 *            session_type 'user'|'scheduled'|'subagent'|'hidden'|'terminal'|'gateway'|'acp',
 *            working_dir TEXT, created_at/updated_at TIMESTAMP(RFC3339 文本),
 *            provider_name, parent_session_id, archived_at, project_id, thread_id…)
 *   messages(message_id, session_id, role 'user'|'assistant',
 *            content_json TEXT, created_timestamp INTEGER(秒), metadata_json)
 *
 * content_json = Vec<MessageContentBlock>,serde tag "type" camelCase:
 *   {type:"text", text} / {type:"toolRequest", id, toolCall:{status:"success", value:{name, arguments}}}
 *   / {type:"toolResponse", id, toolResult:{status,value:{content:[…]}}} / {type:"thinking", thinking} …
 * 时间戳:Message.created = Utc::now().timestamp() → 秒(与本项目 started_at/ended_at 同口径)。
 * 子代理:session_type='subagent' + parent_session_id;归档:archived_at 非空。
 */

interface GooseSessionRow {
  id: string
  name: string | null
  description: string | null
  user_set_name?: number | boolean | null
  session_type?: string | null
  working_dir: string | null
  created_at: string | null
  updated_at: string | null
  parent_session_id?: string | null
  archived_at?: string | null
}

interface GooseMessageRow {
  role: string
  content_json: string
  created_timestamp: number
}

/** content 块的 union 切片 —— 只取我们认识的字段 */
interface GooseContentBlock {
  type?: string
  text?: string
  thinking?: string
  toolCall?: { status?: string; value?: { name?: string; arguments?: unknown } }
  toolResult?: { status?: string; value?: { content?: Array<{ type?: string; text?: string }> } }
}

/** RFC3339 字符串或 epoch 数字 → epoch 秒;解析失败返回 undefined */
function secondsOf(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) {
    // 秒(9-10 位)与毫秒(12-13 位)都能落对:毫秒除 1000
    return Math.floor(v > 1e11 ? v / 1000 : v)
  }
  if (typeof v !== 'string' || !v.trim()) return undefined
  const ms = Date.parse(v)
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : undefined
}

/** content_json → 0..n 条 raw 消息(text 合并,tool 调用/结果单独成条) */
function contentToRaw(json: string, role: 'user' | 'assistant', ts: number | undefined): RawMessage[] {
  let blocks: GooseContentBlock[]
  try {
    const parsed = JSON.parse(json) as unknown
    // content 是数组;万一上游写成单个对象/字符串也兜住
    blocks = Array.isArray(parsed) ? (parsed as GooseContentBlock[]) : [parsed as GooseContentBlock]
  } catch {
    return []
  }
  const out: RawMessage[] = []
  let text = ''
  const flush = (): void => {
    if (text.trim()) {
      out.push({ role, content: text, ts })
      text = ''
    }
  }
  for (const b of blocks) {
    if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
      text += (text ? '\n' : '') + b.text
    } else if (b.type === 'thinking' && typeof b.thinking === 'string' && b.thinking.trim()) {
      // 思考内容并入正文前的独立消息会打断时间线 —— 丢弃,与其他适配器口径一致
    } else if (b.type === 'toolRequest') {
      const call = b.toolCall?.value
      if (call?.name) {
        flush()
        out.push({
          role: 'tool',
          toolName: call.name,
          content: JSON.stringify(call.arguments ?? {}),
          ts
        })
      }
    } else if (b.type === 'toolResponse') {
      const parts = b.toolResult?.value?.content ?? []
      const reply = parts
        .map((p) => (p.type === 'text' && typeof p.text === 'string' ? p.text : ''))
        .filter(Boolean)
        .join('\n')
      if (reply.trim()) {
        flush()
        out.push({ role: 'tool', toolName: undefined, content: reply, ts })
      }
    }
  }
  flush()
  return out
}

/**
 * 解析 goose 的 sessions.db(整个库)。布局对不上时返回 [] —— goose 未装/
 * 库还没建都不算错。`since`(epoch ms)供启动增量:只读 updated_at 更新的会话。
 */
export function parseGooseSessions(dbPath: string, since?: number): RawSession[] {
  let db: ReturnType<typeof openForeignDb>['db']
  let cleanup: () => void
  try {
    ;({ db, cleanup } = openForeignDb(dbPath))
  } catch {
    return []
  }
  try {
    const tables = new Set(
      (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{ name: string }>).map(
        (r) => r.name
      )
    )
    if (!tables.has('sessions') || !tables.has('messages')) return []

    // 列探测:老 schema 可能没有 session_type/parent/archived —— 有才查,没有当顶层
    const cols = new Set(
      (db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>).map((r) => r.name)
    )
    const extra: string[] = []
    if (cols.has('session_type')) extra.push('session_type')
    if (cols.has('parent_session_id')) extra.push('parent_session_id')
    if (cols.has('archived_at')) extra.push('archived_at')
    if (cols.has('user_set_name')) extra.push('user_set_name')
    // 基础列也逐个探测:老迁移代可能没有 description
    const base = ['name', 'description', 'working_dir', 'created_at', 'updated_at']
      .filter((c) => cols.has(c))
    const select = ['id', ...base, ...extra].join(', ')

    // updated_at 是 TEXT(RFC3339),SQL 里的字符串比较会踩字典序坑 ——
    // 增量过滤分两段:先只取 (id, updated_at) 在 JS 里 Date.parse 出关,
    // 再对入选 id 拉整行。无增量/无 updated_at 列时一把梭。
    const sinceSec = since && since > 0 ? Math.floor(since / 1000) : null
    let sessions: GooseSessionRow[]
    if (sinceSec !== null && cols.has('updated_at')) {
      const stamps = db.prepare('SELECT id, updated_at FROM sessions').all() as Array<{
        id: string
        updated_at: string | null
      }>
      const keep = new Set(
        stamps.filter((r) => (secondsOf(r.updated_at) ?? 0) > sinceSec).map((r) => r.id)
      )
      sessions = []
      const full = db.prepare(`SELECT ${select} FROM sessions WHERE id = ?`)
      for (const id of keep) sessions.push(full.get(id) as GooseSessionRow)
    } else {
      sessions = db.prepare(`SELECT ${select} FROM sessions ORDER BY updated_at`).all() as GooseSessionRow[]
    }

    const msgStmt = db.prepare(
      'SELECT role, content_json, created_timestamp FROM messages WHERE session_id = ? ORDER BY created_timestamp, id'
    )

    const out: RawSession[] = []
    for (const s of sessions) {
      const startedAt = secondsOf(s.created_at) ?? secondsOf(s.updated_at)
      const endedAt = secondsOf(s.updated_at) ?? secondsOf(s.created_at)
      const messages: RawMessage[] = []
      for (const m of msgStmt.all(s.id) as GooseMessageRow[]) {
        if (m.role !== 'user' && m.role !== 'assistant') continue
        const ts = Number.isFinite(m.created_timestamp) ? Math.floor(m.created_timestamp) : undefined
        messages.push(...contentToRaw(m.content_json, m.role, ts))
      }
      if (messages.length === 0) continue
      // 标题:name 为空(goose 未命名)时不用 description 兜底 —— 空标题交给下游
      const title = typeof s.name === 'string' && s.name.trim() ? s.name : undefined
      const type = typeof s.session_type === 'string' ? s.session_type.trim() : ''
      const isSubagent = type === 'subagent'
      out.push({
        externalId: s.id,
        agentType: 'goose',
        cwd: s.working_dir ?? undefined,
        startedAt,
        endedAt,
        title,
        messages,
        rawPath: dbPath,
        ...(isSubagent
          ? {
              isSubagent: true,
              parentExternalId:
                typeof s.parent_session_id === 'string' && s.parent_session_id ? s.parent_session_id : undefined
            }
          : {}),
        ...(s.archived_at != null && s.archived_at !== '' ? { archived: true } : {})
      })
    }
    return out
  } finally {
    cleanup()
  }
}

/** 各平台 goose 数据根(供插件与台账共用;Windows 在前 —— 本机验证用) */
export function gooseDataRoots(home: string, appData?: string): string[] {
  const roots: string[] = []
  if (process.env.GOOSE_PATH_ROOT?.trim()) {
    roots.push(`${process.env.GOOSE_PATH_ROOT.replace(/[\\/]+$/, '')}/data/sessions`)
  }
  if (process.platform === 'win32') {
    roots.push(`${appData ?? `${home}/AppData/Roaming`}/Block/goose/sessions`)
  } else if (process.platform === 'darwin') {
    roots.push(`${home}/Library/Application Support/Block/goose/sessions`)
  } else {
    roots.push(`${home}/.local/share/goose/sessions`)
  }
  return roots
}
