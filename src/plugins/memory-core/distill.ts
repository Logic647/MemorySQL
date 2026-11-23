import type { RawMessage } from '../../shared/types'
import { isHarnessNoiseUserMessage } from '../../shared/harness-noise'

/**
 * 规则记忆提炼:从单个会话消息里提取候选记忆(免费、离线、确定性)。
 * 产物一律 status='candidate',由用户在记忆页确认;配置 LLM 后可批量精炼。
 */
export interface DistilledCandidate {
  kind: 'preference' | 'decision' | 'persona'
  content: string
}

const DECISION_RE = /(决定|就用|选定|改用|换用|统一用|以后用|敲定|decided|switch(?:ed)? to|we'?ll (?:use|go with))/i
const PREFERENCE_RE = /(记住|以后都|以后要|以后别|别忘了|不要再|别再|下次(直接|记得)|prefer|always|remember( that)?|don'?t|stop doing)/i
const STYLE_RE = /(极简|简洁|直接给|别啰嗦|少废话|别反问|持续推进|verbose|be brief|no need to explain)/i
/**
 * 问句不是偏好/决策。真实误报(2026-11-23,memories #25,distill:zcode:64):
 * 「…新增一个极简插件(如 core-launcher)需要哪些文件…」里的「极简」是插件定语,
 * 被 STYLE_RE 当成风格偏好写进全局记忆,再出现在每一份项目简报里。
 */
const QUESTION_RE = /(哪些|哪个|什么|怎么|如何|为什么|是否|吗|呢|[?？])/

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max)}…` : t
}

export function distill(
  agentType: string,
  sessionId: number,
  messages: RawMessage[]
): DistilledCandidate[] {
  // harness 注入的系统文本(# Environment / 运行时提醒 / task-notification)在库里
  // 也是 user 角色:不滤掉的话,①英文噪声会误中 don't/remember 那组信号词;
  // ②users 总数被撑大,「短句占比」画像统计失真
  const users = messages.filter((m) => m.role === 'user' && !isHarnessNoiseUserMessage(m.content))
  const candidates: DistilledCandidate[] = []
  const seen = new Set<string>()
  const push = (c: DistilledCandidate): void => {
    if (seen.has(c.content)) return
    seen.add(c.content)
    candidates.push(c)
  }

  // 1. 偏好 / 决策句提取(用户消息按句切分,命中信号词的句子入选)
  for (const m of users) {
    for (const sentence of m.content.split(/(?<=[。！？!?.\n])/)) {
      const s = sentence.trim()
      if (s.length < 4 || s.length > 200) continue
      if (QUESTION_RE.test(s)) continue // 问句不是偏好/决策(见 QUESTION_RE 注释)
      if (DECISION_RE.test(s)) push({ kind: 'decision', content: clip(s, 180) })
      else if (PREFERENCE_RE.test(s)) push({ kind: 'preference', content: clip(s, 180) })
      else if (STYLE_RE.test(s)) push({ kind: 'preference', content: clip(s, 180) })
    }
  }

  // 2. 交互风格画像:用户消息以超短句为主时,生成协作风格 persona
  const short = users.filter((m) => m.content.replace(/\s/g, '').length <= 12)
  if (users.length >= 5 && short.length / users.length >= 0.6) {
    push({
      kind: 'persona',
      content: `与 ${agentType} 协作时偏好极简指令(短句推进),期望自主持续推进、少反问`
    })
  }

  // 每会话最多 3 条,附来源便于追溯
  return candidates.slice(0, 3).map((c) => ({
    ...c,
    content: `${c.content}(来源: 会话 #${sessionId})`
  }))
}
