/**
 * MCP 服务端主动调用引导(协议层)。
 *
 * 为什么要有这一坨文本:
 * MCP 工具默认是「被动」的 —— 模型看到 8 个陌生工具,没有任何理由在用户说出
 * 「续接」之前碰它们。让 agent 自己想起来,只有三个不依赖特定客户端的抓手:
 *
 *   1. initialize 的 `instructions` 字段(MCP 规范里有;客户端**可以**把它塞进系统提示)
 *   2. 每个工具的 description(每个客户端都必须 tools/list,模型一定看得到)
 *   3. 工具返回文本的尾注(只在已经调用过一次之后生效)
 *
 * 1 和 2 是唯一「改服务端就覆盖所有客户端」的位置 —— 不需要用户装钩子、写配置、
 * 或改任何 agent 的私有文件。所以这段文本要写得足够明确(什么时候该调),
 * 同时带预算约束(别每轮都调),否则会变成 token 噪音。
 */

/** initialize 返回的 instructions:客户端会(或可以)把它放进系统提示 */
export const MEMORYSQL_INSTRUCTIONS = `MemorySQL 是用户本机的长期记忆库(MCP 服务),跨会话、跨 agent 共享。**不要等用户说「用 memorysql / 记忆库 / 续接」才用** —— 按下面的时机主动调用:

1. **任何新任务的第一步**(在改代码、翻文件、猜方案之前):memory_get_context({ project: "<当前工作目录名>" })。一次拿到全局画像/偏好/事实/决策、项目记忆、项目滚动总结(总览 + 最近进展)、最近会话与上一棒交接摘要。每个会话最多一次。
2. 用户问「上次怎么做的 / 为什么这样定 / 之前踩过什么坑」:先 memory_search({ query }),不要凭印象回答;要细节再 memory_get_session({ id })。
3. 做了架构决策、发现用户偏好、确认了事实:**当场** memory_write 一条(一条只写一件事,短句;带 project = 项目记忆,不带 = 全局记忆)。
4. 收工、或要把活交给下一个 agent 之前:memory_log_progress({ project, done, next?, issues? }) 汇报「做了什么 / 下一步 / 卡在哪」。

工具选择速查:
- 想知道「这个项目在做什么、还剩什么」→ memory_get_project_digest(最省 token)
- 要接手别人做了一半的活 → memory_get_project_brief
- 要找具体某句话的出处 → memory_search → memory_get_session
- 如果 tools/list 里没有 memory_get_project_digest(用户关掉了「项目总结」插件),用
  memory_get_project_brief 代替 —— 它始终可用,且带规则汇编的最近进展。

预算约束(很重要,否则会变成噪音):
- memory_get_context 每个会话最多调一次;已拿到上下文就不要重复调。
- memory_search 只在确实需要历史时调,不要每轮都搜。
- 只写你确信的结论;不确定的先用一句话跟用户确认再写。
- 这些是用户本机数据:不要复述给外部服务,也不要写进代码或提交信息。`

/**
 * 工具描述的统一前缀。所有 memory_* 工具的描述都必须以它开头 ——
 * 有单测锁住(工具数量 = 前缀出现次数),避免以后新增工具时又退回「介绍这是啥」。
 */
export const WHEN_PREFIX = '【何时调用】'
