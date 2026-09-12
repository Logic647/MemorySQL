import crypto from 'node:crypto'
import type { MemorySQLPlugin } from '../../main/core/plugin-host'
import type { RawMessage, RawSession } from '../../shared/types'
import type { IngestService } from '../core-schema/ingest'

/**
 * 对话导入 —— 加密/云端存储 agent 的通用"正门":用户把能看到的聊天记录
 * (粘贴文本、导出的 md/txt/json)交给这里,启发式还原成一条会话入库。
 * 同一段文本重复导入按内容哈希幂等;厂商改版不影响(不依赖任何私有格式)。
 */

const USER_TOKENS = new Set(['user', '用户', '我', 'human', '提问', 'q', 'question', '客户'])
const ASSISTANT_TOKENS = new Set([
  'assistant',
  '助手',
  'ai',
  'bot',
  '回答',
  'a',
  'answer',
  'claude',
  'gpt',
  'gemini',
  'qwen',
  'kimi',
  'deepseek',
  'copilot',
  '模型',
  '机器人'
])

function roleOf(token: string): 'user' | 'assistant' | null {
  const t = token.toLowerCase()
  if (USER_TOKENS.has(t)) return 'user'
  if (ASSISTANT_TOKENS.has(t)) return 'assistant'
  return null
}

/** recognize a role-marker line, returning the role and any same-line content
 * that follows the marker ("User: check the logs" → user + "check the logs") */
function splitRoleLine(line: string): { role: 'user' | 'assistant'; rest: string } | null {
  const t = line.trim()
  if (!t) return null
  // whole-line markers: "### 用户", "**User:**", "[assistant]"
  const header = /^#{1,6}\s*(.+?)\s*:?\s*$/.exec(t)
  if (header && !header[1].includes(':')) {
    const role = roleOf(header[1].replace(/\*+/g, '').trim())
    return role ? { role, rest: '' } : null
  }
  const bold = /^\*\*(.+?)\*\*\s*:?\s*$/.exec(t)
  if (bold) {
    const role = roleOf(bold[1].replace(/[:：]\s*$/, '').trim())
    return role ? { role, rest: '' } : null
  }
  const bracket = /^\[([^\]]{1,20})\]\s*:?\s*$/.exec(t)
  if (bracket) {
    const role = roleOf(bracket[1].trim())
    return role ? { role, rest: '' } : null
  }
  // "User: rest…" / "用户:rest" (possibly decorated: "**Assistant:** rest")
  const stripped = t.replace(/^[>*\-\s]+/, '')
  const colon = /^([^:：]{1,20})\s*[:：]\s*(.*)$/.exec(stripped)
  if (colon) {
    const role = roleOf(colon[1].replace(/\*+/g, '').trim())
    if (role) return { role, rest: colon[2].replace(/^[*\s]+/, '') }
  }
  return null
}

export function parseConversation(text: string): RawMessage[] {
  const trimmed = text.trim()
  if (!trimmed) return []

  // flat JSON: [{role, content}, …]
  try {
    const j = JSON.parse(trimmed) as unknown
    if (
      Array.isArray(j) &&
      j.length > 0 &&
      j.every((x) => x && typeof x === 'object' && 'role' in x && 'content' in x)
    ) {
      const out: RawMessage[] = []
      for (const item of j as Array<{ role: unknown; content: unknown }>) {
        const role = typeof item.role === 'string' ? item.role : ''
        const content = typeof item.content === 'string' ? item.content : ''
        if ((role === 'user' || role === 'assistant') && content.trim()) {
          out.push({ role, content })
        }
      }
      if (out.length > 0) return out
    }
  } catch {
    /* not JSON — text heuristics below */
  }

  const messages: RawMessage[] = []
  let current: { role: 'user' | 'assistant'; lines: string[] } | null = null
  for (const line of trimmed.split('\n')) {
    const marker = splitRoleLine(line)
    if (marker) {
      if (current && current.lines.join('').trim()) {
        messages.push({ role: current.role, content: current.lines.join('\n').trim() })
      }
      current = { role: marker.role, lines: marker.rest ? [marker.rest] : [] }
      continue
    }
    if (!current) current = { role: 'user', lines: [] } // content before any marker = user side
    current.lines.push(line)
  }
  if (current && current.lines.join('').trim()) {
    messages.push({ role: current.role, content: current.lines.join('\n').trim() })
  }
  return messages
}

const plugin: MemorySQLPlugin = {
  manifest: {
    id: 'import-chat',
    name: 'Import: 对话导入',
    version: '0.1.0',
    requires: ['core-schema']
  },

  init(ctx) {
    ctx.ipc.handle('import', async (payload) => {
      const { text, title, source } = (payload ?? {}) as {
        text?: unknown
        title?: unknown
        source?: unknown
      }
      if (typeof text !== 'string' || !text.trim()) throw new Error('没有可导入的内容')
      const messages = parseConversation(text)
      if (messages.length === 0) throw new Error('没有识别到任何对话内容')

      // content-hash externalId: same paste re-imported is a no-op (ingest skips)
      const externalId = `imported:${crypto.createHash('sha256').update(text.trim()).digest('hex').slice(0, 16)}`
      const nowSec = Math.floor(Date.now() / 1000)
      const session: RawSession = {
        externalId,
        agentType: 'imported',
        startedAt: nowSec,
        endedAt: nowSec,
        title: typeof title === 'string' && title.trim() ? title.trim() : undefined,
        messages,
        rawPath: typeof source === 'string' && source.trim() ? `paste:${source.trim()}` : 'paste'
      }
      const ingest = ctx.services.use<IngestService>('ingest')
      const res = await ingest.ingestSessions([session])
      ctx.log.info(`import ok: ${messages.length} messages, ${res.imported + res.updated} written`)
      return {
        sessionId: res.sessionIds[0] ?? null,
        messages: messages.length,
        imported: res.imported + res.updated,
        skipped: res.skipped
      }
    })
  }
}

export default plugin
