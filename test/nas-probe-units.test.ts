import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

/**
 * NAS 探针的 systemd 单元 —— 锁住几条**踩过才写对**的配置。
 *
 * 背景(2026-11-06):探针原本挂在 cron 10:37,但 NAS 经常在那个时刻关机/休眠,
 * cron 不补跑 → ~/memorysql-probe.log 从未生成,报告日期是 10-25/10-27/11-03/11-06
 * 这种跳跃(全是手动触发)。闭源 agent 的看守退化成"开机那天才看一次"。
 * 换成 systemd timer + Persistent=true 才真正每日一次。
 */

const dir = path.join(process.cwd(), 'scripts')
const timer = fs.readFileSync(path.join(dir, 'nas-probe.timer'), 'utf8')
const service = fs.readFileSync(path.join(dir, 'nas-probe.service'), 'utf8')

const code = (s: string): string =>
  s.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n')

describe('nas-probe.timer', () => {
  it('Persistent=true —— 关机/休眠错过的触发点开机补跑(cron 做不到)', () => {
    expect(code(timer)).toMatch(/^Persistent=true$/m)
  })

  it('每天一次,且与开发机 10:07 错开', () => {
    expect(code(timer)).toMatch(/OnCalendar=\*-\*-\* 10:37:00/)
  })

  it('有随机延迟,避免与开机任务挤在一起', () => {
    expect(code(timer)).toMatch(/RandomizedDelaySec=\d+/)
  })
})

describe('nas-probe.service', () => {
  it('绝对路径(该机 systemd 的 %h 会展开成 /root,不能靠它)', () => {
    const exec = code(service).match(/^ExecStart=(.+)$/m)?.[1] ?? ''
    expect(exec).toContain('/home/logic/local/node-v22.22.1-linux-x64/bin/node')
    expect(exec).toContain('/home/logic/apps/MemorySQL/scripts/nas-probe.mjs')
    expect(code(service), 'unit 里不许出现 %h 之类的 specifier').not.toMatch(/%[a-zA-Z]/)
  })

  it('oneshot + 凭据走 EnvironmentFile(unit 里不写明文 token)', () => {
    expect(code(service)).toMatch(/^Type=oneshot$/m)
    expect(code(service)).toMatch(/^EnvironmentFile=/m)
    expect(code(service), 'token 不能明文出现在 unit 里').not.toMatch(/PROBE_TOKEN=/)
  })

  it('等网络就绪再跑(否则开机补跑会白白上报失败)', () => {
    expect(code(service)).toMatch(/After=network-online\.target/)
  })
})
