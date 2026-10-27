import { formatAndTruncateMemory } from './context'
import { parseScopeKey } from './scope'
import { SlidingWindowMemory } from './sliding-window'
import { MemoryDatabase } from './store'
import { MemorySummarizer } from './summarizer'

export * from './scope'
export * from './sliding-window'
export * from './store'

export class HierarchicalMemoryService {
  private readonly db: MemoryDatabase
  private readonly slidingWindow: SlidingWindowMemory
  private readonly summarizer: MemorySummarizer | null = null
  private readonly uncommittedCount: Map<string, number> = new Map()
  private readonly maxTurns: number
  private readonly summaryInterval: number

  constructor(modelName: string, apiKey: string, dbPath: string, maxTurns = 20, summaryInterval = 10, proxy?: string) {
    this.maxTurns = maxTurns
    this.summaryInterval = summaryInterval
    this.db = new MemoryDatabase(dbPath)
    this.slidingWindow = new SlidingWindowMemory(maxTurns)
    this.summarizer = new MemorySummarizer(apiKey, this.db, modelName, proxy)
  }

  public recordTurn(scopeKey: string, userId: string, userMsg: string, modelMsg: string, senderName = ''): void {
    this.slidingWindow.addMessage(scopeKey, 'user', userMsg, userId, senderName)
    this.slidingWindow.addMessage(scopeKey, 'model', modelMsg)

    this.db.saveRecentMessage(scopeKey, 'user', userMsg, userId, senderName)
    this.db.saveRecentMessage(scopeKey, 'model', modelMsg)

    const count = (this.uncommittedCount.get(scopeKey) ?? 0) + 1
    this.uncommittedCount.set(scopeKey, count)

    if (count >= this.summaryInterval && this.summarizer) {
      this.uncommittedCount.set(scopeKey, 0)
      const history = this.slidingWindow.getContext(scopeKey)
      this.summarizer
        .compactChatHistory(scopeKey, history, history[0]?.timestamp ?? Date.now(), Date.now())
        .catch(() => {})
      const userMsgs = history.filter((m) => m.role === 'user' && m.userId === userId).map((m) => m.content)
      if (userMsgs.length >= 2) this.summarizer.extractUserProfile(userId, userMsgs, scopeKey).catch(() => {})
    }
  }

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
    if (!this.slidingWindow.has(scopeKey))
      this.slidingWindow.loadInitialMessages(scopeKey, this.db.loadRecentMessages(scopeKey, this.maxTurns))

    const isGroup = parseScopeKey(scopeKey).type === 'group'
    const formatTime = (ts: number) => {
      const d = new Date(ts)
      const month = String(d.getMonth() + 1).padStart(2, '0')
      const day = String(d.getDate()).padStart(2, '0')
      const hours = String(d.getHours()).padStart(2, '0')
      const minutes = String(d.getMinutes()).padStart(2, '0')
      return `${month}/${day} ${hours}:${minutes}`
    }

    return this.slidingWindow.getContext(scopeKey).map((m) => {
      const timeTag = `[${formatTime(m.timestamp)}]`
      if (m.role === 'model') {
        return { role: 'model', content: `${timeTag} ${m.content}` }
      }
      const userPrefix =
        isGroup && m.userId
          ? `${masterId && String(m.userId) === String(masterId) ? `[OWNER: ${m.senderName || 'Master'}] [UID: ${m.userId}]` : `[GUEST: ${m.senderName || 'User'}] [UID: ${m.userId}]`}`
          : ''
      return {
        role: 'user',
        content: userPrefix ? `${timeTag} ${userPrefix} ${m.content}` : `${timeTag} ${m.content}`
      }
    })
  }

  public assemblePromptContext(_scopeKey: string, userId = ''): string[] {
    const { profileBlock } = formatAndTruncateMemory([], userId ? this.db.getProfileFactRecords(userId, 20) : [])
    return [profileBlock].filter(Boolean)
  }
}
