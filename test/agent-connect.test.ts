import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AGENT_CONNECTORS, type AgentConnector } from '../src/main/core/agent-connect'

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

function opencode(): AgentConnector {
  const c = AGENT_CONNECTORS.find((a) => a.id === 'opencode')
  if (!c) throw new Error('opencode connector missing')
  return c
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
