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
  private readonly uncommittedChatCount: Map<string, number> = new Map()
  private readonly activeChatBuffer: Map<string, { role: 'user' | 'model'; content: string; timestamp: number }[]> =
    new Map()
  private readonly masterSpeechBuffer: string[] = []
  private pendingDreamSpoken: string | null = null
  private readonly maxTurns: number
  private readonly summaryInterval: number
  private readonly activeMemoryCapacity: number

  constructor(
    modelName: string,
    apiKey: string,
    dbPath: string,
    maxTurns: number,
    summaryInterval: number,
    activeMemoryCapacity: number,
    proxy?: string
  ) {
    this.maxTurns = maxTurns
    this.summaryInterval = summaryInterval
    this.activeMemoryCapacity = activeMemoryCapacity
    this.db = new MemoryDatabase(dbPath)
    this.slidingWindow = new SlidingWindowMemory(maxTurns)
    this.summarizer = new MemorySummarizer(apiKey, this.db, modelName, proxy)
  }

  /**
   * 旁听记录（白名单群被动潜水）：
   * 仅滑入短期记忆滑窗和数据库，供随时艾特锐评使用；
   * 绝对不增加总结计数、不触发任何大模型任务，0 Token 消耗。
   */
  public recordPassiveMessage(
    scopeKey: string,
    userId: string,
    content: string,
    senderName = '',
    messageId = ''
  ): void {
    if (!content.trim()) return
    this.slidingWindow.addMessage(scopeKey, 'user', content.trim(), userId, senderName)
    this.db.saveRecentMessage(scopeKey, 'user', content.trim(), userId, senderName, messageId)
  }

  /**
   * 真实交互记录（机器人实际发出了回复）：
   * 1. 滑入短期记忆滑窗与 DB；
   * 2. 存入活跃会话事件待总结缓冲 activeChatBuffer；
   * 3. 若发言者为主人且消息有效，存入主人专属画像缓冲 masterSpeechBuffer；
   * 4. 满 summaryInterval 轮次分别独立触发事件归档与主人画像提炼。
   */
  public recordTurn(
    scopeKey: string,
    userId: string,
    userMsg: string,
    modelMsg: string,
    senderName = '',
    isOwner = false,
    messageId = ''
  ): void {
    this.slidingWindow.addMessage(scopeKey, 'user', userMsg, userId, senderName)
    this.slidingWindow.addMessage(scopeKey, 'model', modelMsg)

    this.db.saveRecentMessage(scopeKey, 'user', userMsg, userId, senderName, messageId)
    this.db.saveRecentMessage(scopeKey, 'model', modelMsg)

    // 1. 维护会话事件缓冲区
    const chatList = this.activeChatBuffer.get(scopeKey) ?? []
    if (!this.activeChatBuffer.has(scopeKey)) this.activeChatBuffer.set(scopeKey, chatList)
    const now = Date.now()
    chatList.push({ role: 'user', content: `${senderName ? `[${senderName}] ` : ''}${userMsg}`, timestamp: now })
    chatList.push({ role: 'model', content: modelMsg, timestamp: now })

    const chatCount = (this.uncommittedChatCount.get(scopeKey) ?? 0) + 1
    this.uncommittedChatCount.set(scopeKey, chatCount)

    if (
      (chatCount >= this.summaryInterval || chatList.reduce((sum, item) => sum + item.content.length, 0) >= 1500) &&
      this.summarizer
    ) {
      this.uncommittedChatCount.set(scopeKey, 0)
      const bufferToCompact = [...chatList]
      chatList.length = 0
      this.summarizer
        .compactChatHistory(scopeKey, bufferToCompact, bufferToCompact[0]?.timestamp ?? now, now)
        .catch(() => {})
    }

    if (isOwner && this.summarizer) {
      if (userMsg.trim().length >= 3 && !/^(\[图片[^\]]*\]|\[表情[^\]]*\]|[0-9]+)$/.test(userMsg.trim()))
        this.masterSpeechBuffer.push(userMsg.trim())

      if (this.masterSpeechBuffer.length >= this.summaryInterval) {
        const speechToExtract = [...this.masterSpeechBuffer]
        this.masterSpeechBuffer.length = 0
        this.summarizer.extractUserProfile('__master__', speechToExtract, scopeKey).catch(() => {})
      }
    }
  }

  public async triggerDream(ownerId: string): Promise<string | null> {
    const spoken = this.summarizer ? await this.summarizer.dreamReflection(ownerId) : null
    if (spoken) this.pendingDreamSpoken = spoken
    return spoken
  }

  public consumePendingDream(): string | null {
    const dream = this.pendingDreamSpoken
    this.pendingDreamSpoken = null
    return dream
  }

  public async tickHeartbeat(ownerId?: string): Promise<void> {
    if (!this.summarizer) return
    const now = Date.now()

    for (const [scopeKey, chatList] of this.activeChatBuffer.entries()) {
      if (chatList.length === 0) continue
      if (now - (chatList[chatList.length - 1]?.timestamp ?? 0) >= 300_000) {
        this.uncommittedChatCount.set(scopeKey, 0)
        const bufferToCompact = [...chatList]
        chatList.length = 0
        await this.summarizer
          .compactChatHistory(scopeKey, bufferToCompact, bufferToCompact[0]?.timestamp ?? now, now)
          .catch(() => {})
      }
    }

    if (this.masterSpeechBuffer.length > 0) {
      const speechToExtract = [...this.masterSpeechBuffer]
      this.masterSpeechBuffer.length = 0
      await this.summarizer.extractUserProfile('__master__', speechToExtract).catch(() => {})
    }

    const hour = new Date(now).getHours()
    if (ownerId && hour >= 2 && hour < 5 && Math.random() < 0.3) await this.triggerDream(ownerId).catch(() => {})
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
      return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
    }

    return this.slidingWindow.getContext(scopeKey).map((m) => {
      const timeTag = `[${formatTime(m.timestamp)}]`
      if (m.role === 'model') return { role: 'model', content: `${timeTag} ${m.content}` }
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
    const { profileBlock } = formatAndTruncateMemory(
      [],
      userId ? this.db.getProfileFactRecords(userId, this.activeMemoryCapacity) : []
    )
    return [profileBlock].filter(Boolean)
  }
}
