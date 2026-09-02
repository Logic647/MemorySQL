import { app } from 'electron'
import path from 'node:path'
import type { MemorySQLPlugin } from '../../main/core/plugin-host'

/**
 * 开机自启动(设置页「通用 · 启动」):通过 app.setLoginItemSettings 写入
 * 登录项,Windows 落注册表 Run 键,即时生效无需重启。`--hidden` 参数让
 * 开机后只驻留托盘(托盘点击/全局热键唤起),MCP 服务照常可用。
 */
const plugin: MemorySQLPlugin = {
  manifest: {
    id: 'core-launcher',
    name: 'Launch at Login',
    version: '0.1.0'
  },

  init(ctx) {
    // dev 模式注册的是 electron.exe,写登录项没有意义,UI 需按 supported=false 处理
    const supported = (): boolean => app.isPackaged

    const launchHiddenArg = (args: string[]): boolean => args.includes('--hidden')

    // the get result doesn't echo args; on Windows the registered command
    // line shows up in launchItems — match our own executable to find it
    const registeredArgs = (): string[] => {
      const s = app.getLoginItemSettings()
      const item = (s.launchItems ?? []).find(
        (it) => path.normalize(it.path ?? '').toLowerCase() === process.execPath.toLowerCase()
      )
      return item?.args ?? []
    }

    ctx.ipc.handle('get', () => {
      if (!supported()) {
        return { supported: false, openAtLogin: false, launchHidden: false }
      }
      return { supported: true, openAtLogin: app.getLoginItemSettings().openAtLogin, launchHidden: launchHiddenArg(registeredArgs()) }
    })

    ctx.ipc.handle('set', (payload) => {
      const { enabled, launchHidden = true } = (payload ?? {}) as { enabled?: boolean; launchHidden?: boolean }
      if (typeof enabled !== 'boolean') throw new Error('set requires {enabled: boolean}')
      if (!supported()) throw new Error('开发模式不支持开机自启动')
      app.setLoginItemSettings({
        openAtLogin: enabled,
        args: enabled && launchHidden ? ['--hidden'] : [],
        path: process.execPath
      })
      const s = app.getLoginItemSettings()
      return { ok: true, openAtLogin: s.openAtLogin, launchHidden: launchHiddenArg(registeredArgs()) }
    })
  }
}

export default plugin
