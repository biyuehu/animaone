export interface ChatMessage {
  role: 'user' | 'model'
  content: string
  timestamp: number
}

export class SlidingWindowMemory {
  private readonly history: Map<string, ChatMessage[]> = new Map()

  constructor(private readonly maxTurns: number = 20) {}

  addMessage(scopeKey: string, role: 'user' | 'model', content: string): void {
    const cleaned = content.trim()
    if (!cleaned) return

    let list = this.history.get(scopeKey)
    if (!list) {
      list = []
      this.history.set(scopeKey, list)
    }

    list.push({
      role,
      content: cleaned,
      timestamp: Date.now()
    })

    // 维持固定窗口大小
    if (list.length > this.maxTurns) {
      list.splice(0, list.length - this.maxTurns)
    }
  }

  getContext(scopeKey: string): ChatMessage[] {
    return this.history.get(scopeKey) || []
  }

  clear(scopeKey: string): void {
    this.history.delete(scopeKey)
  }
}
