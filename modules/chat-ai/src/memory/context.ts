import type { MemoryNode, ProfileFactRecord } from './store'

export interface BudgetConfig {
  maxChars?: number
}

export function formatAndTruncateMemory(
  pyramidNodes: readonly MemoryNode[],
  profileFacts: readonly ProfileFactRecord[],
  config: BudgetConfig = {}
): { memoryBlock: string; profileBlock: string } {
  const maxChars = config.maxChars ?? 4000

  const profileBlock =
    profileFacts.length > 0
      ? `[USER_CORE_FACTS]\n${profileFacts
          .map((f) => `- [ID: ${f.id}] [${new Date(f.updatedAt).toLocaleDateString('zh-CN')}] ${f.fact}`)
          .join('\n')}`
      : ''

  const memoryLines = pyramidNodes.map(
    (node) => `- [${new Date(node.startTime).toLocaleDateString('zh-CN')} ${node.level}] ${node.summary}`
  )

  let memoryBlock = memoryLines.length > 0 ? `[LONG_TERM_MEMORY_SUMMARIES]\n${memoryLines.join('\n')}` : ''
  while (memoryLines.length > 2 && profileBlock.length + memoryBlock.length > maxChars) {
    memoryLines.pop()
    memoryBlock = `[LONG_TERM_MEMORY_SUMMARIES]\n${memoryLines.join('\n')}`
  }

  return { memoryBlock, profileBlock }
}
