import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AGENT_CONNECTORS, type AgentConnector } from '../src/main/core/agent-connect'
import { AGENT_BY_ID } from '../src/shared/upstream-agents'

/**
 * Regression guard for the OpenCode v2 MCP entry.
 *
 * OpenCode >= 2.0 requires `type` on every mcp entry. An entry carrying only
 * `url` + `enabled` is silently dropped during config normalization — the
 * server never connects and nothing is surfaced to the user beyond a WARN in
 * ~/.local/share/opencode/log/opencode.log:
 *   kind=unsupported action="omitted enabled-only legacy MCP entry"
 */
let tmp: string

const URL = 'http://127.0.0.1:8642/mcp'
const BRIDGE = 'C:/fake/resources/mcp-bridge.mjs'

function connector(id: string): AgentConnector {
  const c = AGENT_CONNECTORS.find((a) => a.id === id)
  if (!c) throw new Error(`${id} connector missing`)
  return c
}

function opencode(): AgentConnector {
  return connector('opencode')
}

function applyTo(configPath: string): void {
  opencode().apply(configPath, URL, BRIDGE)
}

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>
}

function opencodeEntry(root: Record<string, unknown>): Record<string, unknown> {
  const mcp = root.mcp as Record<string, Record<string, unknown>>
  return mcp.memorysql
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-connect-'))
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('opencode connector', () => {
  it('writes type:remote — required since OpenCode v2, else the entry is dropped', () => {
    const configPath = path.join(tmp, 'opencode.json')
    applyTo(configPath)

    const entry = opencodeEntry(readJson(configPath))
    expect(entry).toEqual({ type: 'remote', url: URL, enabled: true })
  })

  it('repairs a pre-existing legacy entry that is missing type', () => {
    const configPath = path.join(tmp, 'opencode.json')
    fs.writeFileSync(
      configPath,
      JSON.stringify({ mcp: { memorysql: { url: URL, enabled: true } } }, null, 2)
    )

    applyTo(configPath)

    expect(opencodeEntry(readJson(configPath)).type).toBe('remote')
  })

  it('preserves unrelated config keys while patching the mcp entry', () => {
    const configPath = path.join(tmp, 'opencode.json')
    fs.writeFileSync(configPath, JSON.stringify({ theme: 'opencode', mcp: {} }, null, 2))

    applyTo(configPath)

    const root = readJson(configPath)
    expect(root.theme).toBe('opencode')
    expect(opencodeEntry(root).type).toBe('remote')
  })

  it('snippet documents the required type field', () => {
    expect(opencode().snippet(URL, BRIDGE)).toContain('"type": "remote"')
  })
})

/**
 * 写后回读校验 —— 第 1 期新增。
 *
 * 存在的理由:agent 侧拒绝我们写的配置时往往是**静默**的(只在自己日志里留 WARN),
 * 向导却报「已连接」。没有回读,用户只能在重启后发现 MCP 工具根本没出现。
 */
describe('写后回读校验(verify)', () => {
  it('刚写好的配置必须通过校验', () => {
    const configPath = path.join(tmp, 'opencode.json')
    applyTo(configPath)
    expect(opencode().verify?.(configPath, URL)).toBeNull()
  })

  it('配置缺 type 时必须报错(这正是 opencode 静默丢弃的情形)', () => {
    const configPath = path.join(tmp, 'opencode.json')
    // 模拟「写进去了但 agent 不认」:手工造一份缺 type 的配置
    fs.writeFileSync(
      configPath,
      JSON.stringify({ mcp: { memorysql: { url: URL, enabled: true } } }, null, 2)
    )
    const err = opencode().verify?.(configPath, URL)
    expect(err, '缺 type 竟然通过了校验').toBeTruthy()
    expect(err).toContain('type')
  })

  it('type 值不对时报错并说明期望值', () => {
    const configPath = path.join(tmp, 'opencode.json')
    fs.writeFileSync(
      configPath,
      JSON.stringify({ mcp: { memorysql: { type: 'local', url: URL } } }, null, 2)
    )
    const err = opencode().verify?.(configPath, URL)
    expect(err).toContain('remote')
  })

  it('agent 改了配置结构(条目搬走)时报错', () => {
    const configPath = path.join(tmp, 'opencode.json')
    fs.writeFileSync(
      configPath,
      JSON.stringify({ mcpServers: { memorysql: { type: 'remote', url: URL } } }, null, 2)
    )
    const err = opencode().verify?.(configPath, URL)
    expect(err, '条目不在 $.mcp.memorysql 竟然通过了').toBeTruthy()
    expect(err).toContain('$.mcp.memorysql')
  })

  it('报错信息不泄露本机 URL/端口', () => {
    const configPath = path.join(tmp, 'opencode.json')
    fs.writeFileSync(
      configPath,
      JSON.stringify({ mcp: { memorysql: { url: URL, enabled: true } } }, null, 2)
    )
    const err = opencode().verify?.(configPath, URL) ?? ''
    expect(err).not.toContain('127.0.0.1')
    expect(err).not.toContain('8642')
  })

  it('配置文件不存在时报错而非抛异常', () => {
    const err = opencode().verify?.(path.join(tmp, 'nope.json'), URL)
    expect(err).toContain('不存在')
  })

  /**
   * 台账 ↔ 连接器一致性:每个 JSON 连接器写完自己的配置后,必须能通过台账声明的校验。
   * 这条断言是本次改动抓到的最大收获 —— 台账里曾有 6 处 jsonpath/必需键与代码不符
   * (zcode 实为 mcp.servers、cursor 实为 mcpServers、claudecode 实为 type+url 等),
   * 台账写错就等于校验形同虚设。
   */
  it('每个 JSON 连接器写出的配置都能通过台账声明的校验', () => {
    for (const c of AGENT_CONNECTORS) {
      if (!c.verify) continue // codex(TOML)/ hermes(YAML) 不做 JSONPath 校验
      const cfg = path.join(tmp, `${c.id}.json`)
      c.apply(cfg, URL, BRIDGE)
      const err = c.verify(cfg, URL)
      expect(err, `${c.id} 写入的配置通不过自己的校验 —— 台账与代码不一致`).toBeNull()
    }
  })

  it('所有台账里声明了 jsonpath 的 agent 都有对应连接器', () => {
    const ids = new Set(AGENT_CONNECTORS.map((c) => c.id))
    for (const [id, contract] of AGENT_BY_ID) {
      if (!contract.mcp) continue
      expect(ids, `台账有 ${id} 但没有连接器`).toContain(id)
    }
  })
})
