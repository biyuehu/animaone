import { GoogleGenAI } from '@google/genai'
import type { MemoryDatabase } from './store'

type FactCategory = 'preference' | 'identity' | 'event' | 'relation'

export class MemorySummarizer {
  private readonly ai: GoogleGenAI

  constructor(
    apiKey: string,
    private readonly db: MemoryDatabase
  ) {
    this.ai = new GoogleGenAI({ apiKey })
  }

  public async compactChatHistory(
    scopeKey: string,
    dialogues: { role: string; content: string }[],
    startTime: number,
    endTime: number
  ): Promise<void> {
    if (dialogues.length === 0) return
    const prompt = `你是一个长期记忆提取专家。请阅读以下这段最近发生的聊天记录，提炼出 1~3 句核心要点：
1. 涉及的关键事件、讨论的技术或话题
2. 用户表现出的具体喜好、需求或性格特征
要求用客观、精炼的中文陈述事实，不要废话，字数在 120 字以内。

聊天记录：
${dialogues.map((d) => `${d.role}: ${d.content}`).join('\n')}`

    try {
      const response = await this.ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        config: { temperature: 0.3 }
      })
      const summary = response.text?.trim()
      if (summary) {
        this.db.addNode({
          level: 'day',
          scopeKey,
          summary,
          startTime,
          endTime,
          createdAt: Date.now()
        })
      }
    } catch (err) {
      console.error('[MemorySummarizer] Compaction failed:', err instanceof Error ? err.message : err)
    }
  }

  public async extractUserProfile(userId: string, recentMessages: string[]): Promise<void> {
    if (recentMessages.length < 3) return
    const prompt = `请分析以下用户的发言，提取出 1~2 条关于该用户的长期硬性事实（如：使用什么操作系统、偏好什么编程语言、作息习惯等）。
每行输出一条事实，格式为：[类别] 事实描述（类别可选：identity, preference, event）。如果没有值得记录的长期事实，请直接输出 NONE。

用户发言：
${recentMessages.join('\n')}`

    try {
      const response = await this.ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        config: { temperature: 0.2 }
      })

      const lines = response.text?.split('\n') ?? []
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.includes('NONE')) continue
        const match = trimmed.match(/\[(.*?)\]\s*(.*)/)
        if (match) {
          const category: FactCategory = match[1].toLowerCase() as FactCategory
          this.db.upsertFact(userId, match[2], category)
        }
      }
    } catch (err) {
      console.error('[MemorySummarizer] Profile extraction failed:', err instanceof Error ? err.message : err)
    }
  }
}
