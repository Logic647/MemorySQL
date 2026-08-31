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

- 仓库:[microsoft/winget-pkgs](https://github.com/microsoft/winget-pkgs),路径 `w/Logic647.MemorySQL/`
- 用 [YamlCreate](https://github.com/microsoft/winget-pkgs/blob/master/Tools/YamlCreate.ps1) 生成三件套:
  `Logic647.MemorySQL.yaml`(installer,x64 nsis,SHA256 取 `Get-FileHash`)+ `.locale.zh-CN.yaml` + `.installer.yaml`
- 提 PR, winget-validation bot 会自动验包;安装器需要稳定的版本化 URL(GitHub Release 资产即满足)

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
