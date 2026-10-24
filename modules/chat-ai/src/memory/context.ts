import type { MemoryNode } from './store'

export interface BudgetConfig {
  maxChars?: number // 默认 4000 字符限制
}

export function formatAndTruncateMemory(
  pyramidNodes: MemoryNode[],
  profileFacts: string[],
  config: BudgetConfig = {}
): { memoryBlock: string; profileBlock: string } {
  const maxChars = config.maxChars || 4000

  // 1. 组装用户长期档案（最高优先级，优先保留）
  let profileBlock = ''
  if (profileFacts.length > 0) {
    profileBlock = `【用户的长期已知事实与特征】\n${profileFacts.map((f) => `- ${f}`).join('\n')}`
  }

  // 2. 组装金字塔多层长期记忆
  const memoryLines: string[] = []
  for (const node of pyramidNodes) {
    const dateStr = new Date(node.startTime).toLocaleDateString('zh-CN')
    memoryLines.push(`- [${dateStr} ${node.level}] ${node.summary}`)
  }

  let memoryBlock = memoryLines.length > 0 ? `【过往长期记忆要点】\n${memoryLines.join('\n')}` : ''

  // 3. 动态预算裁剪：如果总长度超出预算，按层级从粗到细整段丢弃更久远的节点
  let totalLength = profileBlock.length + memoryBlock.length
  if (totalLength > maxChars) {
    while (memoryLines.length > 2 && totalLength > maxChars) {
      // 从最旧的节点开始淘汰
      memoryLines.pop()
      memoryBlock = `【过往长期记忆要点】\n${memoryLines.join('\n')}`
      totalLength = profileBlock.length + memoryBlock.length
    }
  }

  return { memoryBlock, profileBlock }
}
