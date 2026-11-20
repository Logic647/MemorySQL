// magpie 的工具钩子：把 10 个知识库工具暴露成 magpie 的
// <插件短名>_<工具>（短名 memorysql → memorysql_get_context ...）。
//
// args 用纯 JSON Schema，不依赖 zod；execute 在 magpie 的 Bun 宿主里跑。
// 默认走内置 SQLite 存储；backend=app 时代理本机 MemorySQL 应用。
import { getBackend } from './backend/index.mjs'
import { mapAgent } from './agent-map.mjs'

const TOOL_TIMEOUT = 30_000

function argsOf(args) {
  return args && typeof args === 'object' && !Array.isArray(args) ? args : {}
}

/** 工具调用没有「当前工作目录」上下文，但知道是哪个 agent 在调。 */
function withAgent(args, ctx) {
  const out = { ...argsOf(args) }
  if (!out.agent) {
    const agent = mapAgent(ctx?.agent)
    if (agent) out.agent = agent
  }
  return out
}

function proxy(tool, options, backendPromise) {
  return async (args, ctx) => {
    try {
      const backend = await (backendPromise ?? getBackend(options))
      return await backend.call(`memory_${tool}`, withAgent(args, ctx), {
        timeoutMs: TOOL_TIMEOUT
      })
    } catch (err) {
      // 工具调用失败要让 agent 看见原因，而不是一段空结果
      throw new Error(`MemorySQL 不可用：${err?.message ?? String(err)}`)
    }
  }
}

const str = (description) => ({ type: 'string', description })
const num = (description) => ({ type: 'number', description })
const bool = (description) => ({ type: 'boolean', description })

/** 返回 {tool: {name: {description, args, execute}}}，由 magpie 聚合。 */
export function toolsFor(options = {}, backendPromise = null) {
  const readOnly = options.readOnly === true
  const tools = {
    get_context: {
      description:
        '【何时调用】开始任务、进入不熟悉的项目、用户说"续接/接着上次/继续做"时先调一次（每个会话最多一次）。\n' +
        '返回 MemorySQL 的续接包：全局记忆 + 项目记忆 + 项目总结 + 最近会话（带 id）。这是 MemorySQL 与 magpie 内置记忆的分工所在——它记「谁在哪个项目做到哪一步」。',
      args: {
        type: 'object',
        properties: {
          project: str('项目名或路径关键词，缺省取最近活跃项目'),
          cwd: str('当前工作目录（绝对路径）；优先按最长路径前缀匹配项目'),
          agent: str('按 agent 过滤长期记忆（全局记忆始终包含），如 claudecode / codex'),
          include_last_session: bool('true 时内联最近一次会话的尾部，作为上一棒交接摘要')
        }
      },
      execute: proxy('get_context', options, backendPromise)
    },
    get_project_brief: {
      description:
        '【何时调用】接手做了一半的项目、或用户问"这个项目进展到哪了"时；比逐个翻会话便宜。\n' +
        '返回项目交接简报：全局/项目记忆 + 项目总结 + 最近会话 + 上一棒 tail + 待确认进度。',
      args: {
        type: 'object',
        properties: {
          project: str('项目名或路径关键词，缺省取最近活跃项目'),
          cwd: str('当前工作目录（绝对路径）；优先按最长路径前缀匹配项目'),
          agent: str('按 agent 过滤记忆（全局记忆始终包含）')
        }
      },
      execute: proxy('get_project_brief', options, backendPromise)
    },
    get_project_digest: {
      description:
        '【何时调用】接手项目的第一件事，或用户问"这个项目最近在做什么/还有什么没做完"。\n' +
        '返回项目滚动总结：总览 + 最近进展 + 待办 + 决策；需要细节再用 list_sessions / get_session。',
      args: {
        type: 'object',
        properties: {
          project: str('项目名或路径关键词，缺省取最近活跃项目')
        }
      },
      execute: proxy('get_project_digest', options, backendPromise)
    },
    list_projects: {
      description:
        '【何时调用】需要知道知识库里有哪些项目、每个项目的会话数/最近活跃/总结覆盖时。\n' +
        '返回项目 id、名称、路径、会话数、最后活跃时间、项目总结时间；按最近活跃排序。',
      args: {
        type: 'object',
        properties: {
          limit: num('返回条数，默认 30，上限 100'),
          includeEmpty: bool('true 时包含没有会话的项目（默认 false）')
        }
      },
      execute: proxy('list_projects', options, backendPromise)
    },
    list_sessions: {
      description:
        '【何时调用】需要按项目/agent/时间列会话清单，或要拿会话 id 去 get_session 深读时。按内容找东西用 search。',
      args: {
        type: 'object',
        properties: {
          project: str('项目名或路径关键词（精确匹配项目，不回退最近活跃）'),
          cwd: str('当前工作目录（绝对路径）；优先按最长路径前缀匹配项目'),
          agent: str('按 agent 过滤，如 codex / hermes / zcode'),
          since: num('只看最近 N 天，如 7'),
          limit: num('返回条数，默认 20，上限 100'),
          offset: num('分页偏移，默认 0'),
          includeSubagents: bool('是否包含子代理会话（默认 false）')
        }
      },
      execute: proxy('list_sessions', options, backendPromise)
    },
    get_session: {
      description:
        '【何时调用】已有会话 id、需要逐条看原始对话时（复核某个决定、排查"当时到底怎么说的"）。只要结论时优先 get_project_digest。\n' +
        '默认取最后若干条并按 4 万字符预算截断；要更早内容用 tail，单条长消息用 full=true。',
      args: {
        type: 'object',
        properties: {
          id: num('会话数字 id'),
          tail: num('只取最后 N 条消息（省略则全量）'),
          full: bool('true 时单条消息最多 20000 字符（默认 2000）')
        },
        required: ['id']
      },
      execute: proxy('get_session', options, backendPromise)
    },
    search: {
      description:
        '【何时调用】用户问"上次怎么做的/为什么这样定/之前踩过什么坑"，或你需要引用跨 agent 的历史决策时——先搜再答。\n' +
        '全文检索 MemorySQL 的会话/消息/记忆（trigram，支持中文），可按 kind/agent/项目/时间收窄；语义检索启用时会补足概念查询。',
      args: {
        type: 'object',
        properties: {
          query: str('检索词'),
          limit: num('返回条数，默认 20，上限 100'),
          kind: {
            type: 'string',
            enum: ['session', 'message', 'memory'],
            description: '只搜某类资产'
          },
          agent: str('按 agent 过滤（记忆含全局）'),
          project: str('项目名或路径关键词（会话/消息/项目记忆；全局记忆始终保留）'),
          cwd: str('当前工作目录（绝对路径）；优先按最长路径前缀匹配项目'),
          since: num('只看最近 N 天，如 7')
        },
        required: ['query']
      },
      execute: proxy('search', options, backendPromise)
    },
    stats: {
      description:
        '【何时调用】需要判断 MemorySQL 知识库规模、是否已有数据时（状态页/健康检查）；普通 agent 一般不需要。\n' +
        '返回会话/项目/消息/记忆数量、最近会话时间、数据库文件大小。',
      args: { type: 'object', properties: {} },
      execute: proxy('stats', options, backendPromise)
    }
  }

  if (!readOnly) {
    tools.write = {
      description:
        '【何时调用】用户表达了偏好/习惯、你们拍板了架构决策、或确认了一个以后还会用到的事实——当场记一条。\n' +
        '写入 MemorySQL 长期记忆：默认全局；带 project/cwd 时写成项目记忆。一条只写一件事，内容相同会拒绝重复写入。',
      args: {
        type: 'object',
        properties: {
          kind: {
            type: 'string',
            enum: ['fact', 'preference', 'persona', 'decision'],
            description: '记忆类型'
          },
          content: str('记忆内容（一句话到一小段）'),
          agent: str('写入方 agent 归因，如 claudecode / codex；全局记忆可省略'),
          project: str('关联项目名或路径关键词（需已登记）'),
          cwd: str('当前工作目录（绝对路径）；优先按路径前缀解析项目'),
          scope: {
            type: 'string',
            enum: ['global', 'project'],
            description: '记忆作用域；缺省按 project/cwd 推断'
          },
          tags: { type: 'array', items: { type: 'string' }, description: '标签，最多 10 个' }
        },
        required: ['kind', 'content']
      },
      execute: proxy('write', options, backendPromise)
    }
    tools.log_progress = {
      description:
        '【何时调用】本轮活儿告一段落、用户说"先这样/明天继续"、或要把任务交给下一个 agent 之前——不用等用户提醒。\n' +
        '收工汇报：结构化记录做了什么/下一步/卡在哪，生成一条待确认的进度记忆；任何 agent 拉交接简报时都能看到。',
      args: {
        type: 'object',
        properties: {
          project: str('项目名或路径关键词（需已登记；未匹配则不关联项目）'),
          cwd: str('当前工作目录（绝对路径）；优先按路径前缀解析项目'),
          done: str('本轮完成的事'),
          next: str('下一步计划（可选）'),
          issues: str('遇到的问题/风险（可选）'),
          agent: str('汇报方 agent 归因（可选）')
        },
        required: ['project', 'done']
      },
      execute: proxy('log_progress', options, backendPromise)
    }
  }

  return { tool: tools }
}
