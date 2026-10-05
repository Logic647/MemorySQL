import { describe, expect, it } from 'vitest'
import fs from 'node:fs'

/**
 * MCP 端点开关 —— 一个**隐私控制**,它失效的方式是静默的。
 *
 * 这个端点故意不做鉴权(免去本机 agent 的凭据交换),代价是本机任何进程都能
 * 读走全部记忆与会话,隐私披露里如实写了这一点。既然如此,"关掉它"就必须是
 * 用户点得到的控件,而不是"去改 settings.json 或退出应用"。
 *
 * 风险全在**接线上**,而接线断了不会报错:
 *   - 写错键名 → 开关点了没反应,端点继续开着,而用户以为已经关了
 *   - 用 `plugin.<id>.enabled` → 插件被宿主整个跳过,/status 与 /restart 消失,
 *     用户在界面里**再也打不开**
 *   - 缺 `mcp-server:restart` → 开关要重启应用才生效,体验上等于没有
 *
 * 这些都是"看起来做完了"的那类缺陷,所以逐条钉住。
 */

const read = (p: string) => fs.readFileSync(new URL(p, import.meta.url), 'utf8')
const plugin = read('../src/plugins/mcp-server/index.ts')
const host = read('../src/main/core/plugin-host.ts')
const main = read('../src/main/index.ts')
const view = read('../src/renderer/src/SettingsView.tsx')
const api = read('../src/renderer/src/api.ts')

/** 剥掉整行注释再匹配 —— 断言扫源码时必须做,否则改一次注释就红一次 */
const code = (s: string): string =>
  s
    .split('\n')
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*'))
    .join('\n')

describe('键名对齐(断了不会报错,只会静默失效)', () => {
  it('ctx.settings 按 `pluginId:key` 命名空间', () => {
    // 这是整条链路的地基:插件的 get('enabled') 等价于 settings.get('mcp-server:enabled')
    expect(host).toMatch(/get: <T,>\(key: string, defaultValue: T\) => this\.settings\.get\(`\$\{id\}:\$\{key\}`/)
  })

  it('设置页写的是 `mcp-server:enabled`,与上面一致', () => {
    expect(view).toMatch(/hostPluginSetting\('mcp-server', 'enabled', next\)/)
    // handler 落盘的形式是 `${id}:${key}`
    expect(main).toMatch(/settings\.set\(`\$\{id\}:\$\{key\}`, value\)/)
  })

  it('**刻意不用 `plugin.mcp-server.enabled`** —— 那会让插件被卸载', () => {
    // 宿主用这个键决定跳过插件;用了它,/status 与 /restart 通道消失,
    // 用户在界面里就再也打不开(只能改文件重启)。开关必须是可逆的。
    expect(host).toMatch(/this\.settings\.get\(`plugin\.\$\{id\}\.enabled`, true/)
    expect(view).not.toMatch(/hostPluginSetting\('mcp-server', 'plugin\.mcp-server\.enabled'/)
  })

  it('插件的 startServer 本来就尊重这个键(不是新加的分支)', () => {
    const body = code(plugin.slice(plugin.indexOf('function startServer')))
    expect(body.slice(0, 600)).toMatch(/get\('enabled', true\)/)
    expect(body.slice(0, 600)).toMatch(/if \(!enabled\)/)
  })
})

describe('开关当场生效,不必重启应用', () => {
  it('api 暴露了 mcpRestart', () => {
    expect(api).toMatch(/mcpRestart/)
    expect(api).toMatch(/'mcp-server:restart'/)
  })

  it('插件真的注册了 restart 通道(stop + start)', () => {
    const body = code(plugin.slice(plugin.indexOf("ctx.ipc.handle('restart'")))
    expect(body.slice(0, 200)).toMatch(/stopServer\(\)/)
    expect(body.slice(0, 200)).toMatch(/startServer\(\)/)
  })

  it('设置页在写完设置后调用 restart', () => {
    // 少了这一步,开关要重启应用才生效 —— 体验上等于没有
    expect(view).toMatch(/hostPluginSetting\('mcp-server', 'enabled', next\)[\s\S]{0,200}?api\.mcpRestart\(\)/)
  })

  it('失败要回滚开关,不能停在"看起来已生效"的状态', () => {
    // 这是本项目最在意的一类:界面显示成功而实际没生效
    const seg = view.slice(view.indexOf("hostPluginSetting('mcp-server'"))
    expect(seg.slice(0, 900)).toMatch(/catch[\s\S]{0,200}?setMcpOn\(prev\)/)
  })
})

describe('界面用的是现成的开关样式(别发明新 class)', () => {
  it('用 field-row + label.switch,且带 slider', () => {
    // .switch 的 CSS 靠 `input:checked + .slider` 生效;少了 slider 会渲染成不可见
    const seg = view.slice(view.indexOf("hostPluginSetting('mcp-server'") - 900)
    expect(seg).toMatch(/className="field-row"/)
    expect(seg).toMatch(/className="switch"/)
    expect(seg).toMatch(/className="slider"/)
  })

  it('没有残留那个不存在的 toggle-row class', () => {
    expect(view).not.toMatch(/toggle-row/)
  })

  it('状态文案要说清关闭后的后果', () => {
    // "关闭"到底意味着什么,用户必须一眼看到,否则不敢点
    expect(view).toMatch(/本机进程读不到/)
  })
})

describe('隐私披露里的说法与实现一致', () => {
  it('PRIVACY.md 那句"没有 UI 开关"必须已改掉', () => {
    // 曾经如实写着「内部开关没有界面入口,只能退出应用」。加了开关还不改,
    // 披露就与实现对不上了 —— 那比缺控件更糟。
    const privacy = read('../PRIVACY.md')
    expect(privacy).not.toMatch(/没有用户可见|没有用户-facing|只能退出应用|只能靠退出/)
  })

  it('PRIVACY.md 仍然如实说明端点无鉴权(不能因为加了开关就淡化这点)', () => {
    const privacy = read('../PRIVACY.md')
    expect(privacy).toMatch(/无鉴权/)
    expect(privacy).toMatch(/127\.0\.0\.1/)
  })
})
