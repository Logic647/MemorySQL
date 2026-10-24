# MemorySQL 宣传片分镜脚本(v0.6.0 · 2026-10-24)

> 成片目标:约 31 秒,1920×1080@30fps,横屏,无声旁白(原因见文末「交付边界」)。
> 画面素材全部来自 `design/screenshots/` 的 v0.6.0 真实界面截图;文案口径与五平台发帖文案一致。
> 剪映可编辑源:渲染完成后按 `out/report.md` 说明导入;本文件即分镜表,时间轴改动只改这里。

## 一、分镜表

| # | 时间 | 时长 | 画面 | 字幕(烧录) | 音效/音乐 |
|---|---|---|---|---|---|
| 0 | 0.0–3.5s | 3.5s | 深色底 + MemorySQL logo 居中,轻微放大 | **MemorySQL**<br>面向个人开发者的本地优先知识库 | BGM 淡入(2s) |
| 1 | 3.5–7.5s | 4.0s | 会话库总览(02-sessions.png,12 家 agent 列表 + 会话行「开始/最后」双时间) | 12 家 AI agent 的会话<br>自动捕获,本地可搜 | BGM 连续 |
| 2 | 7.5–11.5s | 4.0s | 会话详情(03-session-detail.png,完整消息时间线) | 完整消息时间线<br>随时回读任意一段 | BGM 连续 |
| 3 | 11.5–15.5s | 4.0s | 记忆库(04-memories.png,画像/偏好/事实/决策 + agent 维度) | 你的画像与长期记忆<br>按 agent 维度沉淀 | BGM 连续 |
| 4 | 15.5–20.0s | 4.5s | 终端 MCP 续接包(01-context-handoff.png,`memory_get_context` 返回) | 新会话一句「续接」<br>上下文全部回来 | BGM 连续 |
| 5 | 20.0–23.5s | 3.5s | 语义检索(06-quicksearch.png,秒搜浮层) | 全文 + 语义双路检索<br>字面搜不到也能召回 | BGM 连续 |
| 6 | 23.5–27.0s | 3.5s | 连接向导(07-connect-wizard.png,一键连接按钮矩阵) | 一键写入 agent 配置<br>连上就能用 | BGM 连续 |
| 7 | 27.0–31.0s | 4.0s | 深色底 + logo + 三平台安装信息 | MemorySQL · 本地优先<br>Windows / macOS / Linux | BGM 淡出(3s) |

合计 31.0s,8 个镜头,镜头间用 0.3–0.5s 交叉淡化(renderer 以 clip 级 fade 实现)。

## 二、转场与节奏

- 每个画面片段自带 `transition_in`/`transition_out` = fade 0.4s(与相邻片段重叠出交叉淡化观感)。
- 字幕为底部居中深色半透明底条,字号 44,白色,微软雅黑。
- BGM 为 ffmpeg 合成的四正弦叠加轻电子底乐,无版权风险,`out/bgm/bgm.wav`,与成片等长 31s,全片 volume 0.5。
- 无对白、无音效点缀——刻意保持「工具演示片」的干净;要加音效在剪映里补即可。

## 三、文案口径核对(与发帖文案一致)

- 「12 家 agent」:Codex / ZCode / Claude Code / Hermes / Qwen Code / Kimi CLI / CodeBuddy / WorkBuddy / Qoder CLI / Gemini CLI / Cursor / OpenCode。
- 「一键写入 agent 配置」对应连接向导的「一键连接」。
- 隐私口径不在视频里展开(时长不够),片尾口播文案层面也不提——视频是引流件,披露以 PRIVACY.md 与发帖正文为准。

## 四、交付边界(如实说明)

1. **本片无 AI 旁白**:官方 TTS 通道只对 ZCode 宿主内 MCP 调用开放(身份头由宿主逐调用注入),CLI/直连端点均返回 `coding_plan_required`/`no permission`。旁白属死能力,未伪造。
2. **字幕已烧录**:所有字幕文字走 timeline text 轨由 ffmpeg drawtext 烧录,剪映打开后仍可在文字轨二次编辑。
3. **BGM 为合成音**:非商用曲库素材,规避版权问题;听感平淡,用户可在剪映里换成正式 BGM(时间轴不变)。
4. 截图 06(秒搜)为 2026-10-08 截图的旧版 UI(单色顶栏),07(连接向导)缺 WorkBuddy/Qoder 两行——两者均为本机真实界面,非合成;若追求完全同步,重截这两张后重跑 `out/segments/build_segments.sh` 即可。
