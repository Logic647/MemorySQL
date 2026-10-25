# 抖音图文 · v0.7.0 更新

> 图卡已渲染好:`docs/promo/douyin/card-1.png … card-6.png`(1080×1440,3:4,抖音图文标准比例),品牌色与产品 UI 同源(`tokens.css`)。**发布顺序 = 卡片编号**,上传时按 1→6 排即可。
>
> 图内全部为功能描述文本,无截图、无真实数据,无隐私问题。

## 配文(复制进正文)

```text
换 AI agent 最烦的,就是每次都要重新铺垫一遍背景。

v0.7.0 给每个项目加了「滚动总结」:定期把新会话消化成摘要+待办+决策,滚动更新;agent 通过 MCP 读这一份总结就能接手,不用再翻几十场会话。默认关闭——开了之后配 LLM 就先脱敏再外发,不配 LLM 就是纯本地规则总结,零外发。

这次还带来:免费 API 一键预置(智谱 GLM / SiliconFlow 免费档)、插件分组折叠、会话按项目折叠、安装包瘦到 99.5MB。

项目开源,GitHub 搜 MemorySQL,Windows / Linux / macOS 都有安装包。
```

## 话题标签(贴在配文末尾)

```text
#开源项目 #AIAgent #程序员 #效率工具 #MCP #本地优先 #人工智能 #编程
```

## 置顶评论(抖音正文带不了链接,发完自己评论并置顶)

```text
GitHub:github.com/Logic647/MemorySQL(求个 Star ⭐)
Release:v0.7.0 更新日志在仓库 docs/releases/ 下;有问题评论区见
```

## 图卡内容一览(复核用)

| # | 主题 | 要点 |
|---|---|---|
| 1 | 封面 | 「换 AI agent 不用再从头铺垫背景」+ 三枚能力 chip + 开源/三平台面板 |
| 2 | 项目滚动总结 | 摘要+待办+决策、滚动续写、1500 字、首次全量消化、MCP 工具名(代码面板) |
| 3 | 隐私三条线 | 不开启=零动作 / 配 LLM=先脱敏 / 没配=纯本地零外发 |
| 4 | LLM 引擎聚合 | 免费 API 预置、本地反代免 key、测试连接测草稿、挂了自动降级 |
| 5 | 安装包瘦身 | 105.5 → 99.5 MB、语义组件按需下载、界面整理两条 |
| 6 | 项目简介(尾卡) | 捕获/检索/续接三面板 + GitHub 信息面板 |

## 改文案重渲

改 `docs/promo/douyin/gen_cards.py` 里对应卡片段落后重跑:

```bash
cd docs/promo/douyin
PYTHONHOME="$LOCALAPPDATA/Programs/Python/Python312" \
PYTHONPATH="$LOCALAPPDATA/Programs/Python/Python312/Lib/site-packages" \
"$LOCALAPPDATA/Programs/Python/Python312/python.exe" gen_cards.py
```

折行规则:ASCII 词元原子折行(工具名/URL 不会被截断),中文逐字折行——新文案过长会自动换行,但尽量控制在单行以保版面。
