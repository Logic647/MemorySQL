import fs from 'node:fs'
import type { AppEnv } from './env'

/**
 * Flat key-value settings persisted to <dataDir>/settings.json.
 * Plugins read/write via PluginContext.settings with namespaced keys
 * ("plugin-id:key"), so there are no collisions.
 */
export class SettingsStore {
  private data: Record<string, unknown> = {}
  private env: AppEnv
  /**
   * 配置读取失败时的说明(设置页可展示)。正常首次启动(没有文件)为 null。
   *
   * 2026-11-23 测试报告 P2-2:settings.json 带 UTF-8 BOM(记事本保存)时
   * `JSON.parse` 抛错 → 旧实现 catch 成 `{}`,之后任一 `set()` 立刻用空对象
   * 覆盖原文件:插件开关、捕获水位、LLM 配置、同步身份(deviceId)全部静默丢失,
   * 旧设备 bundle 变孤儿。
   */
  loadError: string | null = null
  /** 解析失败时原文件的备份路径(不改不删,便于用户手工修复) */
  corruptBackupPath: string | null = null

  constructor(env: AppEnv) {
    this.env = env
    let raw: string
    try {
      raw = fs.readFileSync(env.settingsPath, 'utf-8')
    } catch {
      return // 首次启动:还没有配置文件
    }
    // BOM 不是 JSON 的一部分;剥掉再解析,其余内容照常生效
    const text = raw.replace(/^\uFEFF/, '')
    try {
      const parsed: unknown = JSON.parse(text)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('顶层不是对象')
      }
      this.data = parsed as Record<string, unknown>
    } catch (err) {
      // 真损坏:把原文件改名备份,空对象起步并记录错误 —— 不做静默覆盖
      const backup = `${env.settingsPath}.corrupt-${Date.now()}`
      try {
        fs.renameSync(env.settingsPath, backup)
        this.corruptBackupPath = backup
      } catch {
        /* 备份失败也要继续启动 */
      }
      this.loadError = `settings.json 解析失败: ${err instanceof Error ? err.message : String(err)}${
        this.corruptBackupPath ? ` — 原文件已备份为 ${this.corruptBackupPath}` : ''
      }`
      console.error('[settings]', this.loadError)
      this.data = {}
    }
  }

  get<T = unknown>(key: string, defaultValue: T): T {
    if (Object.prototype.hasOwnProperty.call(this.data, key)) {
      return this.data[key] as T
    }
    return defaultValue
  }

  set(key: string, value: unknown): void {
    this.data[key] = value
    // atomic-ish write: temp file + rename, so a crash mid-write can't
    // wipe the whole settings file
    const tmp = `${this.env.settingsPath}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf-8')
    fs.renameSync(tmp, this.env.settingsPath)
  }

  all(): Record<string, unknown> {
    return { ...this.data }
  }
}
