/**
 * harness 注入噪声识别:user 角色消息里的「非用户输入」。
 * ============================================================================
 * 背景(2026-11-22):各家 agent harness 会把系统上下文/通知作为 **user 角色**
 * 写进会话存储(zcode 实测最严重:一场会话 45 条 user 消息里只有 ~2 条是真话):
 *   - 环境上下文:`# Environment…`、`You are powered by…`、skills/agent 清单
 *   - 运行时提醒:「The TodoWrite tool hasn't been used recently…」、
 *     「The user hasn't heard from you…」、`<total_tokens>…`
 *   - 后台事件:`<task-notification>…`、`<system-reminder>…`
 * 后果:①会话详情满屏顶着 user 标签的机器文本,真实用户输入被淹没;
 *       ②项目总结素材的「首条用户消息」取到系统注入,LLM 看不到用户真正要什么;
 *       ③规则记忆提炼从噪声英文里误提取偏好/决策候选。
 *
 * 原则:**只标注不删除**。原始数据一律保留(适配器只读、库内不清洗),
 * 消费侧(详情页/总结素材/提炼/标题兜底)按本函数过滤或降权展示。
 *
 * 误伤风险评估:模式全部锚定行首或完整标签,均为 harness 固定话术;
 * 用户真实输入(自然语言、/斜杠命令、@文件引用、分享导入)都不匹配。
 * 侧栏命令回显 `<local-command-stdout>` 视为系统输出(用户敲的命令本身
 * 形如 `/resume …`,不以该标签开头,不受影响)。
 */

/** 行首锚定:harness 固定话术(zcode/claude 系/opencode 系实测样本) */
const NOISE_PREFIX: RegExp[] = [
  /^# Environment\b/,
  /^You are powered by the model named\b/,
  /^The following (?:deferred tools|skills|MCP servers) /,
  /^Available agent types for the Agent tool:/,
  /^The TodoWrite tool hasn't been used recently/,
  /^The user hasn't heard from you in a while/,
  /^A plan file exists from plan mode/,
  /^Today's date is /,
  /^Caveat: /,
  /^This session is being continued from a previous conversation/,
  /^Codebase and user instructions are shown below/,
  /^As you answer the user's questions, you can use the following context/,
  /^Called the \S+ tool with the following input/,
  /^Result of calling the \S+ tool/,
  /^Note: \S+ was read before the last conversation/,
  /^\[SYSTEM NOTIFICATION/,
  /^<(?:task-notification|system-reminder|local-command-stdout|total_tokens|environment_context|user_instructions|env)[>\s]/
]

/** 嵌入式标签:即使前面还有别的文本也算(用户真实输入不会包含这些标签) */
const NOISE_INCLUDES: string[] = [
  '<system-reminder>',
  '<task-notification>',
  '<local-command-stdout>'
]

export function isHarnessNoiseUserMessage(content: string): boolean {
  const s = (content ?? '').trim()
  if (!s) return false
  if (NOISE_INCLUDES.some((p) => s.includes(p))) return true
  return NOISE_PREFIX.some((re) => re.test(s))
}

/**
 * 从按 seq 有序的 user 消息里挑「第一条真实用户输入」。
 * 前 lookback 条(默认 12)里全是噪声时返回 null —— 调用方按无素材处理,
 * 不要回落到噪声文本(总结素材里「用户: # Environment…」比缺失更误导)。
 */
export function firstRealUserMessage(
  messages: Array<{ role?: string; content: string }>,
  lookback = 12
): string | null {
  let seen = 0
  for (const m of messages) {
    if ((m.role ?? 'user') !== 'user') continue
    seen += 1
    if (seen > lookback) break
    if (!isHarnessNoiseUserMessage(m.content)) return m.content
  }
  return null
}
