import type { Logger } from 'kotori-bot'
import type { GeminiClient } from '../core/gemini'
import { formatAndTruncateMemory } from './context'
import { parseScopeKey } from './scope'
import { SlidingWindowMemory } from './sliding-window'
import { MemoryDatabase } from './store'
import { type DreamReflectionResult, MemorySummarizer, type SummarizerConfig } from './summarizer'

export * from './scope'
export * from './sliding-window'
export * from './store'

export class HierarchicalMemoryService {
  private readonly db: MemoryDatabase
  private readonly slidingWindow: SlidingWindowMemory
  private readonly summarizer: MemorySummarizer | null = null
  private readonly logger?: Logger
  private readonly uncommittedChatCount: Map<string, number> = new Map()
  private readonly activeChatBuffer: Map<string, { role: 'user' | 'model'; content: string; timestamp: number }[]> =
    new Map()
  private readonly masterSpeechBuffer: string[] = []
  private pendingDreamSpoken: string | null = null
  private readonly maxTurns: number
  private readonly summaryInterval: number
  private readonly summaryCharLimit: number
  private readonly activeMemoryCapacity: number
  private readonly idleCompactTimeout: number
  private readonly enableDreamReflection: boolean

  constructor(
    geminiClient: GeminiClient,
    dbPath: string,
    maxTurns: number,
    summaryInterval: number,
    summaryCharLimit: number,
    activeMemoryCapacity: number,
    summarizerConfig: SummarizerConfig,
    idleCompactTimeout: number,
    enableDreamReflection: boolean,
    logger?: Logger
  ) {
    this.maxTurns = maxTurns
    this.summaryInterval = summaryInterval
    this.summaryCharLimit = summaryCharLimit
    this.activeMemoryCapacity = activeMemoryCapacity
    this.idleCompactTimeout = idleCompactTimeout
    this.enableDreamReflection = enableDreamReflection
    this.db = new MemoryDatabase(dbPath)
    this.slidingWindow = new SlidingWindowMemory(maxTurns)
    this.logger = logger?.label('HierarchicalMemory')
    this.summarizer = new MemorySummarizer(geminiClient, this.db, summarizerConfig, logger)
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
    senderName?: string,
    messageId?: string
  ): void {
    if (!content.trim()) return
    this.slidingWindow.addMessage(scopeKey, 'user', content.trim(), userId, senderName, messageId)
    this.db.saveRecentMessage(scopeKey, 'user', content.trim(), userId, senderName)
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
    senderName?: string,
    isMaster?: boolean,
    messageId?: string
  ): void {
    this.slidingWindow.addMessage(scopeKey, 'user', userMsg, userId, senderName, messageId)
    this.slidingWindow.addMessage(scopeKey, 'model', modelMsg)

    this.db.saveRecentMessage(scopeKey, 'user', userMsg, userId, senderName)
    this.db.saveRecentMessage(scopeKey, 'model', modelMsg)

    // 1. 维护会话事件缓冲区
    const chatList = this.activeChatBuffer.get(scopeKey) ?? []
    if (!this.activeChatBuffer.has(scopeKey)) this.activeChatBuffer.set(scopeKey, chatList)
    const now = Date.now()
    chatList.push({ role: 'user', content: `${senderName ? `[${senderName}] ` : ''}${userMsg}`, timestamp: now })
    chatList.push({ role: 'model', content: modelMsg, timestamp: now })

    const chatCount = (this.uncommittedChatCount.get(scopeKey) ?? 0) + 1
    this.uncommittedChatCount.set(scopeKey, chatCount)

    // 普通好友私聊不建立长期事件节点（memory_nodes），仅群聊与主人会话执行宏观事件提炼
    const isFriendPrivate = !isMaster && parseScopeKey(scopeKey).type === 'private'

    if (
      !isFriendPrivate &&
      (chatCount >= this.summaryInterval ||
        chatList.reduce((sum, item) => sum + item.content.length, 0) >= this.summaryCharLimit) &&
      this.summarizer
    ) {
      this.uncommittedChatCount.set(scopeKey, 0)
      const bufferToCompact = [...chatList]
      chatList.length = 0
      this.logger?.info(
        `Compacting active chat history for <blue>${scopeKey}</blue> (${bufferToCompact.length} messages)`
      )
      this.summarizer
        .compactChatHistory(scopeKey, bufferToCompact, bufferToCompact[0]?.timestamp ?? now, now)
        .catch((err) => {
          this.logger?.error(
            `Failed to compact chat history for ${scopeKey}: ${err instanceof Error ? err.message : String(err)}`
          )
        })
    }

    if (isMaster && this.summarizer) {
      if (userMsg.trim().length >= 3 && !/^(\[图片[^\]]*\]|\[表情[^\]]*\]|[0-9]+)$/.test(userMsg.trim()))
        this.masterSpeechBuffer.push(userMsg.trim())

      if (this.masterSpeechBuffer.length >= this.summaryInterval) {
        const speechToExtract = [...this.masterSpeechBuffer]
        this.masterSpeechBuffer.length = 0
        this.logger?.info(`Extracting master profile facts (${speechToExtract.length} messages)`)
        this.summarizer.extractUserProfile('__master__', speechToExtract, scopeKey).catch((err) => {
          this.logger?.error(`Failed to extract master profile: ${err instanceof Error ? err.message : String(err)}`)
        })
      }
    }
  }

  public findQuotedMessage(
    scopeKey: string,
    messageId: string
  ): { role: string; content: string; senderName: string; userId: string } | null {
    return this.slidingWindow.findMessageByMessageId(scopeKey, messageId)
  }

  public async triggerDream(masterId: string): Promise<DreamReflectionResult | null> {
    const res = this.summarizer ? await this.summarizer.dreamReflection(masterId) : null
    if (res?.spoken) this.pendingDreamSpoken = res.spoken
    return res
  }

  public consumePendingDream(): string | null {
    const dream = this.pendingDreamSpoken
    this.pendingDreamSpoken = null
    return dream
  }

  public async tickHeartbeat(masterId?: string): Promise<void> {
    if (!this.summarizer) return
    const now = Date.now()

    for (const [scopeKey, chatList] of this.activeChatBuffer.entries()) {
      if (chatList.length === 0) continue
      // 好友私聊不进行空闲归档
      if (parseScopeKey(scopeKey).type === 'private' && !scopeKey.includes(':private:master')) continue

      if (now - (chatList[chatList.length - 1]?.timestamp ?? 0) >= this.idleCompactTimeout * 1000) {
        this.uncommittedChatCount.set(scopeKey, 0)
        const bufferToCompact = [...chatList]
        chatList.length = 0
        this.logger?.info(`Idle timeout reached, compacting chat history for <blue>${scopeKey}</blue>`)
        await this.summarizer
          .compactChatHistory(scopeKey, bufferToCompact, bufferToCompact[0]?.timestamp ?? now, now)
          .catch((err) => {
            this.logger?.error(
              `Failed to idle-compact chat for ${scopeKey}: ${err instanceof Error ? err.message : String(err)}`
            )
          })
      }
    }

    if (this.masterSpeechBuffer.length > 0) {
      const speechToExtract = [...this.masterSpeechBuffer]
      this.masterSpeechBuffer.length = 0
      this.logger?.info(`Heartbeat flushing master speech buffer (${speechToExtract.length} messages)`)
      await this.summarizer.extractUserProfile('__master__', speechToExtract).catch((err) => {
        this.logger?.error(`Failed to flush master profile: ${err instanceof Error ? err.message : String(err)}`)
      })
    }

    const hour = new Date(now).getHours()
    if (this.enableDreamReflection && hour >= 2 && hour < 5 && Math.random() < 0.3)
      await this.triggerDream(masterId || '__master__').catch((err) => {
        this.logger?.error(`Failed to trigger dream reflection: ${err instanceof Error ? err.message : String(err)}`)
      })
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
          ? `${masterId && String(m.userId) === String(masterId) ? `[MASTER: ${m.senderName || 'Master'}] [UID: ${m.userId}]` : `[MEMBER: ${m.senderName || 'User'}] [UID: ${m.userId}]`}`
          : ''
      return {
        role: 'user',
        content: userPrefix ? `${timeTag} ${userPrefix} ${m.content}` : `${timeTag} ${m.content}`
      }
    })
  }

  public assemblePromptContext(_scopeKey: string, userId?: string, visibilityFilter?: 'public' | 'private'): string[] {
    const { profileBlock } = formatAndTruncateMemory(
      [],
      userId ? this.db.getProfileFactRecords(userId, this.activeMemoryCapacity, visibilityFilter) : []
    )
    return [profileBlock].filter(Boolean)
  }

  /**
   * 熔断自愈：从短期滑窗和持久化最近消息表中剔除最近一条可疑的用户入站消息，解除 PROHIBITED_CONTENT 死锁
   */
  public purgeSuspiciousUserMessage(scopeKey: string): void {
    this.slidingWindow.removeLastUserMessage(scopeKey)
    this.db.removeLastUserMessage(scopeKey)
  }
}
