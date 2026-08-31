import { app, BrowserWindow, globalShortcut, Menu, nativeImage, screen, Tray } from 'electron'
import path from 'node:path'
import type { SettingsStore } from './core/settings'

export interface SpotlightController {
  toggle(): void
  hide(): void
  /** show the main window and push a session-open request into it */
  openSessionInMain(id: number): void
  dispose(): void
}

export const SPOTLIGHT_DEFAULT_HOTKEY = 'Alt+Shift+M'

function trayIcon(): Electron.NativeImage {
  // packaged: extraResources copies build/icon.png to resources/icon.png
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, 'icon.png'), path.join(app.getAppPath(), 'build/icon.png')]
    : [path.join(app.getAppPath(), 'build/icon.png')]
  for (const p of candidates) {
    const img = nativeImage.createFromPath(p)
    if (!img.isEmpty()) return img
  }
  return nativeImage.createEmpty()
}

/**
 * Tray residency + global-hotkey spotlight search. Closing the main window
 * hides it (the tray keeps the MCP server alive); real quit goes through the
 * tray menu or app lifecycle, flagged via before-quit. The spotlight window
 * reuses the renderer bundle with ?spotlight=1 (see SpotlightView).
 */
export function setupSpotlight(deps: {
  win: BrowserWindow
  settings: SettingsStore
}): SpotlightController {
  const { win, settings } = deps
  let isQuitting = false
  let spotlight: BrowserWindow | null = null

  app.on('before-quit', () => {
    isQuitting = true
  })

  // tray residency: closing the main window only hides it
  win.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault()
      win.hide()
    }
  })

  const showMain = (): void => {
    if (win.isDestroyed()) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  }

  const getSpotlight = (): BrowserWindow => {
    if (spotlight && !spotlight.isDestroyed()) return spotlight
    spotlight = new BrowserWindow({
      width: 680,
      height: 460,
      frame: false,
      resizable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      show: false,
      title: 'MemorySQL 秒搜',
      backgroundColor: '#101418',
      webPreferences: {
        preload: path.join(import.meta.dirname, '../preload/index.cjs'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false
      }
    })
    spotlight.setAlwaysOnTop(true, 'screen-saver')
    if (process.env.ELECTRON_RENDERER_URL) {
      void spotlight.loadURL(`${process.env.ELECTRON_RENDERER_URL}/?spotlight=1`)
    } else {
      void spotlight.loadFile(path.join(import.meta.dirname, '../renderer/index.html'), {
        query: { spotlight: '1' }
      })
    }
    spotlight.on('blur', () => {
      if (spotlight?.isVisible()) spotlight.hide()
    })
    spotlight.on('closed', () => {
      spotlight = null
    })
    return spotlight
  }

  const toggle = (): void => {
    const sp = getSpotlight()
    if (sp.isVisible()) {
      sp.hide()
      return
    }
    const anchor = win.isDestroyed() ? screen.getPrimaryDisplay().workArea : win.getBounds()
    const display = screen.getDisplayNearestPoint({
      x: Math.round(anchor.x + anchor.width / 2),
      y: Math.round(anchor.y + anchor.height / 2)
    })
    const wa = display.workArea
    const [w] = sp.getSize()
    sp.setPosition(
      Math.round(wa.x + (wa.width - w) / 2),
      Math.round(wa.y + Math.min(140, wa.height * 0.18))
    )
    sp.show()
    sp.focus()
    if (!sp.isDestroyed()) sp.webContents.send('push:spotlight-shown')
  }

  const openSessionInMain = (id: number): void => {
    if (!id || Number.isNaN(id)) return
    showMain()
    if (!win.isDestroyed()) win.webContents.send('push:open-session', id)
    spotlight?.hide()
  }

  // ---- tray -------------------------------------------------------------
  const hotkey = String(settings.get('spotlight:hotkey', SPOTLIGHT_DEFAULT_HOTKEY))
  const tray = new Tray(trayIcon())
  tray.setToolTip(`MemorySQL — MCP 服务运行中(秒搜 ${hotkey})`)
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '打开 MemorySQL', click: () => showMain() },
      { label: `全局秒搜 (${hotkey})`, click: () => toggle() },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          isQuitting = true
          app.quit()
        }
      }
    ])
  )
  tray.on('click', () => showMain())

  // ---- global hotkey ----------------------------------------------------
  if (!globalShortcut.register(hotkey, toggle)) {
    console.warn(
      `[spotlight] 全局热键 ${hotkey} 注册失败(可能被占用),可在 settings.json 的 spotlight:hotkey 修改后重启`
    )
  }

  return {
    toggle,
    hide: () => spotlight?.hide(),
    openSessionInMain,
    dispose: () => {
      globalShortcut.unregister(hotkey)
      tray.destroy()
      spotlight?.destroy()
    }
  }
}
