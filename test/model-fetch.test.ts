import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { downloadModel, isModelReady, modelDir } from '../src/plugins/semantic-search/model-fetch'

/**
 * 模型自备下载器(2026-11-23 测试报告 P2-3:上游 GCS 桶 403,fastembed 自带下载
 * 会把错误响应体写成 .tar.gz 并永久毒化)。
 *
 * 用本地 HTTP 服务器模拟 HF 镜像的 `/Qdrant/bge-small-zh-v1.5/resolve/main/<file>`
 * 布局,验证「取齐五个文件」「校验失败清半成品」「换镜像重试」三条路径。
 */
const ONNX = Buffer.alloc(10 * 1024 * 1024 + 128, 7)
const FILES: Record<string, Buffer> = {
  'model_optimized.onnx': ONNX,
  'tokenizer.json': Buffer.from(JSON.stringify({ model: { vocab: {} } }).padEnd(2048)),
  'config.json': Buffer.from(JSON.stringify({ pad_token_id: 0 }).padEnd(128)),
  'tokenizer_config.json': Buffer.from(JSON.stringify({ pad_token: '[PAD]' }).padEnd(128)),
  'special_tokens_map.json': Buffer.from(JSON.stringify({ pad_token: '[PAD]' }).padEnd(64))
}

let dir: string
let server: http.Server
let base: string
let mode: 'ok' | 'deny' | 'truncate' = 'ok'

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msql-model-fetch-'))
  server = http.createServer((req, res) => {
    const name = String(req.url ?? '').split('/').pop() ?? ''
    if (mode === 'deny' || !FILES[name]) {
      res.writeHead(403, { 'Content-Type': 'application/xml' })
      res.end('<Error><Code>AccessDenied</Code></Error>')
      return
    }
    const body = FILES[name]
    if (mode === 'truncate') {
      res.writeHead(200, { 'Content-Length': String(body.length) })
      res.write(body.subarray(0, 16))
      res.end()
      return
    }
    res.writeHead(200, { 'Content-Length': String(body.length) })
    res.end(body)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const addr = server.address() as { port: number }
  base = `http://127.0.0.1:${addr.port}`
  mode = 'ok'
})

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()))
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('downloadModel', () => {
  it('取齐五个文件后 isModelReady 为真;再次调用直接复用', async () => {
    expect(isModelReady(dir)).toBe(false)
    const res = await downloadModel({ cacheDir: dir, mirrors: [base] })
    expect(res.downloaded.sort()).toEqual(Object.keys(FILES).sort())
    expect(isModelReady(dir)).toBe(true)
    // 第二次:全部已就绪,不再下载
    const again = await downloadModel({ cacheDir: dir, mirrors: [base] })
    expect(again.downloaded).toEqual([])
    expect(fs.readFileSync(path.join(modelDir(dir), 'model_optimized.onnx')).length).toBe(ONNX.length)
  }, 60_000)

  it('镜像全挂 → 抛错并清掉半成品(不留毒缓存)', async () => {
    mode = 'deny'
    await expect(downloadModel({ cacheDir: dir, mirrors: [base] })).rejects.toThrow(/模型下载失败/)
    expect(isModelReady(dir)).toBe(false)
    // 目录里不该留下任何「看起来像模型」的文件
    const leftovers = fs
      .readdirSync(modelDir(dir))
      .filter((f) => !f.endsWith('.part'))
    expect(leftovers).toEqual([])
  }, 60_000)

  it('截断的下载(长度不符)→ 视为失败并清理', async () => {
    mode = 'truncate'
    await expect(downloadModel({ cacheDir: dir, mirrors: [base] })).rejects.toThrow(/模型下载失败/)
    expect(isModelReady(dir)).toBe(false)
  }, 60_000)
})
