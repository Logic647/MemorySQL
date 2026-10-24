# MemorySQL 宣传片 · 动画版分镜脚本(v2 · 2026-10-24)

> 替代同日早间的截图版(用户否定,材料已全部清理)。**全片无截图无实拍,纯程序化动画**:
> PIL 逐帧绘制 + ffmpeg 合成,1920×1080@30fps,**34 秒**。
> 设计语言:深蓝夜空渐变底(#0A0E1C→#111930)+ 蓝紫点缀(#7C84FF)+ 缓慢上漂微粒;微软雅黑 Bold 标题 / Regular 正文 / Consolas 代码;统一 ease-out 缓动,胶囊/数字用 ease-back 弹入。

## 分镜表

| # | 时间 | 场景 | 画面与动效 | 文案 |
|---|---|---|---|---|
| S1 | 0.0–4.5s | 开场 | logo 弹入(overshoot 1.1×)→主标题上滑淡入→副标题→三枚胶囊依次浮入 | **MemorySQL** / 面向个人开发者的本地优先知识库 / 「自动捕获 · 一次续接 · 本地优先」 |
| S2 | 4.5–10.0s | 痛点 | 标题→5 枚 agent 胶囊错落浮入(Codex/Claude Code/ZCode/Hermes/OpenCode)→每枚右上角弹出红 ✕ 徽章(150ms 步进)→底部三条带红 × 的短语依次出现 | 换一个 agent,就得重新来一遍 / ×重复铺垫背景 ×丢掉当前进度 ×忘记关键决策 |
| S3 | 10.0–15.5s | 捕获 | 左上小 logo + 标题→**12 家 agent 胶囊 4×3 网格逐个弹入**(90ms 步进)→大数字「12」弹性放大→底注 | 会话自动捕获,一个不落 / **12** 家 agent 全覆盖 / 增量监听 · 零手动操作 |
| S4 | 15.5–23.0s | 核心卖点 | 终端窗体上滑(红黄绿三点 + 标题)→「续接 MemorySQL」**逐字打出**(光标闪烁)→4 行输出带绿 ✓ 逐条滑入→紫色高亮胶囊弹出 | `> 续接 MemorySQL` / ✓开发者画像 ✓长期记忆 ✓项目状态 ✓最近会话(含交接摘要) / **一次调用,上下文全部回来** / 7 个 MCP 工具 · 连接即续接 |
| S5 | 23.0–28.5s | 本地优先 | 标题→三枚横条左滑入(SQLite 明文 / 本地 ONNX 离线 / 零服务器)→灰色披露行 | 数据 100% 留在本机 / SQLite 本地存储 · 明文可读 / 语义检索 · 本地 ONNX 离线推理 / 除 LLM API 可选项外,零服务器依赖 / 明文与本地端点的完整披露 · 见 PRIVACY.md |
| S6 | 28.5–34.0s | CTA | 三平台胶囊弹入→GitHub 仓库行(等宽字)→托盘说明→logo + 品牌 + 口号收尾,光晕缓亮 | Windows / macOS / Linux / `github.com/Logic647/MemorySQL` / 安装即驻留托盘 · MCP 持续在线 / 本地优先 · 连接即续接 |

转场:场景共用同一背景,场景层首尾 0.3s/0.4s 淡入淡出形成交叉淡化;全片头 0.5s 从黑淡入、尾 0.6s 淡出到黑。

## 音频(合成,无版权风险)

numpy 合成弦乐垫:Am→F→C→G 四和弦各 8.5s,正弦基频 + 25% 八度泛音,左右声道 ±0.12% 失调展宽;每个和弦起点有 4 音琶音拨弦点缀;全片 1.6s 淡入、2s 淡出,峰值归一 -13dB 左右。**无旁白**——官方 TTS 通道仅对 ZCode 宿主内 MCP 调用开放(CLI 直调返回 `coding_plan_required`,死能力不伪造,详见 out/report.md)。

## 文案口径(与发帖文案一致)

- 12 家 agent 名单与 README 一致:Codex / ZCode / Claude Code / Hermes / Qwen Code / Kimi CLI / CodeBuddy / WorkBuddy / Qoder CLI / Gemini / Cursor / OpenCode。
- 终端演示里的项目名沿用公开演示库的 `caffeine-tracker`(docs/DEMO.md 的合成演示,非真实项目,可公开)。
- 隐私行明写「明文 / 本地端点 / 见 PRIVACY.md」——与 README/PRIVACY.md 口径一致,不做无披露宣传。
- 不出现 winget(审核中),安装引导只给 GitHub Releases 与仓库地址。

## 产物与重渲

| 产物 | 说明 |
|---|---|
| `out/anim/promo.mp4` | 成片(34s) |
| `out/anim/render.py` | 渲染器:`python render.py` 全量渲染(约 2–3 分钟);`python render.py --preview` 出 6 张关键帧 PNG 快速检查 |
| `out/anim/make_bgm.py` | BGM 合成,产出 `out/anim/bgm.wav` |
| `out/anim/preview_f*.png` | 关键帧检查图 |

改脚本 = 改 `render.py` 顶部的场景时间窗与 `s1()`–`s6()` 函数;本分镜表是唯一事实源。渲染器与成片都在 `out/`(gitignore,机器本地),入库的只有本文件——渲染器丢失时按本表重写即可。
