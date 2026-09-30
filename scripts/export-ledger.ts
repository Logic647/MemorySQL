/**
 * 把 TS 契约台账导出为 JSON —— 供云端看板服务读取。
 *
 * 为什么要这一层:云端是 Node 20(不支持 --experimental-strip-types),而台账是
 * .ts(有类型检查与注释)。导出 JSON 让云端保持**零依赖、纯 JS**;由
 * test/upstream-contract.test.ts 断言 JSON 与 TS 同步,防中间层腐化。
 *
 * 用法(Node ≥22 本地跑):node --experimental-strip-types scripts/export-ledger.ts
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { AGENTS, DEFAULT_RISK_KEYWORDS } from '../src/shared/upstream-agents.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const out = path.join(here, '..', 'upstream', 'ledger.json')

// 运行时不需要的类型定义不要导出,云端只吃数据
const payload = {
  version: 1,
  generatedFrom: 'src/shared/upstream-agents.ts',
  riskKeywords: DEFAULT_RISK_KEYWORDS,
  agents: AGENTS
}

fs.mkdirSync(path.dirname(out), { recursive: true })
fs.writeFileSync(out, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8')
console.log(`台账已导出 → ${path.relative(process.cwd(), out)} (${AGENTS.length} 家 agent)`)
