export type ChatMessage =
  | {
      readonly role: 'model'
      readonly content: string
      readonly timestamp: number
    }
  | {
      readonly role: 'user'
      readonly content: string
      readonly timestamp: number
      readonly userId: string
      readonly senderName: string
    }

export const modelMessage = (content: string, timestamp = Date.now()): ChatMessage => ({
  role: 'model',
  content,
  timestamp
})

export const userMessage = (content: string, userId = '', senderName = '', timestamp = Date.now()): ChatMessage => ({
  role: 'user',
  content,
  userId,
  senderName,
  timestamp
})

export class SlidingWindowMemory {
  private readonly history: Map<string, ChatMessage[]> = new Map()

  constructor(private readonly maxTurns: number) {}

  public addMessage(scopeKey: string, role: 'user' | 'model', content: string, userId = '', senderName = ''): void {
    if (!content.trim()) return

    const list = this.history.get(scopeKey) ?? []
    if (!this.history.has(scopeKey)) this.history.set(scopeKey, list)

    list.push(role === 'model' ? modelMessage(content.trim()) : userMessage(content.trim(), userId, senderName))
    if (list.length > this.maxTurns) list.splice(0, list.length - this.maxTurns)
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
}
