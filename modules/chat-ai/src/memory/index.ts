import { formatAndTruncateMemory } from './context'
import { SlidingWindowMemory } from './sliding-window'
import { MemoryDatabase } from './store'
import { MemorySummarizer } from './summarizer'

export class HierarchicalMemoryService {
  private readonly db: MemoryDatabase
  private readonly slidingWindow: SlidingWindowMemory
  private readonly summarizer: MemorySummarizer | null = null
  private readonly uncommittedCount: Map<string, number> = new Map()

  constructor(apiKey?: string, dbPath?: string, maxTurns = 20) {
    this.db = new MemoryDatabase(dbPath)
    this.slidingWindow = new SlidingWindowMemory(maxTurns)
    if (apiKey) {
      this.summarizer = new MemorySummarizer(apiKey, this.db)
    }
  }

  public recordTurn(scopeKey: string, userId: string, userMsg: string, modelMsg: string): void {
    this.slidingWindow.addMessage(scopeKey, 'user', userMsg)
    this.slidingWindow.addMessage(scopeKey, 'model', modelMsg)

    const count = (this.uncommittedCount.get(scopeKey) ?? 0) + 1
    this.uncommittedCount.set(scopeKey, count)

    // 每 10 轮异步压缩一次，提取摘要并自动织入图谱线索标签
    if (count >= 10 && this.summarizer) {
      this.uncommittedCount.set(scopeKey, 0)
      const history = this.slidingWindow.getContext(scopeKey)
      const startTime = history[0]?.timestamp ?? Date.now()
      const endTime = Date.now()

      this.summarizer.compactChatHistory(scopeKey, history, startTime, endTime).catch(() => {})
      this.summarizer.extractUserProfile(userId, [userMsg]).catch(() => {})
    }
  }

  // 触发灵感推演/做梦
  public async triggerDream(ownerId: string): Promise<string | null> {
    return this.summarizer ? this.summarizer.dreamReflection(ownerId) : null
  }

  public getShortTerm(scopeKey: string): { role: 'user' | 'model'; content: string }[] {
    return this.slidingWindow.getContext(scopeKey).map((m) => ({
      role: m.role,
      content: m.content
    }))
  }

  // 构建带“顺藤摸瓜联想”与“主人全局画像”的上下文
  public assemblePromptContext(scopeKey: string, userId: string): string[] {
    // 顺藤摸瓜：带出关联图谱节点
    const pyramidNodes = this.db.getPyramidMemories(scopeKey, 8)
    const profileFacts = this.db.getProfileFacts(userId, 15)
    const { memoryBlock, profileBlock } = formatAndTruncateMemory(pyramidNodes, profileFacts)

    const blocks: string[] = []
    if (profileBlock) blocks.push(profileBlock)
    if (memoryBlock) blocks.push(memoryBlock)
    return blocks
  }
}
