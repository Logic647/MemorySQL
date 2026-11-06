/**
 * 语义检索推理 worker。
 *
 * 之前 fastembed / onnxruntime 跑在主进程:`FlagEmbedding.init` 152ms、每次
 * `queryEmbed` 24–33ms 都是同步 CPU 工作,搜索时会卡住 UI 与 MCP 请求。
 * 现在整个 native 栈(含 ~100MB 模型的加载与推理)都在这个 worker 里,主进程
 * 只收发向量。
 *
 * 协议:父进程 postMessage({ id, type:'docs'|'query', texts|text }),
 *       本 worker 回 { id, ok:true, vectors } 或 { id, ok:false, error }。
 */
import { parentPort, workerData } from 'node:worker_threads'
import { requireFromNativeRuntime } from '../../main/core/native-runtime'

interface WorkerInit {
  /** 打包版从 <dataDir>/native-runtime 加载 fastembed,dev 走 node_modules */
  dataDir: string
  cacheDir: string
}

type FastembedModule = typeof import('fastembed')
type Embedder = Awaited<ReturnType<FastembedModule['FlagEmbedding']['init']>>
type Request =
  | { id: number; type: 'docs'; texts: string[] }
  | { id: number; type: 'query'; text: string }

const init = workerData as WorkerInit
let embedder: Embedder | null = null

async function loadFastembed(): Promise<FastembedModule> {
  try {
    return (await import('fastembed')) as FastembedModule
  } catch {
    return requireFromNativeRuntime<FastembedModule>(init.dataDir, 'fastembed')
  }
}

async function getEmbedder(): Promise<Embedder> {
  if (!embedder) {
    const { FlagEmbedding, EmbeddingModel } = await loadFastembed()
    embedder = await FlagEmbedding.init({
      model: EmbeddingModel.BGESmallZH,
      cacheDir: init.cacheDir
    })
  }
  return embedder
}

parentPort?.on('message', (msg: Request) => {
  void (async () => {
    try {
      const fe = await getEmbedder()
      if (msg.type === 'docs') {
        const vectors: number[][] = []
        for await (const batch of fe.passageEmbed(msg.texts, 32)) vectors.push(...batch)
        parentPort?.postMessage({ id: msg.id, ok: true, vectors })
        return
      }
      const vector = await fe.queryEmbed(msg.text)
      parentPort?.postMessage({ id: msg.id, ok: true, vectors: [vector] })
    } catch (err) {
      parentPort?.postMessage({
        id: msg.id,
        ok: false,
        error: String(err instanceof Error ? err.message : err)
      })
    }
  })()
})
