import type { MemorySQLPlugin, SummarizerProvider } from '../../main/core/plugin-host'
import type { RawMessage } from '../../shared/types'

const EXTENSION_RE =
  /\.(ts|tsx|js|jsx|mjs|cjs|json|jsonl|md|py|rs|go|java|kt|c|h|cpp|hpp|cs|sql|yaml|yml|toml|html|css|scss|sh|ps1|bat|vue|svelte|lock)$/i

/** Collect code/doc file basenames mentioned anywhere in the conversation. */
export function extractTouchedFiles(messages: RawMessage[], limit = 5): string[] {
  const seen = new Map<string, number>()
  const pathRe = /[\w.\- ]+\.[A-Za-z0-9]{1,8}/g
  for (const m of messages) {
    if (m.role !== 'user' && m.role !== 'assistant' && m.role !== 'tool') continue
    for (const match of m.content.matchAll(pathRe)) {
      const token = match[0].trim()
      if (!EXTENSION_RE.test(token)) continue
      const base = token.split(/[\\/]/).pop() ?? token
      seen.set(base, (seen.get(base) ?? 0) + 1)
    }
  }
  return [...seen.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([f]) => f)
}

/**
 * Strip agent-injected boilerplate that pollutes first user messages:
 *   <app-context>…</app-context>, <environment_context>…</environment_context>
 *   [Hermes UI Workspace] … [/Hermes UI Workspace]
 */
const BOILERPLATE_RES = [
  /<app-context>[\s\S]*?<\/app-context>/gi,
  /<environment_context>[\s\S]*?<\/environment_context>/gi,
  /\[[^\]\n]*Workspace\][\s\S]*?\[\/[^\]\n]*Workspace\]/gi,
  /<turn_context>[\s\S]*?<\/turn_context>/gi
]

export function stripBoilerplate(text: string): string {
  let out = text
  for (const re of BOILERPLATE_RES) out = out.replace(re, '')
  return out.trim()
}

/**
 * From the first few user messages, find the first line of real user intent:
 * skips markup/boilerplate lines (<tag…, [System…), Hermes session-restore
 * placeholders, and Codex history-assessment prompts.
 */
function pickMeaningfulUserText(users: RawMessage[]): { line: string; text: string } {
  for (const u of users.slice(0, 5)) {
    const text = stripBoilerplate(u.content)
    if (!text) continue
    for (const raw of text.split('\n')) {
      const line = raw.trim()
      if (line.length < 6) continue
      if (line.startsWith('<') || line.startsWith('[')) continue
      if (line.includes('可恢复内容')) continue // Hermes session-restore placeholder
      if (line.startsWith('The following is the Codex agent history')) continue
      return { line, text }
    }
  }
  return { line: '', text: '' }
}

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max)}…` : t
}

/**
 * Deterministic local provider — always available, zero cost.
 * The pipeline uses whatever provider registered first AND is available;
 * an LLM provider registered before this one would win when configured.
 */
const rulesProvider: SummarizerProvider = {
  id: 'rules',
  available: () => true,
  summarize({ messages }) {
    const users = messages.filter((m) => m.role === 'user')
    const assistants = messages.filter((m) => m.role === 'assistant')
    const meaningful = pickMeaningfulUserText(users)
    const files = extractTouchedFiles(messages)
    const toolCalls = messages.filter((m) => m.role === 'tool').length

    // sessions whose user side is all boilerplate: fall back to assistant text
    let title = clip(meaningful.line || '', 80)
    let goalText = meaningful.text
    if (!title) {
      for (const a of assistants.slice(0, 3)) {
        const text = stripBoilerplate(a.content)
        const line = text.split('\n').map((l) => l.trim()).find((l) => l.length >= 6 && !l.startsWith('<') && !l.startsWith('['))
        if (line) {
          title = clip(line, 80)
          goalText = goalText || text
          break
        }
      }
    }
    if (!title) title = '(no user message)'

    const lastAssistant = stripBoilerplate(assistants[assistants.length - 1]?.content ?? '')
    const parts = [
      `目标: ${clip(goalText || '(未捕获用户消息)', 200)}`,
      lastAssistant ? `结果: ${clip(lastAssistant, 200)}` : null,
      `规模: ${messages.length} 条消息 · ${toolCalls} 次工具调用 · ${files.length ? `涉及 ${files.join(', ')}` : '无明确文件'}`
    ].filter(Boolean)

    return { title, summary: parts.join('\n') }
  }
}

const plugin: MemorySQLPlugin = {
  manifest: {
    id: 'summarizer-rules',
    name: 'Rules Summarizer',
    version: '0.1.0'
  },
  init(ctx) {
    ctx.summarizer.registerProvider(rulesProvider)
    ctx.log.info('rules summarizer registered')
  }
}

export default plugin
