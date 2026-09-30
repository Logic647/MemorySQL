/**
 * LLM 增强自检 —— 真调一次 LLM,确认这条路径在生产配置下确实能跑。
 *
 * 为什么需要它:`llmEnhance` 的单元测试全部用 mock(不花钱、可离线),但
 * **mock 不能证明你的 key / 端点 / 模型名真的能用**。真调一次才算数。
 *
 * 用法:
 *   export LLM_API_KEY=sk-xxxx
 *   node scripts/check-llm.mjs mimo        # 套用预置(见 PRESETS)
 *   node scripts/check-llm.mjs openai
 *   node scripts/check-llm.mjs            # 用自定义环境变量
 *
 * 退出码:0=通,1=不通(打印原因与排查建议)
 */
import { evaluate, llmEnhance } from '../tools/upstream-watch/evaluate.mjs'
import { AGENTS } from '../src/shared/upstream-agents.ts'

/**
 * provider 预置 —— 信息取自各家官方文档,核对日期 2026-09-30。
 * key 一律从环境变量读,**不写进任何文件**。
 */
const PRESETS = {
  mimo: {
    label: '小米 MiMo',
    baseUrl: 'https://api.xiaomimimo.com/v1/chat/completions',
    model: 'mimo-v2.6-flash',
    notes: [
      '认证头是 api-key(本工具默认同时发 Authorization 与 api-key,已兼容)',
      '⚠ mimo-v2.5-pro / mimo-v2.5 将于 2026-10-21 下线,别用',
      '想换更强的判断力:LLM_MODEL=mimo-v2.6-pro(本用途调用量小,两者差别有限)',
      'Token Plan 用户改用 https://token-plan-cn.xiaomimimo.com/v1/chat/completions,key 前缀 tp-/ttp-'
    ]
  },
  openai: {
    label: 'OpenAI 官方',
    baseUrl: 'https://api.openai.com/v1/chat/completions',
    model: 'gpt-4o-mini',
    notes: []
  },
  anthropic: {
    label: 'Anthropic 官方',
    baseUrl: 'https://api.anthropic.com/v1/messages',
    model: 'claude-sonnet-4-5',
    notes: ['走 x-api-key 头,与其他 provider 路径不同']
  },
  deepseek: {
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/chat/completions',
    model: 'deepseek-chat',
    notes: []
  }
}

const presetKey = process.argv[2]
if (presetKey) {
  const p = PRESETS[presetKey]
  if (!p) {
    console.log(`未知预置 "${presetKey}",可选:${Object.keys(PRESETS).join(' / ')}`)
    process.exit(1)
  }
  process.env.LLM_BASE_URL = process.env.LLM_BASE_URL || p.baseUrl
  process.env.LLM_MODEL = process.env.LLM_MODEL || p.model
  console.log(`\n已套用预置:${p.label}(${p.model})`)
  for (const n of p.notes) console.log(`  · ${n}`)
}

const hasKey = !!process.env.LLM_API_KEY
console.log(`\n=== LLM 增强自检 ===\n`)
console.log(`LLM_API_KEY  : ${hasKey ? '已设置' : '❌ 未设置(LLM 增强会被跳过,看板退化为纯规则)'}`)
console.log(`LLM_BASE_URL : ${process.env.LLM_BASE_URL ?? '(默认 Anthropic 官方)'}`)
console.log(`LLM_MODEL    : ${process.env.LLM_MODEL ?? '(默认 claude-sonnet-4-5)'}\n`)

if (!hasKey) {
  console.log('跳过(纯规则模式本身是完备的,不会因此出错)。\n')
  console.log('配好 key 再跑一次,例如:')
  console.log('  export LLM_API_KEY=sk-xxxx')
  console.log('  node scripts/check-llm.mjs mimo\n')
  process.exit(0)
}

// 用一条真实的、规则判为 medium 的样本(贴近真实使用,不自造文本)
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
  console.log('  1. key 是否正确、有没有多余引号或空格')
  console.log('  2. LLM_BASE_URL 是否指向你实际用的 provider(填非 anthropic.com 会自动走 OpenAI 兼容格式)')
  console.log('  3. LLM_MODEL 是否存在(填错会 404/400)—— MiMo 用 mimo-v2.6-flash / -pro,别用即将下线的 v2.5')
  console.log('  4. 服务器能否出网访问该端点')
  console.log('  5. 余额是否耗尽(401/403 也可能是欠费而非 key 错)\n')
  console.log('注:即使 LLM 挂了,看板也照常工作 —— 已自动降级为纯规则结果。\n')
  process.exit(1)
}

if (!withLlm.llm) {
  console.log(`⚠ 未启用(风险等级为 ${withLlm.risk},不在 medium/high,按设计跳过 LLM)\n`)
  process.exit(0)
}

console.log(`✅ LLM 调用成功(${ms}ms)`)
console.log(`   捕获影响 : ${withLlm.llm.affectsCapture}`)
console.log(`   MCP 影响 : ${withLlm.llm.affectsMcp}`)
console.log(`   严重度   : ${withLlm.llm.severity}`)
console.log(`   理由     : ${withLlm.llm.reason}`)
console.log(
  `   合并后   : ${withLlm.risk}(规则 ${ruleOnly.risk} → 合并 ${withLlm.risk};LLM 只能加严,不可放松)\n`
)
process.exit(0)
