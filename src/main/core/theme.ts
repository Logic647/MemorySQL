/**
 * 外观主题(纯函数层,不 import electron —— 单测直接跑)。
 *
 * 单一真相源在主进程:`nativeTheme.themeSource` 决定 `prefers-color-scheme`
 * 与原生窗口外观,渲染层只负责把解析结果写到 `<html data-theme>`。
 * 这样主窗口、秒搜窗口、以及未来任何窗口都自动一致 —— 不需要每个窗口
 * 各自订阅设置存储。
 */
export type ThemeSetting = 'dark' | 'light' | 'system'
export type ResolvedTheme = 'dark' | 'light'

/** 设置存储里的键名(非插件命名空间) */
export const THEME_KEY = 'ui:theme'

export interface ThemeState {
  setting: ThemeSetting
  effective: ResolvedTheme
}

export function normalizeThemeSetting(v: unknown): ThemeSetting {
  if (v === 'light' || v === 'dark' || v === 'system') return v
  // 默认跟随系统(0.7.5 起;此前是 dark)。用户显式选过 dark/light 的保持原值。
  return 'system'
}

/** 把「设置值 + 系统偏好」解析成实际主题 */
export function resolveTheme(setting: ThemeSetting, systemPrefersDark: boolean): ResolvedTheme {
  if (setting === 'light') return 'light'
  if (setting === 'dark') return 'dark'
  return systemPrefersDark ? 'dark' : 'light'
}

/** 窗口底色(React 挂载前那一帧看到的就是它,必须与主题同步,否则会闪一下) */
export function themeBackground(theme: ResolvedTheme): string {
  return theme === 'light' ? '#eef1f7' : '#101418'
}

/** Windows 标题栏覆盖层配色(与 topbar 一致) */
export function titleBarColors(theme: ResolvedTheme): { color: string; symbolColor: string } {
  return theme === 'light'
    ? { color: '#f7f9fc', symbolColor: '#1b2430' }
    : { color: '#0a0e16', symbolColor: '#d8e2ee' }
}
