/**
 * 渲染层主题桥接。
 *
 * 真相源在主进程(`nativeTheme` + settings),这里只做两件事:
 *  1. 首帧前把上次解析结果写到 `<html data-theme>`,避免浅色用户看到一帧深色;
 *  2. 订阅 `push:theme`,主进程切换后所有窗口(主窗口 + 秒搜)一起变。
 */

export type ThemeSetting = 'dark' | 'light' | 'system'
export type ResolvedTheme = 'dark' | 'light'

const CACHE_KEY = 'msql:theme'

interface ThemeState {
  setting: ThemeSetting
  effective: ResolvedTheme
}

export function applyResolvedTheme(theme: ResolvedTheme): void {
  document.documentElement.dataset.theme = theme
}

function cacheTheme(theme: ResolvedTheme): void {
  try {
    localStorage.setItem(CACHE_KEY, theme)
  } catch {
    // localStorage 不可用(隐私模式等):只是会多闪一帧,不影响功能
  }
}

function applyState(state: unknown): void {
  if (!state || typeof state !== 'object') return
  const effective = (state as ThemeState).effective
  if (effective !== 'dark' && effective !== 'light') return
  applyResolvedTheme(effective)
  cacheTheme(effective)
}

/** 首帧:读缓存。没有缓存就保持 :root 的深色默认。 */
export function applyCachedTheme(): void {
  try {
    const v = localStorage.getItem(CACHE_KEY)
    if (v === 'light' || v === 'dark') applyResolvedTheme(v)
  } catch {
    // 同上
  }
}

/** 挂上订阅 + 拉一次当前值(缓存可能是旧的,例如系统主题在启动前变了) */
export function initThemeBridge(): void {
  applyCachedTheme()
  if (!window.memorysql) return
  window.memorysql.on('push:theme', (state) => applyState(state))
  void window.memorysql
    .invoke('memorysql:host:theme')
    .then((state) => applyState(state))
    .catch(() => {
      // host 通道不可用(极少见):保持缓存值
    })
}
