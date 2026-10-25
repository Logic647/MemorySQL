/**
 * 会话页 Agent chips 的排序纯函数:按检测到的会话数降序,0 条沉底
 * (保持配置顺序)。抽出为独立模块是为了单测 —— 「显示取决于检测到了多少」
 * 是这一版的验收点之一。
 */
export interface AgentChip {
  agent: string
  count: number
}

export function orderAgentChips(agents: string[], counts: Map<string, number>): AgentChip[] {
  return agents
    .map((agent) => ({ agent, count: counts.get(agent) ?? 0 }))
    .sort((x, y) => y.count - x.count) // Array#sort 稳定:同为 0 的保持原顺序
}
