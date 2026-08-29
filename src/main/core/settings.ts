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

  constructor(env: AppEnv) {
    this.env = env
    try {
      this.data = JSON.parse(fs.readFileSync(env.settingsPath, 'utf-8')) as Record<string, unknown>
    } catch {
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
    fs.writeFileSync(this.env.settingsPath, JSON.stringify(this.data, null, 2), 'utf-8')
  }

  all(): Record<string, unknown> {
    return { ...this.data }
  }
}
