import { contextBridge, ipcRenderer } from 'electron'

const api = {
  /** invoke a plugin-registered IPC handler: channel = `<pluginId>:<name>` */
  invoke: (channel: string, payload?: unknown): Promise<unknown> =>
    ipcRenderer.invoke('memorysql:invoke', channel, payload),
  channels: (): Promise<string[]> => ipcRenderer.invoke('memorysql:channels'),
  mcpTools: (): Promise<string[]> => ipcRenderer.invoke('memorysql:mcp-tools'),
  /** push events from main (e.g. 'push:sessions:changed') */
  on: (event: string, listener: (...args: unknown[]) => void): (() => void) => {
    const wrapped = (_e: unknown, ...args: unknown[]): void => listener(...args)
    ipcRenderer.on(event, wrapped)
    return () => ipcRenderer.removeListener(event, wrapped)
  }
}

export type MemorySqlApi = typeof api

contextBridge.exposeInMainWorld('memorysql', api)
