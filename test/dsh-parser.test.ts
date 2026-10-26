import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { describe, expect, it } from 'vitest'
import {
  classifyDshText,
  collectDsh,
  findDshFiles,
  latestGenerationFiles,
  parseDshSession,
  zstdDecompressFrames
} from '../src/plugins/capture-dsh/dsh-parser'

/**
 * DeepSeek Harness(dsh)会话日志解析 —— 样本按上游真实格式(deepseek-ai/deepseek-harness
 * @ master 的 snapshots/session/*.session.v4.jsonl 与 packages/session/* 源码)构造,
 * 字段名逐一对应,不凭空捏造。
 */

// 与上游 snapshot 逐字段对齐的会话头:type=session + version/id/createdAt(ms)/cwd/isSeeded/delegationDepth
const HEADER = JSON.stringify({
  type: 'session',
  version: 4,
  id: 'sess-abc',
  createdAt: 1783951000000,
  cwd: 'D:\\work\\demo',
  isSeeded: false,
  delegationDepth: 0
})

// 真实 user/message:真人提示 source.kind==='user';注入上下文 kind!=='user' 要跳过
function userLine(text: string, time?: number): string {
  return JSON.stringify({
    type: 'user/message',
    ...(time !== undefined ? { time } : {}),
    data: {
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
      role: 'user',
      id: 'm1'
    },
    surfaceOp: 'append'
  })
}

function injectedContextLine(text: string): string {
  return JSON.stringify({
    type: 'user/message',
    data: {
      content: [{ type: 'text', text }],
      source: { kind: 'runtime-context', form: 'snapshot' },
      role: 'user',
      id: 'm2'
    },
    surfaceOp: 'append'
  })
}

// 真实 assistant/message:content 块 text=正文 / tool-call=工具调用 / reasoning=思考
function assistantLine(blocks: unknown[], time?: number): string {
  return JSON.stringify({
    type: 'assistant/message',
    ...(time !== undefined ? { time } : {}),
    data: {
      turn: 1,
      step: 1,
      message: { role: 'assistant', content: blocks, id: 'm3' },
      usage: { inputTokens: 3, outputTokens: 3 }
    },
    surfaceOp: 'append'
  })
}

function titleLine(title: string): string {
  return JSON.stringify({ type: 'session/title', data: { title } })
}

describe('parseDshSession', () => {
  it('解析用户/助手/工具调用,跳过注入上下文与 reasoning 块', () => {
    const text = [
      HEADER,
      userLine('帮我修登录报错', 1783951005000),
      injectedContextLine('Current working directory: ...'),
      assistantLine(
        [
          { type: 'reasoning', text: '先看错误' },
          { type: 'text', text: '我来看看' },
          { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{"command":"ls"}' }
        ],
        1783951060000
      ),
      titleLine('修登录报错')
    ].join('\n')

    const s = parseDshSession('sess-abc/session.v4.jsonl', text)
    expect(s).not.toBeNull()
    expect(s!.externalId).toBe('sess-abc')
    expect(s!.agentType).toBe('dsh')
    expect(s!.cwd).toBe('D:\\work\\demo')
    expect(s!.title).toBe('修登录报错')
    // startedAt 取会话头的 createdAt(ms→s)
    expect(s!.startedAt).toBe(Math.floor(1783951000000 / 1000))
    // endedAt 取**事件行的 time** 最大值 —— 上游 released v2 codec 的
    // EVENT_REQUIRED 含 time;若丢掉它,长会话的「最后对话时间」恒等于创建时间
    expect(s!.endedAt).toBe(Math.floor(1783951060000 / 1000))
    // 每条消息带自己的时间
    expect(s!.messages[0].ts).toBe(Math.floor(1783951005000 / 1000))
    expect(s!.messages[1].ts).toBe(Math.floor(1783951060000 / 1000))
    // 注入上下文被跳过、reasoning 被跳过
    expect(s!.messages).toHaveLength(3)
    expect(s!.messages[0]).toMatchObject({ role: 'user', content: '帮我修登录报错' })
    expect(s!.messages[1]).toMatchObject({ role: 'assistant', content: '我来看看' })
    expect(s!.messages[2]).toMatchObject({ role: 'tool', toolName: 'bash' })
  })

  it('没有事件 time 时 endedAt 回落到 createdAt', () => {
    const s = parseDshSession('x/session.v4.jsonl', [HEADER, userLine('无时间戳')].join('\n'))
    expect(s!.startedAt).toBe(Math.floor(1783951000000 / 1000))
    expect(s!.endedAt).toBe(Math.floor(1783951000000 / 1000))
    expect(s!.messages[0].ts).toBeUndefined()
  })

  it('source.kind 缺失时按用户消息收(兼容旧代数)', () => {
    const line = JSON.stringify({
      type: 'user/message',
      data: { content: [{ type: 'text', text: '无 source 的用户行' }], role: 'user' }
    })
    const s = parseDshSession('x/session.jsonl', [HEADER, line].join('\n'))
    expect(s!.messages).toHaveLength(1)
    expect(s!.messages[0].content).toBe('无 source 的用户行')
  })

  it('子 agent 会话(delegationDepth>0 / origin=subagent)跳过', () => {
    const sub = JSON.stringify({
      type: 'session',
      version: 4,
      id: 'child',
      createdAt: 1,
      cwd: 'D:\\work',
      isSeeded: false,
      delegationDepth: 1
    })
    expect(parseDshSession('x/session.v4.jsonl', [sub, userLine('hi')].join('\n'))).toBeNull()
  })

  it('无消息/无头/纯噪声返回 null', () => {
    expect(parseDshSession('x/session.jsonl', 'not json\n{"type":"meta"}')).toBeNull()
    expect(parseDshSession('x/session.jsonl', '')).toBeNull()
    expect(parseDshSession('x/session.jsonl', HEADER)).toBeNull()
  })
})

describe('decodeDshFile + collectDsh(zstd 拼接帧)', () => {
  it('解压默认 zstd 拼接帧并解析成会话', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-test-'))
    try {
      // DSH 默认:header 一帧 + 每批追加一帧,拼接成一个 .jsonl.zstd 文件
      const frames = [
        zlib.zstdCompressSync(Buffer.from(HEADER + '\n')),
        zlib.zstdCompressSync(Buffer.from(userLine('第一条') + '\n')),
        zlib.zstdCompressSync(Buffer.from(assistantLine([{ type: 'text', text: '收到' }]) + '\n'))
      ]
      const file = path.join(root, '--d--work--demo--', 'sess-abc', 'session.v4.jsonl.zstd')
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, Buffer.concat(frames))

      const sessions = collectDsh(root)
      expect(sessions).toHaveLength(1)
      expect(sessions[0].externalId).toBe('sess-abc')
      expect(sessions[0].messages).toHaveLength(2)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('未压缩 .jsonl 也能读', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-test-'))
    try {
      const file = path.join(root, '--x--', 's', 'session.jsonl')
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, [HEADER, userLine('hi')].join('\n'), 'utf-8')
      expect(collectDsh(root)).toHaveLength(1)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('findDshFiles(文件名白名单)', () => {
  it('只收 session/session.vN 代数名,跳过 session.lock 与临时文件', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-test-'))
    try {
      const ok = path.join(root, 'session.v4.jsonl')
      const okZ = path.join(root, 'session.jsonl.zstd')
      fs.writeFileSync(ok, 'x')
      fs.writeFileSync(okZ, 'x')
      fs.writeFileSync(path.join(root, 'session.lock'), 'x')
      fs.writeFileSync(path.join(root, 'session.v0.jsonl'), 'x') // .v0 非规范名
      fs.writeFileSync(path.join(root, 'tmp-123.jsonl'), 'x')
      const got = findDshFiles(root).map((f) => path.basename(f)).sort()
      expect(got).toEqual(['session.jsonl.zstd', 'session.v4.jsonl'])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

/**
 * 回归:同一会话目录里并存多个代数时,只取**代数最高**的那个。
 *
 * 上游刻意保留不可变历史代数(README「On-disk layout」),运行时规则是选最高代数。
 * 若每个代数都入库,它们共享同一个 externalId,最后读到的覆盖前面的 ——
 * 实测 v9(1 条)+ v10(3 条) 最终库里只剩 v9 的 1 条,完整日志被冻结前缀顶掉。
 */
describe('latestGenerationFiles(多代数并存)', () => {
  it('每会话目录只保留最高代数', () => {
    const files = [
      'C:/dsh/sessions/--p--/sessA/session.jsonl',
      'C:/dsh/sessions/--p--/sessA/session.v2.jsonl',
      'C:/dsh/sessions/--p--/sessA/session.v10.jsonl',
      'C:/dsh/sessions/--p--/sessB/session.v3.jsonl.zstd'
    ]
    const got = latestGenerationFiles(files).sort()
    expect(got).toEqual([
      'C:/dsh/sessions/--p--/sessA/session.v10.jsonl',
      'C:/dsh/sessions/--p--/sessB/session.v3.jsonl.zstd'
    ])
  })

  it('同代数下 .zstd 优先于未压缩', () => {
    const files = ['C:/s/a/session.v4.jsonl', 'C:/s/a/session.v4.jsonl.zstd']
    expect(latestGenerationFiles(files)).toEqual(['C:/s/a/session.v4.jsonl.zstd'])
  })

  it('collectDsh 只产出该会话的一条记录,且内容是最高代数的', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-gen-'))
    try {
      const dir = path.join(root, '--p--', 'sessA')
      fs.mkdirSync(dir, { recursive: true })
      // 旧代数只有 1 条消息
      fs.writeFileSync(
        path.join(dir, 'session.v9.jsonl'),
        [HEADER, userLine('旧代数只有这一条')].join('\n'),
        'utf-8'
      )
      // 新代数 3 条
      fs.writeFileSync(
        path.join(dir, 'session.v10.jsonl'),
        [
          HEADER,
          userLine('第一条'),
          assistantLine([{ type: 'text', text: '回复一' }]),
          userLine('第三条')
        ].join('\n'),
        'utf-8'
      )
      const sessions = collectDsh(root)
      expect(sessions).toHaveLength(1)
      expect(sessions[0].messages).toHaveLength(3)
      expect(sessions[0].messages[0].content).toBe('第一条')
      expect(sessions[0].rawPath).toContain('session.v10.jsonl')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

/**
 * 回归:zstd 拼接帧必须逐帧精确切开。
 *
 * 两个已实测的坑:
 *   1. Node 的 zstdDecompressSync 遇到拼接流只解第一帧(返回 header 那几十字节)。
 *   2. 「试解一遍看成功没有」不能当边界判据 —— 截断前缀几乎总能"成功"并返回
 *      部分/零字节(252/252 个截断点),误判后会把后续所有真实帧丢掉且不报错。
 * 现在用 info:true 的 engine.bytesWritten 精确切帧。
 */
describe('zstdDecompressFrames(拼接帧切分)', () => {
  it('多帧拼接全部解出(不是只解第一帧)', () => {
    const payloads = [
      '{"type":"session","id":"s"}\n',
      Array.from({ length: 40 }, (_, i) => JSON.stringify({ i, text: 'y'.repeat(80) })).join('\n') + '\n',
      '{"tail":true}\n'
    ]
    const frames = payloads.map((p) => zlib.zstdCompressSync(Buffer.from(p)))
    const got = zstdDecompressFrames(Buffer.concat(frames)).toString('utf-8')
    expect(got).toBe(payloads.join(''))
  })

  it('压缩载荷里嵌帧魔数也不会误切', () => {
    // 载荷里真的放 4 个字节 28 B5 2F FD,再压成帧
    const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
    const evil = Buffer.concat([Buffer.from('{"a":"'), magic, Buffer.from('"}\n')])
    const evilFrame = zlib.zstdCompressSync(evil)
    const goodFrame = zlib.zstdCompressSync(Buffer.from('{"b":2}\n'))
    const got = zstdDecompressFrames(Buffer.concat([evilFrame, goodFrame]))
    expect(got.equals(Buffer.concat([evil, Buffer.from('{"b":2}\n')]))).toBe(true)
  })

  it('尾部残缺帧丢弃,已完整的前帧保留(上游 torn-frame 语义)', () => {
    const f1 = zlib.zstdCompressSync(Buffer.from('{"one":1}\n'))
    const f2 = zlib.zstdCompressSync(Buffer.from('{"two":2}\n'))
    const torn = f2.subarray(0, Math.floor(f2.length / 2))
    const got = zstdDecompressFrames(Buffer.concat([f1, torn])).toString('utf-8')
    expect(got).toBe('{"one":1}\n')
  })

  it('带 checksum 的帧也能解', () => {
    const payload = Buffer.from('{"c":1}\n')
    const f = zlib.zstdCompressSync(payload, {
      params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 }
    })
    expect(zstdDecompressFrames(f).toString('utf-8')).toBe('{"c":1}\n')
  })

  it('空缓冲返回空', () => {
    expect(zstdDecompressFrames(Buffer.alloc(0)).length).toBe(0)
  })
})

/**
 * 回归:解码失败必须**抛错**,不能静默当成"没有会话"。
 *
 * dsh 只有一个强制编码(zstd);解码一坏就是整家静默消失,而捕获状态仍显示
 * healthy / 0 条 —— 正是 AGENTS.md 点名的静默失效家族。
 */
describe('collectDsh(解码失败可见化)', () => {
  it('损坏的 .zstd 抛错而不是静默跳过', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-bad-'))
    try {
      const dir = path.join(root, '--p--', 's1')
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), Buffer.from('not a zstd frame at all'))
      expect(() => collectDsh(root)).toThrow(/无法解码/)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

/**
 * 回归:黑盒检查器必须能区分「按设计跳过」与「读不懂」。
 *
 * 上游 dsh 的一个 sessions 根下可能有成百个独立会话文件,其中相当一部分是
 * 子 agent 碎片(delegationDepth>0)或没有真人提示的空会话 —— 它们解析不出
 * 会话是**正常**的。旧检查器只看第一个文件、null 就判 drift,于是健康的
 * 安装会稳定报 🔴,白触发一次适配发版(判定还取决于目录遍历顺序)。
 */
describe('classifyDshText(检查器的跳过/漂移判据)', () => {
  it('子 agent 会话 → subagent(不是漂移)', () => {
    const sub = JSON.stringify({
      type: 'session',
      version: 4,
      id: 'c',
      createdAt: 1,
      isSeeded: false,
      delegationDepth: 1
    })
    expect(classifyDshText([sub, userLine('子任务')].join('\n'))).toBe('subagent')
  })

  it('没有真人提示的空会话 → empty(不是漂移)', () => {
    expect(classifyDshText([HEADER, injectedContextLine('只有注入上下文')].join('\n'))).toBe('empty')
  })

  it('缺少会话头 → no-header(这才是漂移)', () => {
    expect(classifyDshText('{"type":"something-else"}\n')).toBe('no-header')
    expect(classifyDshText('')).toBe('no-header')
  })

  it('正常会话 → ok', () => {
    expect(classifyDshText([HEADER, userLine('正常')].join('\n'))).toBe('ok')
  })
})
