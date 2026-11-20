import test from 'node:test'
import assert from 'node:assert/strict'
import { agentTypeOf, mapAgent } from '../lib/agent-map.mjs'

test('magpie 显示名映射到 MemorySQL agent_type', () => {
  assert.equal(mapAgent('Claude Code'), 'claudecode')
  assert.equal(mapAgent('claude-code'), 'claudecode')
  assert.equal(mapAgent('Codex'), 'codex')
  assert.equal(mapAgent('OpenCode'), 'opencode')
  assert.equal(mapAgent('Kimi CLI'), 'kimicli')
  assert.equal(mapAgent('GitHub Copilot'), 'copilot')
  assert.equal(mapAgent('ZCode'), 'zcode')
})

test('未知名字不猜（省略过滤比传错值好）', () => {
  assert.equal(mapAgent('Some New Agent'), undefined)
  assert.equal(mapAgent(''), undefined)
  assert.equal(mapAgent(null), undefined)
})

test('未知 agent 也能收敛成可写入的 id', () => {
  assert.equal(agentTypeOf('Some New Agent'), 'some-new-agent')
  assert.equal(agentTypeOf(''), 'magpie')
  assert.equal(agentTypeOf('Claude Code'), 'claudecode')
})
