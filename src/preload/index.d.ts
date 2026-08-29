import type { MemorySqlApi } from './index'

declare global {
  interface Window {
    memorysql: MemorySqlApi
  }
}

export {}
