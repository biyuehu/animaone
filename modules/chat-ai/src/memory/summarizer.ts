import { GoogleGenAI } from '@google/genai'
import { ProxyAgent, fetch as undiciFetch } from 'undici'
import type { MemoryDatabase } from './store'

type FactCategory = 'preference' | 'identity' | 'event' | 'relation'

export class MemorySummarizer {
  private readonly ai: GoogleGenAI
  private readonly modelName: string

  constructor(
    apiKey: string,
    private readonly db: MemoryDatabase,
    modelName: string,
    proxy?: string
  ) {
    this.modelName = modelName
    let fetchFn: typeof fetch | undefined
    if (proxy) {
      const proxyUrl = proxy.startsWith('http') ? proxy : `http://${proxy}`
      const agent = new ProxyAgent(proxyUrl)
      // biome-ignore lint/suspicious/noExplicitAny: fetch override requires matching interface
      fetchFn = ((url: any, init: any) => undiciFetch(url, { ...init, dispatcher: agent })) as any
    }

    this.ai = new GoogleGenAI({
      apiKey,
      ...(fetchFn ? { httpOptions: { fetch: fetchFn } } : {})
    })
  }

  public async compactChatHistory(
    scopeKey: string,
    dialogues: { role: string; content: string }[],
    startTime: number,
    endTime: number
  ): Promise<void> {
    if (dialogues.length === 0) return
    const prompt = `你是一个长期记忆与知识图谱提取专家。请阅读以下这段最近发生的聊天记录：
1. 提炼出 1~3 句核心要点（客观精炼陈述关键事件、讨论的技术或具体喜好，100字以内）。
2. 提取出 2~4 个最核心的概念线索词/实体标签（用于人脑般的发散联想，例如：电视,遥控器,螺丝,TypeScript）。
输出格式严格为：
[SUMMARY] 摘要内容
[TAGS] 标签1, 标签2, 标签3

聊天记录：
${dialogues.map((d) => `${d.role}: ${d.content}`).join('\n')}`

    try {
      const response = await this.ai.models.generateContent({
        model: this.modelName,
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        config: { temperature: 0.3 }
      })
      const text = response.text?.trim() ?? ''
      const summaryMatch = text.match(/\[SUMMARY\]\s*(.*)/)
      const tagsMatch = text.match(/\[TAGS\]\s*(.*)/)

      if (summaryMatch)
        this.db.addNode({
          level: 'day',
          scopeKey,
          summary: summaryMatch[1].trim(),
          tags: tagsMatch ? tagsMatch[1].trim() : '',
          startTime,
          endTime,
          createdAt: Date.now()
        })
    } catch (err) {
      console.error('[MemorySummarizer] Compaction failed:', err instanceof Error ? err.message : err)
    }
  }

  // 仿生做梦/闲暇灵感推演（从随机两条旧记忆碰撞出新顿悟）
  public async dreamReflection(ownerId: string): Promise<string | null> {
    const nodes = this.db.getRandomNodesForReflection(2)
    if (nodes.length < 2) return null

    const prompt = `你是一名傲娇但极其聪明的毒舌小女孩（露米）。你在夜深人静发呆做梦时，回顾了过往经历的两件事：
记忆A: [${nodes[0].summary}] (线索: ${nodes[0].tags})
记忆B: [${nodes[1].summary}] (线索: ${nodes[1].tags})

请发挥你的主动联想能力，顺藤摸瓜寻找这两件事之间的隐秘联系或潜在灵感：
1. 如果两件事有关联，请提炼出一个新的顿悟或关于笨蛋大哥哥的深层认知（1句，存入长期事实）。
2. 并以傲娇得意的口吻，写一句未来找大哥哥聊天时随口吐槽他的话（格式: [SPOKEN] 吐槽台词）。`

    try {
      const response = await this.ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        config: { temperature: 0.7 }
      })
      const text = response.text?.trim() ?? ''
      const spokenMatch = text.match(/\[SPOKEN\]\s*(.*)/)

      // 将做梦顿悟建立跨记忆关联
      if (nodes[0].id && nodes[1].id) this.db.linkNodes(nodes[0].id, nodes[1].id, 'dream_association')

      // 沉淀新灵感事实
      this.db.upsertFact(ownerId, `[做梦灵感] ${text.replace(/\[SPOKEN\].*/, '').trim()}`, 'event')
      return spokenMatch ? spokenMatch[1].trim() : null
    } catch (err) {
      console.error('[MemorySummarizer] Dream reflection failed:', err instanceof Error ? err.message : err)
      return null
    }
  }

  public async extractUserProfile(userId: string, recentMessages: string[], sourceScope = ''): Promise<void> {
    if (recentMessages.length < 2) return
    const prompt = `请分析以下用户的发言，提取出 1~2 条关于该用户的长期硬性事实（如：使用什么操作系统、偏好什么编程语言、作息习惯等）。
每行输出一条事实，格式为：[类别][公开性] 事实描述（类别可选：identity, preference, event；公开性可选：public, private。涉及现实隐私或住址选 private，普通技术偏好或人设选 public）。如果没有值得记录的长期事实，请直接输出 NONE。

用户发言：
${recentMessages.join('\n')}`

    try {
      const response = await this.ai.models.generateContent({
        model: this.modelName,
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        config: { temperature: 0.2 }
      })

      const lines = response.text?.split('\n') ?? []
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.includes('NONE')) continue
        const match = trimmed.match(/\[(.*?)\](?:\[(.*?)\])?\s*(.*)/)
        if (!match) continue

        const category: FactCategory = (match[1]?.toLowerCase() as FactCategory) || 'preference'
        const visibility = match[2]?.toLowerCase() === 'public' ? 'public' : 'private'
        const fact = (match[3] || '').trim()
        if (fact)
          this.db.upsertFact(userId, fact, category, visibility, sourceScope, recentMessages[0]?.slice(0, 50) ?? '')
      }
    } catch (err) {
      console.error('[MemorySummarizer] Profile extraction failed:', err instanceof Error ? err.message : err)
    }
  }
}
