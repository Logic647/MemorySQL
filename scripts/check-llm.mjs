/**
 * LLM 增强自检 —— 真调一次 LLM,确认这条路径在生产配置下确实能跑。
 *
 * 为什么需要它:`llmEnhance` 的单元测试全部用 mock(不花钱、可离线),但
 * **mock 不能证明你的 key / 端点 / 模型名真的能用**。真调一次才算数。
 *
 * 用法(在服务器或本机):
 *   export LLM_API_KEY=sk-...
 *   export LLM_BASE_URL=https://api.anthropic.com/v1/messages   # 可选
 *   export LLM_MODEL=claude-sonnet-4-5                            # 可选
 *   node scripts/check-llm.mjs
 *
 * 退出码:0=通,1=不通(会打印原因与排查建议)
 */
import { evaluate, llmEnhance } from '../tools/upstream-watch/evaluate.mjs'
import { AGENTS } from '../src/shared/upstream-agents.ts'

const hasKey = !!process.env.LLM_API_KEY
console.log(`\n=== LLM 增强自检 ===\n`)
console.log(`LLM_API_KEY : ${hasKey ? '已设置' : '❌ 未设置(LLM 增强会被跳过,看板退化为纯规则)'}`)
console.log(`LLM_BASE_URL: ${process.env.LLM_BASE_URL ?? '(默认 Anthropic 官方)'}`)
console.log(`LLM_MODEL   : ${process.env.LLM_MODEL ?? '(默认 claude-sonnet-4-5)'}\n`)

if (!hasKey) {
  console.log('跳过(纯规则模式本身是完备的,不会因此出错)。\n')
  process.exit(0)
}

// 拿一条真实的、规则判为 medium 的样本(避免自造文本,贴近真实使用)
const target = AGENTS.find((a) => a.id === 'qwencode') ?? AGENTS[0]
const SAMPLE = [
  '## Breaking Changes',
  'No known breaking changes.',
  '',
  '### Features',
  '- feat(memory): extend structured scan and bounded retrieval',
  '- feat(serve): Introduce Plugins that use a host-supplied tool service',
  '- fix(core): Closed the compile-cache gaps in a failing schema',
  '',
  '### Bug Fixes',
  '- fix(cli): self-heal stale pending swap on /update',
  '- fix(serve): align Managed engine settings with the Broker schema'
].join('\n')

console.log(`样本 agent : ${target.name} (${target.id})`)
console.log(`样本文本   : ${SAMPLE.split('\n').length} 行(取自 qwen-code 真实 changelog 结构)\n`)

const ruleOnly = evaluate(target, { notes: SAMPLE, version: 'v-test' })
console.log(`规则判定   : ${ruleOnly.risk} (${ruleOnly.riskLabel})`)
console.log(`           : ${ruleOnly.reason}\n`)

const t0 = Date.now()
const withLlm = await llmEnhance(ruleOnly, target)
const ms = Date.now() - t0

if (withLlm.llmError) {
  console.log(`❌ LLM 调用失败:${withLlm.llmError}\n`)
  console.log('排查:')
  console.log('  1. key 是否正确、有没有多余引号/空格')
  console.log('  2. LLM_BASE_URL 是否指向你实际用的 provider(非 Anthropic 官方也能走 OpenAI 兼容格式)')
  console.log('  3. LLM_MODEL 是否存在(填错会 404/400)')
  console.log('  4. 服务器能否出网访问该端点\n')
  console.log('注:即使 LLM 挂了,看板也照常工作 —— 已自动降级为纯规则结果。\n')
  process.exit(1)
}

if (!withLlm.llm) {
  console.log(`⚠ 未启用(风险等级为 ${withLlm.risk},不在 medium/high,按设计跳过 LLM)\n`)
  process.exit(0)
}

console.log(`✅ LLM 调用成功(${ms}ms)`)
console.log(`   捕获影响 : ${withLlm.affectsCapture ?? withLlm.llm.affectsCapture}`)
console.log(`   MCP 影响 : ${withLlm.llm.affectsMcp}`)
console.log(`   严重度   : ${withLlm.llm.severity}`)
console.log(`   理由     : ${withLlm.llm.reason}`)
console.log(`   合并后   : ${withLlm.risk}(规则 ${ruleOnly.risk} → 合并 ${withLlm.risk},LLM 只能加严不可放松)\n`)
process.exit(0)
