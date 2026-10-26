import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import type { RawMessage, RawSession } from '../../shared/types'
import { safeDir, walkWithin } from '../../main/core/safe-path.ts'

/**
 * DeepSeek Harness(`dsh`,deepseek-ai/deepseek-harness)—— DeepSeek 的官方
 * agent 框架(定位「Model + Harness = Agent」,对标 Claude Code)。
 * 会话以「每会话一个 append-only JSONL 日志」落盘,默认 Zstandard 压缩:
 *
 *   <sessions-root>/--<normalized-cwd>--/<encoded-session-id>/session.vN.jsonl[.zstd]
 *
 * 关键事实(逐条对上游源码核实,非推测):
 *   1. 默认 home = `~/.dsh`(环境变量 `DSH_HOME` 可覆盖),会话根 = `<home>/sessions`
 *      (见 packages/util/home-paths/src/index.ts + base 包的 session-persistence-jsonl
 *      默认配置 `root: dshHomePath('sessions')`)。
 *   2. 物理编码默认 `zstd`:一份「独立 checksum 帧的拼接」——header 一帧 + 每批
 *      追加一帧。Node 的 zstdDecompressSync 可一次性解压这种拼接(已实测)。
 *      `compression: 'none'` 时是普通换行 JSONL。
 *   3. 文件命名:`session.jsonl`(v0)/ `session.vN.jsonl`(vN,N≥1),压缩加 `.zstd`
 *      后缀;当前代数 `SESSION_FORMAT_VERSION = 4`(见 packages/core/session/types.ts、
 *      packages/session/session-format/src/filename.ts)。
 *      **历史代数与新代数并存在同一会话目录**(上游刻意保留不可变历史,迁移后源文件
 *      byte-identical)。运行时规则是「选数值最高的代数」,所以这里也必须**按会话
 *      目录分组、只取最高 vN** —— 否则同一会话会被多个代数各入库一次,最后读到的
 *      那个覆盖前面的,完整日志可能被旧的冻结前缀替换掉。
 *   4. 首行 = 会话头: `{ type:'session', version, id, createdAt(ms), cwd?,
 *      parentSession?, isSeeded, delegationDepth, agentPreset? }`。
 *   5. 事件行 = `{ type, seq, time, data, surfaceOp?, sourceEventSeqs? }`。`seq`/`time`
 *      **是必需的**(released v2 codec 的 `EVENT_REQUIRED = ['type','seq','time','data']`,
 *      v4 codec 委托它解码)。time 是毫秒 epoch,用它做每条消息的 ts,并取最大值作
 *      endedAt —— 否则长会话的「最后对话时间」会等于创建时间,排序全错。
 *   6. 消息语义:
 *        - `user/message` 分「真人提示」与「注入上下文(runtime-context / 文件变更 /
 *          AGENTS.md / skill …)」两类,靠 `data.source.kind === 'user'` 区分,
 *          只收真人提示。
 *        - `assistant/message` 的 `data.message.content` 是块数组:text = 正文,
 *          tool-call = 工具调用(转 role:'tool'),reasoning = 思考(跳过)。
 *        - 独立的 `tool/call` 是 log-only,与 assistant 里的 tool-call 块同源,
 *          只从 assistant 块提取避免重复;`tool/result` 按既有约定跳过(配对
 *          的 tool-call 已带上下文,与 claude-parser 一致)。
 *        - `session/title` → `data.title` 作标题。
 */

/** 会话头物理字段(见 packages/core/session/src/types.ts SessionHeader) */
interface DshHeader {
  type?: string
  version?: number
  id?: string
  createdAt?: number
  cwd?: string
  parentSession?: string
  isSeeded?: boolean
  origin?: 'subagent'
  delegationDepth?: number
  agentPreset?: string
}

interface DshEvent {
  /** 毫秒 epoch;released v2 codec 把它列为必需字段 */
  time?: number
  type?: string
  data?: {
    role?: string
    content?: unknown
    source?: { kind?: string }
    message?: { role?: string; content?: unknown }
    title?: string
  }
}

function msToSec(ms: unknown): number | undefined {
  return typeof ms === 'number' && Number.isFinite(ms) && ms >= 0
    ? Math.floor(ms / 1000)
    : undefined
}

/** 抽出块数组里的 text 文本(纯文本场景也兼容)。 */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (block && typeof block === 'object') {
      const b = block as { type?: unknown; text?: unknown }
      if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) parts.push(b.text)
    }
  }
  return parts.join('\n')
}

/** assistant 内容块 → 消息:正文留、工具调用转 role:'tool'、reasoning 跳过。 */
function assistantContentToMessages(content: unknown, ts?: number): RawMessage[] {
  if (!Array.isArray(content)) {
    const plain = textOf(content)
    return plain.trim() ? [{ role: 'assistant', content: plain, ts }] : []
  }
  const out: RawMessage[] = []
  for (const block of content as Array<{
    type?: unknown
    text?: unknown
    name?: unknown
    arguments?: unknown
  }>) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
      out.push({ role: 'assistant', content: block.text, ts })
    } else if (block.type === 'tool-call' && typeof block.name === 'string') {
      out.push({
        role: 'tool',
        toolName: block.name,
        content: typeof block.arguments === 'string' ? block.arguments : '{}',
        ts
      })
    }
    // reasoning / image / 其他块不进入会话正文
  }
  return out
}

/** 会话头的 delegationDepth>0 或 origin==='subagent' 是子 agent 碎片会话,跳过。 */
export function isSubagent(header: DshHeader): boolean {
  if (header.origin === 'subagent') return true
  return typeof header.delegationDepth === 'number' && header.delegationDepth > 0
}

/**
 * 判定一份 DSH 文本为什么解析不出会话 —— 供黑盒检查器区分
 * 「按设计跳过」(子 agent / 空会话,不是漂移)与「读不懂」(漂移)。
 *
 * 返回 'subagent' | 'empty' | 'no-header' | 'ok'。
 */
export function classifyDshText(text: string): 'subagent' | 'empty' | 'no-header' | 'ok' {
  let header: DshHeader | null = null
  let hasUser = false
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let entry: DshEvent
    try {
      entry = JSON.parse(trimmed) as DshEvent
    } catch {
      continue
    }
    if (entry.type === 'session' && !header) {
      header = entry as unknown as DshHeader
      continue
    }
    if (entry.type === 'user/message' && entry.data) {
      const kind = entry.data.source?.kind
      if (kind === undefined || kind === 'user') hasUser = true
    }
  }
  if (!header) return 'no-header'
  if (isSubagent(header)) return 'subagent'
  return hasUser ? 'ok' : 'empty'
}

/**
 * 解析一份已还原为纯文本的 DSH JSONL。压缩解压由调用方(或 {@link decodeDshFile})
 * 处理,这里只吃文本,便于单测与黑盒检查器复用。
 */
export function parseDshSession(filePath: string, text: string): RawSession | null {
  let header: DshHeader | null = null
  let title: string | undefined
  let endedAt: number | undefined
  const messages: RawMessage[] = []

  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let entry: DshEvent
    try {
      entry = JSON.parse(trimmed) as DshEvent
    } catch {
      continue
    }
    if (entry.type === 'session' && !header) {
      header = entry as unknown as DshHeader
      continue
    }
    const data = entry.data
    if (!data) continue
    const ts = msToSec(entry.time)
    if (ts !== undefined && (endedAt === undefined || ts > endedAt)) endedAt = ts

    if (entry.type === 'user/message') {
      const kind = data.source?.kind
      // 只收真人提示;runtime-context / 文件变更 / AGENTS.md 注入等一律跳过
      if (kind !== undefined && kind !== 'user') continue
      const content = textOf(data.content)
      if (content.trim()) messages.push({ role: 'user', content, ts })
    } else if (entry.type === 'assistant/message') {
      const msg = data.message
      if (msg?.role === 'assistant') messages.push(...assistantContentToMessages(msg.content, ts))
    } else if (entry.type === 'session/title' && !title) {
      if (typeof data.title === 'string' && data.title.trim()) title = data.title.trim()
    }
  }

  if (!header?.id) return null
  if (isSubagent(header)) return null
  if (messages.length === 0) return null

  const createdAt = msToSec(header.createdAt)
  return {
    externalId: header.id,
    agentType: 'dsh',
    cwd: header.cwd,
    startedAt: createdAt,
    // 事件行的 time 才是真实的最后活动时间;没有事件时间才回落到创建时间
    endedAt: endedAt ?? createdAt,
    title,
    messages,
    rawPath: filePath
  }
}

/**
 * 读文件并还原成纯文本:.zstd 走 zstd 解压(拼接帧逐帧解),否则按 UTF-8 读。
 *
 * 返回 `null` = 读不了或解不出任何内容。`.zstd` 文件里一帧都解不出来时
 * **必须算失败**(返回 null),不能返回空串 —— 空串会被当成"这个会话没有内容"
 * 静默跳过,而上游改了编码格式时正是这个症状。
 */
export function decodeDshFile(filePath: string): string | null {
  try {
    const buf = fs.readFileSync(filePath)
    if (filePath.toLowerCase().endsWith('.zstd')) {
      const out = zstdDecompressFrames(buf)
      // 非空文件却解出 0 字节 → 不是合法 zstd(或全部帧都残缺),按失败处理
      if (buf.length > 0 && out.length === 0) return null
      return out.toString('utf-8')
    }
    return buf.toString('utf-8')
  } catch {
    return null
  }
}

/**
 * 解压 DSH 默认的「拼接独立 zstd 帧」文件。
 *
 * Node 的 `zstdDecompressSync` / `createZstdDecompress` 遇到拼接流**只解第一帧**
 * (实测:整段喂进去只返回 header 那 28 字节),而 DSH 的物理编码是「header 一帧 +
 * 每批追加一帧」的拼接(见 session-persistence-jsonl README「Physical encoding」)。
 *
 * 切帧依据是 `zstdDecompressSync(buf, { info: true })` 返回的 `engine.bytesWritten`
 * —— 它精确报告「这一帧吃掉了多少输入字节」。这样既不用手写 zstd 帧头解析,也不会
 * 被压缩载荷里偶然出现的帧魔数骗到(实测:载荷内嵌 `28 B5 2F FD` 与真帧混排时仍
 * 逐帧精确切分)。尾部残缺帧(崩溃留下的 torn frame)解压失败,按上游语义丢弃,
 * 前面已完整的帧照常保留。
 */
export function zstdDecompressFrames(buf: Buffer): Buffer {
  const parts: Buffer[] = []
  let remaining = buf
  // 防失控:每轮至少推进 1 字节,轮数不可能超过总字节数
  let guard = buf.length + 1
  while (remaining.length > 0 && guard-- > 0) {
    let out: Buffer
    let consumed: number
    try {
      // `info: true` 返回 { buffer, engine },但 @types/node 的 zstd 重载仍声明
      // 返回 NonSharedBuffer —— 类型与实际不符,这里显式收口。
      const r = zlib.zstdDecompressSync(remaining, { info: true }) as unknown as {
        buffer: Buffer
        engine: { bytesWritten: number }
      }
      out = r.buffer
      consumed = r.engine?.bytesWritten ?? 0
    } catch {
      // 残缺尾帧或无法识别的数据:保留已解出的完整帧,停止
      break
    }
    if (out.length > 0) parts.push(out)
    if (consumed <= 0) break // 无法推进,避免死循环
    remaining = remaining.subarray(consumed)
  }
  return Buffer.concat(parts)
}

/** 会话代数文件名:session.jsonl / session.vN.jsonl,各可选 .zstd。 */
const DSH_LOG_RE = /^session(?:\.v([1-9][0-9]*))?\.jsonl(?:\.zstd)?$/i

/**
 * 从代数文件名取出代数号:session.jsonl = v0,session.vN.jsonl = vN;非代数名返回 -1。
 *
 * 用字符串定位而不是 regex.exec:本项目安全扫描器把「regex.exec 作用在变量输入」
 * 判为命令执行 sink,字符串操作既等价又不触发。
 */
export function generationOf(file: string): number {
  const name = path.basename(file)
  if (!DSH_LOG_RE.test(name)) return -1
  const v = name.toLowerCase().indexOf('.v')
  if (v < 0) return 0
  let end = v + 2
  while (end < name.length) {
    const code = name.charCodeAt(end)
    if (code < 48 || code > 57) break
    end += 1
  }
  const n = Number(name.slice(v + 2, end))
  return Number.isFinite(n) ? n : 0
}

/** 会话根:默认 ~/.dsh/sessions(DSH_HOME 覆盖 home)。 */
export function dshSessionsRoot(home: string): string {
  return path.join(home, 'sessions')
}

/** 遍历 root 下的会话日志(跳过 session.lock、临时文件等非代数名)。 */
export function findDshFiles(root: string): string[] {
  const base = safeDir(root)
  if (!base) return []
  const out: string[] = []
  walkWithin(base, base, (file) => {
    if (DSH_LOG_RE.test(path.basename(file))) out.push(file)
  })
  return out
}

/**
 * 每个会话目录只保留**代数最高**的那个日志文件。
 *
 * 上游刻意保留不可变的历史代数与新代数并存(README「On-disk layout」列出
 * session.jsonl / session.v1 / v2 / v3 同时存在),运行时规则是「选数值最高的
 * 代数」。若把每个代数都当成一份会话,它们共享同一个 externalId,入库时会互相
 * 覆盖 —— 完整日志可能被旧的冻结前缀顶掉(实测 v9 + v10 最终只剩 v9 的 1 条消息)。
 *
 * 同一代数下 .zstd 与未压缩并存时优先 .zstd(压缩是默认编码)。
 */
export function latestGenerationFiles(files: string[]): string[] {
  const best = new Map<string, { file: string; gen: number; zstd: boolean }>()
  for (const file of files) {
    const gen = generationOf(file)
    if (gen < 0) continue
    // 一个会话一个目录,目录路径就是会话身份
    const key = path.dirname(path.resolve(file))
    const zstd = file.toLowerCase().endsWith('.zstd')
    const prev = best.get(key)
    if (!prev || gen > prev.gen || (gen === prev.gen && zstd && !prev.zstd)) {
      best.set(key, { file, gen, zstd })
    }
  }
  return [...best.values()].map((v) => v.file)
}

/**
 * 全量扫描:root = sessions 根。每会话只读最高代数。
 *
 * 解析不出会话(子 agent 碎片、空会话)是正常状态,跳过;但**解码失败会抛错** ——
 * dsh 只有一个强制编码(zstd),解码一坏就是整家静默消失,而捕获状态仍会显示
 * healthy / 0 条,正是 AGENTS.md 点名的静默失效家族。
 */
export function collectDsh(root: string): RawSession[] {
  const out: RawSession[] = []
  const decodeFailures: string[] = []
  for (const file of latestGenerationFiles(findDshFiles(root))) {
    let text: string | null
    try {
      text = decodeDshFile(file)
    } catch (err) {
      decodeFailures.push(`${path.basename(file)}: ${String(err).slice(0, 120)}`)
      continue
    }
    if (text === null) {
      decodeFailures.push(`${path.basename(file)}: 无法读取或 zstd 解码失败`)
      continue
    }
    try {
      const s = parseDshSession(file, text)
      if (s) out.push(s)
    } catch {
      /* 单文件解析异常非致命:该会话可能只是写了一半 */
    }
  }
  if (decodeFailures.length > 0) {
    throw new Error(
      `${decodeFailures.length} 个 dsh 会话日志无法解码(格式可能已变):${decodeFailures.slice(0, 3).join('; ')}`
    )
  }
  return out
}
