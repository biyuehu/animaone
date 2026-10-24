import { formatAndTruncateMemory } from './context'
import { SlidingWindowMemory } from './sliding-window'
import { MemoryDatabase } from './store'
import { MemorySummarizer } from './summarizer'

export class HierarchicalMemoryService {
  private readonly db: MemoryDatabase
  private readonly slidingWindow: SlidingWindowMemory
  private readonly summarizer: MemorySummarizer | null = null
  private readonly uncommittedCount: Map<string, number> = new Map()

  constructor(apiKey?: string, dbPath?: string, maxTurns: number = 20) {
    this.db = new MemoryDatabase(dbPath)
    this.slidingWindow = new SlidingWindowMemory(maxTurns)
    if (apiKey) {
      this.summarizer = new MemorySummarizer(apiKey, this.db)
    }
  }

  // 记录新对话并触发异步溢出压缩
  recordTurn(scopeKey: string, userId: string, userMsg: string, modelMsg: string): void {
    this.slidingWindow.addMessage(scopeKey, 'user', userMsg)
    this.slidingWindow.addMessage(scopeKey, 'model', modelMsg)

    const count = (this.uncommittedCount.get(scopeKey) || 0) + 1
    this.uncommittedCount.set(scopeKey, count)

    // 每累积 10 轮对话，触发一次后台无感压缩归档
    if (count >= 10 && this.summarizer) {
      this.uncommittedCount.set(scopeKey, 0)
      const history = this.slidingWindow.getContext(scopeKey)
      const startTime = history[0]?.timestamp || Date.now()
      const endTime = Date.now()

      // 异步执行，不阻塞当前响应通道
      this.summarizer.compactChatHistory(scopeKey, history, startTime, endTime).catch(() => {})
      this.summarizer.extractUserProfile(userId, [userMsg]).catch(() => {})
    }
  }

  // 获取短期滑动窗口对话
  getShortTerm(scopeKey: string): { role: 'user' | 'model'; content: string }[] {
    return this.slidingWindow.getContext(scopeKey).map((m) => ({
      role: m.role,
      content: m.content
    }))
  }

  // 构建拼装好的长期记忆文本段（带智能裁剪）
  assemblePromptContext(scopeKey: string, userId: string): string[] {
    const pyramidNodes = this.db.getPyramidMemories(scopeKey, 8)
    const profileFacts = this.db.getProfileFacts(userId, 15)

    const { memoryBlock, profileBlock } = formatAndTruncateMemory(pyramidNodes, profileFacts)

    const blocks: string[] = []
    if (profileBlock) blocks.push(profileBlock)
    if (memoryBlock) blocks.push(memoryBlock)
    return blocks
  }
}
