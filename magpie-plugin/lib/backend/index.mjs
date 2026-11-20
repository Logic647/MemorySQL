// 后端选择：默认内置存储（装插件即用），可选 app（代理本机 MemorySQL 应用）。
//
// 同一个 Bun 宿主里 tools / hooks / 页面服务共享一份后端实例；插件选项变更
// 会重启宿主，所以缓存键带上 kind/dataDir/port/endpoint 就够了。
import { createAppBackend } from './app.mjs'
import { createEmbeddedBackend } from './embedded.mjs'

let cached = null

export async function getBackend(options = {}) {
  const kind = options.backend === 'app' ? 'app' : 'embedded'
  const key = [kind, options.dataDir ?? '', options.port ?? '', options.endpoint ?? ''].join('\0')
  if (cached && cached.key === key) return cached.promise
  const promise =
    kind === 'app' ? Promise.resolve(createAppBackend(options)) : createEmbeddedBackend(options)
  cached = { key, promise }
  promise.catch(() => {
    if (cached?.key === key) cached = null
  })
  return promise
}

export function resetBackend() {
  const previous = cached
  cached = null
  void previous?.promise.then((backend) => backend.close?.()).catch(() => {})
}
