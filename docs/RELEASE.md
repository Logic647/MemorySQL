# 发版清单(Release Checklist)

> v0.4.0 起适用。前置:CI 已接入(推送 main 自动 typecheck/test/build + 打包产物);
> 自动更新已接线(electron-updater 读 GitHub Releases 的 `latest.yml`)。

## 标准发版流程

1. **版本号**:`package.json` bump(如 0.4.0 → 0.5.0),MCP serverInfo 自动跟随(`app.getVersion()`)
2. **本地验证**:`npm run typecheck && npm test && npm run dist`(需 `ELECTRON_MIRROR` / `ELECTRON_BUILDER_BINARIES_MIRROR`,见 AGENTS.md)
3. **烟测**:`./dist/win-unpacked/MemorySQL.exe` 启动 → `curl http://127.0.0.1:8642/health` → 任一语义查询验证 `·语义` 召回
4. **提交 + 推送**:
   ```bash
   git add -A && git commit -m "chore: release vX.Y.Z"
   git tag vX.Y.Z && git push origin main --tags
   ```
5. **创建 GitHub Release**(装了 gh CLI 时):
   ```bash
   gh release create vX.Y.Z dist/MemorySQL-Setup-X.Y.Z.exe dist/MemorySQL-Setup-X.Y.Z.exe.blockmap dist/latest.yml \
     --title "MemorySQL vX.Y.Z" --notes "..."
   ```
   必传三件:**exe + .exe.blockmap(差分更新用)+ latest.yml(updater 索引)**;win-unpacked 可选打包 zip 给免安装用户。
6. **验收自动更新**:已安装旧版的机器启动应用 → 应静默下载新版本并提示;或在设置里手动触发(后续可加)。

## winget 提交(首次发版后)

- ✅ **v0.4.0 已提交**:PR https://github.com/microsoft/winget-pkgs/pull/426778
  (fork `Logic647/winget-pkgs` 分支 `winget-memorysql-0.4.0`,路径 `manifests/l/Logic647/MemorySQL/0.4.0/` 三件套,
  通过 GitHub Contents API 上传——本机无法 clone 大仓库也能提交)
- **后续版本更新流程**:同一分支模式,改 3 个 yaml 的版本号/URL/SHA256 后往同一 PR 追加,或按 winget-pkgs 惯例每个版本一个 PR
- **bot 反馈迭代**:validation pipeline 结果直接评论在 PR 上;如报 manifest 错误,改 `/tmp/winget/*.yaml` 后用同样的 Contents API PUT 到分支即可
- 本机直连 github.com:443 被墙时的完整提交路径见 DEVLOG 2026-08-31 条目(fork/branch/contents 全走 api.github.com)
- manifest 内容模板见 git 历史(本文件不保留副本,以 PR 分支为准)

## scoop 提交(可选,更轻)

- 建一个个人 bucket 仓库(如 `Logic647/scoop-bucket`),放 JSON manifest:

```json
{
  "version": "0.4.0",
  "url": "https://github.com/Logic647/MemorySQL/releases/download/v0.4.0/MemorySQL-Setup-0.4.0.exe",
  "hash": "<Get-FileHash SHA256>",
  "installer": { "script": "Start-Process \"$dir\\$fname\" /S | Wait-Process" },
  "bin": "MemorySQL.exe",
  "shortcuts": [["MemorySQL.exe", "MemorySQL"]],
  "checkver": "github",
  "autoupdate": { "url": "https://github.com/Logic647/MemorySQL/releases/download/v{$version}/MemorySQL-Setup-{$version}.exe" }
}
```
- 用户侧:`scoop bucket add logic647 https://github.com/Logic647/scoop-bucket && scoop install memorysql`

## MCP 生态登记(发布后)

- [PulseMCP](https://www.pulsemcp.com/submit) / [MCP Servers 目录](https://github.com/modelcontextprotocol/servers) PR:登记 `memory_get_context` 等 7 工具与 stdio 桥用法
- 中文社区发布素材:README 首屏截图 + 60 秒 demo 脚本(Codex 干到一半 → 换 Hermes → `memory_get_context` 无缝续接)
