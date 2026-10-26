import { formatAndTruncateMemory } from './context'
import { SlidingWindowMemory } from './sliding-window'
import { MemoryDatabase } from './store'
import { MemorySummarizer } from './summarizer'

export class HierarchicalMemoryService {
  private readonly db: MemoryDatabase
  private readonly slidingWindow: SlidingWindowMemory
  private readonly summarizer: MemorySummarizer | null = null
  private readonly uncommittedCount: Map<string, number> = new Map()

  constructor(apiKey?: string, dbPath?: string, maxTurns = 20, proxy?: string, modelName?: string) {
    this.db = new MemoryDatabase(dbPath)
    this.slidingWindow = new SlidingWindowMemory(maxTurns)
    if (apiKey) {
      this.summarizer = new MemorySummarizer(apiKey, this.db, proxy, modelName)
    }
  }

  public recordTurn(scopeKey: string, userId: string, userMsg: string, modelMsg: string, senderName = ''): void {
    this.slidingWindow.addMessage(scopeKey, 'user', userMsg, userId, senderName)
    this.slidingWindow.addMessage(scopeKey, 'model', modelMsg)

    // 同步持久化写入 SQLite，确保关机重启原话不丢失
    this.db.saveRecentMessage(scopeKey, 'user', userMsg, userId, senderName)
    this.db.saveRecentMessage(scopeKey, 'model', modelMsg)

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

  public getDatabase(): MemoryDatabase {
    return this.db
  }

  public getBirthTime(): number {
    return this.db.getOrCreateBirthTime()
  }

  public getShortTerm(scopeKey: string, masterId?: string): { role: 'user' | 'model'; content: string }[] {
    // 首次读取该会话时，若内存滑窗为空，自动从 SQLite 恢复持久化的历史记录
    if (!this.slidingWindow.has(scopeKey)) {
      const persisted = this.db.loadRecentMessages(scopeKey, 20)
      this.slidingWindow.loadInitialMessages(scopeKey, persisted)
    }

    const isGroup = scopeKey.includes(':group:')
    return this.slidingWindow.getContext(scopeKey).map((m) => {
      if (m.role === 'model') return { role: 'model', content: m.content }
      if (!isGroup) return { role: 'user', content: m.content }

      const isSpeakerMaster = masterId && m.userId && String(m.userId) === String(masterId)
      const prefix = isSpeakerMaster
        ? `[主人${m.senderName ? `(${m.senderName})` : ''}]`
        : `[群友${m.senderName ? `(${m.senderName})` : ''}(ID:${m.userId || '未知'})]`
      return {
        role: 'user',
        content: `${prefix}: ${m.content}`
      }
    })
  }

  public assemblePromptContext(scopeKey: string, userId: string): string[] {
    const pyramidNodes = this.db.getPyramidMemories(scopeKey, 8)
    const profileFacts = this.db.getProfileFacts(userId, 15)
    const { memoryBlock, profileBlock } = formatAndTruncateMemory(pyramidNodes, profileFacts)

    const blocks: string[] = []
    if (profileBlock) blocks.push(profileBlock)
    if (memoryBlock) blocks.push(memoryBlock)
    return blocks
  }
}
