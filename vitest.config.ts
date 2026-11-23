import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    /**
     * 默认 5s 在 CI 的 Windows runner(2 核 + 慢盘)上不够:
     * 2026-11-23 的 v0.7.9 tag run 里,两条「建临时 SQLite 库 + 解析」的用例
     * 本地 0.6s、CI 上 5.3/5.6s 超时(整轮测试并行度变高后磁盘竞争更明显)。
     * 放宽到 20s:真有死循环也只是晚 15s 报错,但不再让发版卡在环境抖动上。
     */
    testTimeout: 20_000,
    hookTimeout: 30_000
  }
})
