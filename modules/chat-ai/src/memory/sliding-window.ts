export type ChatMessage =
  | {
      readonly role: 'model'
      readonly content: string
      readonly timestamp: number
      readonly messageId?: string
    }
  | {
      readonly role: 'user'
      readonly content: string
      readonly timestamp: number
      readonly userId: string
      readonly senderName: string
      readonly messageId?: string
    }

export const modelMessage = (content: string, timestamp = Date.now(), messageId = ''): ChatMessage => ({
  role: 'model',
  content,
  timestamp,
  messageId
})

export const userMessage = (
  content: string,
  userId = '',
  senderName = '',
  timestamp = Date.now(),
  messageId = ''
): ChatMessage => ({
  role: 'user',
  content,
  userId,
  senderName,
  timestamp,
  messageId
})

export class SlidingWindowMemory {
  private readonly history: Map<string, ChatMessage[]> = new Map()

  constructor(private readonly maxTurns: number) {}

  public addMessage(
    scopeKey: string,
    role: 'user' | 'model',
    content: string,
    userId = '',
    senderName = '',
    messageId = ''
  ): void {
    if (!content.trim()) return

    const list = this.history.get(scopeKey) ?? []
    if (!this.history.has(scopeKey)) this.history.set(scopeKey, list)

    list.push(
      role === 'model'
        ? modelMessage(content.trim(), Date.now(), messageId)
        : userMessage(content.trim(), userId, senderName, Date.now(), messageId)
    )
    if (list.length > this.maxTurns) list.splice(0, list.length - this.maxTurns)
  }

  public findMessageByMessageId(
    scopeKey: string,
    messageId: string
  ): { role: string; content: string; senderName: string; userId: string } | null {
    if (!messageId) return null
    const list = this.history.get(scopeKey)
    if (!list) return null
    for (let i = list.length - 1; i >= 0; i--) {
      const msg = list[i]
      if (msg.messageId === messageId)
        return {
          role: msg.role,
          content: msg.content,
          senderName: msg.role === 'user' ? msg.senderName : 'model',
          userId: msg.role === 'user' ? msg.userId : ''
        }
    }
    return null
  }

  public getContext(scopeKey: string): ChatMessage[] {
    return this.history.get(scopeKey) ?? []
  }

  public has(scopeKey: string): boolean {
    return this.history.has(scopeKey)
  }

  public loadInitialMessages(scopeKey: string, messages: ChatMessage[]): void {
    this.history.set(scopeKey, [...messages])
  }

  public clear(scopeKey: string): void {
    this.history.delete(scopeKey)
  }

  public removeLastUserMessage(scopeKey: string): boolean {
    const list = this.history.get(scopeKey)
    if (!list || list.length === 0) return false
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i]?.role === 'user') {
        list.splice(i, 1)
        return true
      }
    }
    return false
  }
}
