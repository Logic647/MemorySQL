# 即刻短帖

> 圈子建议:「一起开源」「独立开发者」或关注 AI 工具的圈子。随口安利风,别用官方文案腔。发布前替换 `〔图:xx〕`。

---

## 版本 A(开发叙事)

同时用三四个 AI 编码 agent 最大的痛:换一个就得把背景重新铺垫一遍。

花了几个月晚上和周末,我做了个开源小工具 MemorySQL:它自动把 10 家 agent(Codex/ZCode/Claude Code/Cursor/Qwen Code 等)的会话收进一个本地库,再起一个本机 MCP 服务——新会话跟 agent 说一句「续接 xx 项目」,画像、记忆、上次干到哪、上一棒交接摘要,一次全回来。

数据全程在你电脑里,明文存储,Obsidian 兼容,导出强制过脱敏。

GitHub 搜 Logic647/MemorySQL,MIT 开源,求反馈 🙏

〔图:02-sessions〕〔图:06-quicksearch〕

---

## 版本 B(更短,偏吐槽开场)

AI 记忆的真相:你换了 agent,它连你姓什么都不记得。

做了个本地优先的小工具,让所有 agent 共享一份"关于你的记忆"——会话自动捕获、一句话续接、数据 100% 本机不联网。开源,Windows 先行:

https://github.com/Logic647/MemorySQL

〔图:02-sessions〕
