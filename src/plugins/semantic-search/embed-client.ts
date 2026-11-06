/**
 * 推理 worker 的客户端:一行请求-响应 + 空闲释放 + 崩溃自愈。
 * 主进程只碰这个接口,不 import fastembed 的推理路径。
 */
import type { Worker } from 'node:worker_threads'
import createWorker from './embedder-worker?nodeWorker'

export interface EmbedClient {
  docs(texts: string[]): Promise<number[][]>
  query(text: string): Promise<number[]>
  /** 空闲 15 分钟后终止 worker,把 ONNX arena 的内存还给系统 */
  releaseIfIdle(): void
  dispose(): void
}

interface Pending {
  resolve: (vectors: number[][]) => void
  reject: (err: Error) => void
}

const IDLE_MS = 15 * 60_000

export function createEmbedClient(init: { dataDir: string; cacheDir: string }): EmbedClient {
  let worker: Worker | null = null
  let seq = 0
  let busy = 0
  let lastUsed = 0
  const pending = new Map<number, Pending>()

  const failAll = (err: Error): void => {
    for (const p of pending.values()) p.reject(err)
    pending.clear()
  }

  const spawn = (): Worker => {
    const w = createWorker({ workerData: init })
    w.on('message', (msg: { id: number; ok: boolean; vectors?: number[][]; error?: string }) => {
      const p = pending.get(msg.id)
      if (!p) return
      pending.delete(msg.id)
      if (msg.ok && msg.vectors) p.resolve(msg.vectors)
      else p.reject(new Error(msg.error ?? 'embedding failed'))
    })
    w.on('error', (err) => {
      if (worker === w) worker = null
      failAll(err instanceof Error ? err : new Error(String(err)))
    })
    w.on('exit', (code) => {
      if (worker === w) worker = null
      // 0 = 我们主动 terminate 的,不算故障
      if (code !== 0) failAll(new Error(`embedder worker exited with code ${code}`))
    })
    return w
  }

  const request = (payload: { type: 'docs'; texts: string[] } | { type: 'query'; text: string }): Promise<number[][]> => {
    if (!worker) worker = spawn()
    const id = ++seq
    busy++
    lastUsed = Date.now()
    const w = worker
    return new Promise<number[][]>((resolve, reject) => {
      pending.set(id, { resolve, reject })
      w.postMessage({ id, ...payload })
    }).finally(() => {
      busy--
      lastUsed = Date.now()
    })
  }

  return {
    docs: (texts) => request({ type: 'docs', texts }),
    query: async (text) => {
      const vectors = await request({ type: 'query', text })
      return vectors[0]
    },
    releaseIfIdle: () => {
      if (!worker || busy > 0 || Date.now() - lastUsed < IDLE_MS) return
      const w = worker
      worker = null
      void w.terminate().catch(() => {})
    },
    dispose: () => {
      const w = worker
      worker = null
      failAll(new Error('embedder disposed'))
      void w?.terminate().catch(() => {})
    }
  }
}
