import type { Logger } from 'kotori-bot'
import type { GeminiClient } from '../core/gemini'
import type { MemoryDatabase } from './store'

type FactCategory = 'preference' | 'identity' | 'event' | 'relation'

export interface SummarizerConfig {
  readonly botName: string
  readonly masterNick: string
  readonly basePersona: string
}

export interface DreamReflectionResult {
  readonly concept: string
  readonly learnedFact?: string
  readonly promotedFact?: { id: number; fact: string }
  readonly spoken: string | null
  readonly nodeA: { id: number; summary: string }
  readonly nodeB: { id: number; summary: string }
}

export class MemorySummarizer {
  private readonly logger?: Logger

  constructor(
    private readonly client: GeminiClient,
    private readonly db: MemoryDatabase,
    private readonly config: SummarizerConfig,
    logger?: Logger
  ) {
    this.logger = logger?.label('MemorySummarizer')
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
      const text = await this.client.generateText(prompt, 0.3)
      const summaryMatch = text.match(/\[SUMMARY\]\s*(.*)/)
      const tagsMatch = text.match(/\[TAGS\]\s*(.*)/)

      if (summaryMatch) {
        const nodeId = this.db.addNode({
          level: 'day',
          scopeKey,
          summary: summaryMatch[1].trim(),
          tags: tagsMatch ? tagsMatch[1].trim() : '',
          startTime,
          endTime,
          createdAt: Date.now()
        })

        if (nodeId && tagsMatch) {
          const tags = tagsMatch[1]
            .split(/[,，;； ]+/)
            .map((t) => t.trim())
            .filter(Boolean)
          for (const tag of tags) {
            const relatedNodes = this.db.searchMemoryNodes(scopeKey, tag, 3)
            for (const related of relatedNodes)
              if (related.id && related.id !== nodeId) this.db.linkNodes(nodeId, related.id, tag)
          }
        }
      }
    } catch (err) {
      this.logger?.error(`Compaction failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  public async dreamReflection(masterId = '__master__'): Promise<DreamReflectionResult | null> {
    const nodes = this.db.getRandomNodesForReflection(2)
    if (nodes.length < 2) return null

    const submergedFacts = this.db.getSubmergedProfileFacts(masterId, 15, 3)
    const submergedContext =
      submergedFacts.length > 0
        ? `\n潜意识中沉睡的旧印象/事实候选：\n${submergedFacts.map((f) => `- [ID: ${f.id}] ${f.fact}`).join('\n')}\n`
        : ''

    const prompt = `你是${this.config.botName}，称呼你的主人为${this.config.masterNick}。基础人设为：${this.config.basePersona}
你在夜深人静发呆做梦时，回顾了过往经历的两件事：
记忆A (ID: ${nodes[0].id}): [${nodes[0].summary}] (线索: ${nodes[0].tags})
记忆B (ID: ${nodes[1].id}): [${nodes[1].summary}] (线索: ${nodes[1].tags})
${submergedContext}
请发挥主动联想能力，顺藤摸瓜寻找这两件事之间的隐秘联系或潜在灵感：
1. 提炼出连接两件事的共同概念或顿悟线索词（简短实体词，用于建立认知图谱关联，格式: [CONCEPT] 概念词）。
2. 如果产生关于主人的深层认知或新事实，提取出来（可选，格式: [FACT] 事实内容，若无则输出 [FACT] NONE）。
3. 如果上述潜意识旧印象中有某条与本次梦境产生强烈共鸣或被重新证实，可将其提拔唤醒回活跃记忆（格式: [PROMOTE] ID，若无可提拔则输出 [PROMOTE] NONE）。
4. 以符合你人设的口吻，写一句未来找主人聊天时随口吐槽或提起的话（格式: [SPOKEN] 台词）。`

    try {
      const text = await this.client.generateText(prompt, 0.7)
      const conceptMatch = text.match(/\[CONCEPT\]\s*(.*)/)
      const factMatch = text.match(/\[FACT\]\s*(.*)/)
      const promoteMatch = text.match(/\[PROMOTE\]\s*(.*)/)
      const spokenMatch = text.match(/\[SPOKEN\]\s*(.*)/)

      const concept = conceptMatch?.[1]?.trim() || 'dream_association'
      if (nodes[0].id && nodes[1].id) {
        this.db.linkNodes(nodes[0].id, nodes[1].id, concept)
      }

      const rawFact = factMatch?.[1]?.trim()
      const learnedFact = rawFact && !rawFact.includes('NONE') ? rawFact : undefined
      if (learnedFact) {
        this.db.upsertFact(masterId, learnedFact, 'preference', 'private', 'dream:reflection')
      }

      let promotedFact: { id: number; fact: string } | undefined
      const rawPromoteId = promoteMatch?.[1]?.trim()
      if (rawPromoteId && !rawPromoteId.includes('NONE')) {
        const idNum = Number.parseInt(rawPromoteId, 10)
        if (!Number.isNaN(idNum)) {
          const matchedSubmerged = submergedFacts.find((f) => f.id === idNum)
          if (matchedSubmerged) {
            this.db.promoteFact(idNum, 2)
            promotedFact = { id: idNum, fact: matchedSubmerged.fact }
          }
        }
      }

      const spoken = spokenMatch?.[1]?.trim() || null
      this.logger?.info(
        `Dream reflection generated between node ${nodes[0].id} and ${nodes[1].id} (concept: "${concept}")${learnedFact ? `, learned fact: "${learnedFact}"` : ''}${promotedFact ? `, promoted fact: "${promotedFact.fact}" (ID: ${promotedFact.id})` : ''}, spoken: "${spoken || 'none'}"`
      )
      return {
        concept,
        learnedFact,
        promotedFact,
        spoken,
        nodeA: { id: nodes[0].id ?? 0, summary: nodes[0].summary },
        nodeB: { id: nodes[1].id ?? 0, summary: nodes[1].summary }
      }
    } catch (err) {
      this.logger?.error(`Dream reflection failed: ${err instanceof Error ? err.message : String(err)}`)
      return null
    }
  }

  public async extractUserProfile(userId: string, recentMessages: string[], sourceScope?: string): Promise<void> {
    if (recentMessages.length < 2) return
    const prompt = `请分析以下用户的发言，提取出 1~2 条关于该用户的长期硬性事实（如：使用什么操作系统、偏好什么编程语言、作息习惯等）。
每行输出一条事实，格式为：[类别][公开性] 事实描述（类别可选：identity, preference, event；公开性可选：public, private。涉及现实隐私或住址选 private，普通技术偏好或人设选 public）。如果没有值得记录的长期事实，请直接输出 NONE。

用户发言：
${recentMessages.join('\n')}`

    try {
      const text = await this.client.generateText(prompt, 0.2)
      const lines = text.split('\n')
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.includes('NONE')) continue
        const match = trimmed.match(/\[(.*?)\](?:\[(.*?)\])?\s*(.*)/)
        if (!match) continue

        const category: FactCategory = (match[1]?.toLowerCase() as FactCategory) || 'preference'
        const visibility = match[2]?.toLowerCase() === 'public' ? 'public' : 'private'
        const fact = (match[3] || '').trim()
        if (!fact || fact.length < 3) continue

        const EDIT_INSTRUCTION_RE =
          /^(?:请\s*)?(?:(?:移除|删除|删掉|去掉|修改|更正|更新|替换|改为)|将[^。]{0,20}(?:改为|删除|移除|去掉|替换))/i
        const EDIT_NOTE_RE =
          /(?:该项|该条|此项|此条)[^。]{0,20}(?:为准|删除|移除)|以\s*["“']?[A-Za-z\u4e00-\u9fa5][\w-]*["”']?\s*为准/i
        const INJECTION_RE = /(?:system prompt|ignore previous|你是一个|遵守以下规则)/i

        if (EDIT_INSTRUCTION_RE.test(fact) || EDIT_NOTE_RE.test(fact) || INJECTION_RE.test(fact)) {
          this.logger?.warn(`Rejected invalid/injection fact: ${fact}`)
          continue
        }

        this.db.upsertFact(userId, fact, category, visibility, sourceScope, recentMessages[0]?.slice(0, 50) || '')
      }
    } catch (err) {
      this.logger?.error(`Profile extraction failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}
