import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

/**
 * 嵌入模型的**自备下载**。
 *
 * 背景(2026-11-23 测试报告 P2-3):fastembed 的模型源
 * `storage.googleapis.com/qdrant-fastembed` 已对匿名调用返回 **403**,
 * 而它的下载实现①不看 HTTP 状态②只要缓存文件存在就跳过下载 ——
 * 错误响应体被写成 `.tar.gz` 后永久毒化。
 *
 * 绕开办法:fastembed 的 `retrieveModel` 只要看到 `<cacheDir>/<model>/` 目录存在
 * 就直接加载,根本不会去下载。所以我们自己从 HF 镜像把**模型目录里的文件**
 * 取齐(model_optimized.onnx / tokenizer.json / config.json / special_tokens_map.json),
 * fastembed 就能正常初始化 —— 不需要热修 node_modules,也不依赖那个死掉的桶。
 *
 * 仓库:`Qdrant/bge-small-zh-v1.5`(HF),文件名与 fastembed 期望完全一致。
 */

const REPO = 'Qdrant/bge-small-zh-v1.5'
const MODEL_DIR_NAME = 'fast-bge-small-zh-v1.5'

/** 必需文件:缺一个就不算就绪(fastembed 的 loadTokenizer 会逐个 existsSync) */
const REQUIRED: Array<{ name: string; minBytes: number; json?: boolean }> = [
  { name: 'model_optimized.onnx', minBytes: 10 * 1024 * 1024 },
  { name: 'tokenizer.json', minBytes: 1024, json: true },
  { name: 'config.json', minBytes: 64, json: true },
  { name: 'tokenizer_config.json', minBytes: 64, json: true },
  { name: 'special_tokens_map.json', minBytes: 16, json: true }
]

/** 默认镜像顺序:hf-mirror(国内可达)→ 官方 HF */
export const DEFAULT_MIRRORS = ['https://hf-mirror.com', 'https://huggingface.co']

export const modelDir = (cacheDir: string): string => path.join(cacheDir, MODEL_DIR_NAME)

const fileOk = (full: string, spec: (typeof REQUIRED)[number]): boolean => {
  try {
    const st = fs.statSync(full)
    if (!st.isFile() || st.size < spec.minBytes) return false
    if (spec.json) JSON.parse(fs.readFileSync(full, 'utf-8'))
    return true
  } catch {
    return false
  }
}

/** 模型目录是否就绪(四个必需文件都在且有效) */
export function isModelReady(cacheDir: string): boolean {
  const dir = modelDir(cacheDir)
  return REQUIRED.every((spec) => fileOk(path.join(dir, spec.name), spec))
}

export interface DownloadModelOptions {
  cacheDir: string
  /** 自定义镜像列表(按顺序试);不填用 DEFAULT_MIRRORS。用户配置了自建反代时只试它 */
  mirrors?: string[]
  onProgress?: (line: string) => void
}

export interface DownloadModelResult {
  source: string
  modelDir: string
  downloaded: string[]
}

/**
 * 把模型文件下到 `<cacheDir>/fast-bge-small-zh-v1.5/`。
 * 已就绪时直接返回;某个镜像失败会清掉半成品并换下一个。
 */
export async function downloadModel(opts: DownloadModelOptions): Promise<DownloadModelResult> {
  const dir = modelDir(opts.cacheDir)
  if (isModelReady(opts.cacheDir)) {
    return { source: '(cached)', modelDir: dir, downloaded: [] }
  }
  fs.mkdirSync(dir, { recursive: true })
  const mirrors = (opts.mirrors && opts.mirrors.length > 0 ? opts.mirrors : DEFAULT_MIRRORS)
    .filter((m): m is string => typeof m === 'string' && /^https?:\/\//i.test(m.trim()))
    .map((m) => m.trim().replace(/\/+$/, ''))
  if (mirrors.length === 0) throw new Error('没有可用的模型镜像地址')

  const errors: string[] = []
  for (const base of mirrors) {
    const downloaded: string[] = []
    try {
      for (const spec of REQUIRED) {
        const full = path.join(dir, spec.name)
        if (fileOk(full, spec)) continue
        const url = `${base}/${REPO}/resolve/main/${spec.name}`
        opts.onProgress?.(`下载 ${spec.name} ← ${base}`)
        await fetchToFile(url, full)
        if (!fileOk(full, spec)) throw new Error(`${spec.name} 校验失败(不是预期的模型文件)`)
        downloaded.push(spec.name)
      }
      return { source: base, modelDir: dir, downloaded }
    } catch (err) {
      errors.push(`${base}: ${err instanceof Error ? err.message : String(err)}`)
      // 半成品清掉:下次重试从干净状态开始(不重复 403 毒缓存的老路)
      for (const spec of REQUIRED) {
        const full = path.join(dir, spec.name)
        if (!fileOk(full, spec)) fs.rmSync(full, { force: true })
      }
    }
  }
  throw new Error(`模型下载失败(所有镜像均不可用):\n${errors.join('\n')}`)
}

async function fetchToFile(url: string, dest: string): Promise<void> {
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok || !res.body) {
    throw new Error(`HTTP ${res.status} ${res.statusText}`)
  }
  const len = Number(res.headers.get('content-length') ?? '0')
  const tmp = `${dest}.part`
  try {
    await pipeline(Readable.fromWeb(res.body as never), fs.createWriteStream(tmp))
    const size = fs.statSync(tmp).size
    if (len > 0 && size !== len) throw new Error(`下载不完整(${size}/${len} 字节)`)
    fs.renameSync(tmp, dest)
  } catch (err) {
    fs.rmSync(tmp, { force: true })
    throw err
  }
}

/** 模型缺盘时给用户的说明(worker / 主进程共用) */
export const MODEL_MISSING_MESSAGE =
  '嵌入模型未下载 —— 在 设置 → 智能引擎 → 语义检索 里点「下载模型(约 100MB)」后再重建索引。' +
  '(上游 storage.googleapis.com/qdrant-fastembed 已失效,本应用改为从 HF 镜像下载,不再依赖它)'
