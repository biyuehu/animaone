export const STOPWORDS = new Set([
  '的',
  '一',
  '是',
  '了',
  '什',
  '么',
  '我',
  '谁',
  '不',
  '人',
  '在',
  '他',
  '有',
  '这',
  '个',
  '上',
  '们',
  '来',
  '到',
  '时',
  '大',
  '地',
  '为',
  '子',
  '中',
  '你',
  '说',
  '生',
  '国',
  '年',
  '着',
  '就',
  '那',
  '和',
  '要',
  '她',
  '出',
  '也',
  '得',
  '里',
  '后',
  '自',
  '以',
  '会',
  '啊',
  '吧',
  '吗',
  '呢',
  '呀',
  '哦',
  '嗯',
  '额',
  '哈',
  '呗',
  '啦',
  '嘛',
  '唉',
  '喂',
  '诶',
  '然后',
  '但是',
  '因为',
  '所以',
  '如果',
  '可以',
  '什么',
  '怎么',
  '这样',
  '那样',
  '还是',
  '就是',
  '只是',
  '已经',
  '一下',
  '一个',
  '没有',
  '知道',
  '觉得',
  '可能',
  '应该',
  '现在',
  '时候',
  '自己',
  '我们',
  '你们',
  '他们',
  '这个',
  '那个',
  '这些',
  '那些',
  '真的',
  '不是',
  '的是',
  '了的',
  '我是',
  '你是',
  '他是',
  '她说',
  'reply',
  'system',
  'user',
  'assistant'
])

export function segment(text: string): string[] {
  if (!text) return []
  const tokens: string[] = []
  const lower = text.toLowerCase()

  for (const match of lower.matchAll(/[a-z0-9_]+/g)) tokens.push(match[0])
  for (const match of lower.matchAll(/[\u4e00-\u9fa5]+/g)) {
    const s = match[0]
    for (let i = 0; i < s.length; i++) {
      if (!STOPWORDS.has(s[i])) tokens.push(s[i])
      if (i + 1 < s.length) tokens.push(s.slice(i, i + 2))
    }
  }
  return tokens
}

export interface RetrievalDocument {
  readonly id: number
  readonly content: string
  readonly timestamp?: number | Date
}

const K1 = 1.5
const B = 0.75
const RECENCY_WEIGHT = 0.25
const BM25_WEIGHT = 0.75
const DEFAULT_HALFLIFE_DAYS = 30
const SINGLE_CHAR_WEIGHT = 0.3

const isSingleChineseChar = (token: string): boolean => token.length === 1 && /[\u4e00-\u9fa5]/.test(token)
const termWeight = (token: string): number => (isSingleChineseChar(token) ? SINGLE_CHAR_WEIGHT : 1)
const isMeaningful = (token: string): boolean => !isSingleChineseChar(token)

export function scoreBM25(query: string, docs: readonly RetrievalDocument[]): Map<number, number> {
  const scores = new Map<number, number>()
  if (!docs.length) return scores

  const queryTerms = [...new Set(segment(query))]
  if (!queryTerms.length) return scores

  const docTokens = docs.map((doc) => segment(doc.content))
  const docLengths = docTokens.map((tokens) => tokens.length)
  const avgLength = docLengths.reduce((sum, len) => sum + len, 0) / docs.length

  const documentFrequency = new Map<string, number>()
  for (const tokens of docTokens) {
    const unique = new Set(tokens)
    for (const term of queryTerms) {
      if (unique.has(term)) documentFrequency.set(term, (documentFrequency.get(term) || 0) + 1)
    }
  }

  const total = docs.length
  const hasMeaningfulTerm = queryTerms.some(isMeaningful)

  docs.forEach((doc, index) => {
    const termFrequency = new Map<string, number>()
    for (const token of docTokens[index]) {
      termFrequency.set(token, (termFrequency.get(token) || 0) + 1)
    }

    let score = 0
    let matchedMeaningful = false
    for (const term of queryTerms) {
      const tf = termFrequency.get(term) || 0
      if (!tf) continue
      if (isMeaningful(term)) matchedMeaningful = true
      const df = documentFrequency.get(term) || 0
      const idf = Math.log(1 + (total - df + 0.5) / (df + 0.5))
      const lengthNorm = avgLength > 0 ? docLengths[index] / avgLength : 0
      score += termWeight(term) * idf * ((tf * (K1 + 1)) / (tf + K1 * (1 - B + B * lengthNorm)))
    }

    if (hasMeaningfulTerm && !matchedMeaningful) return
    if (score > 0) scores.set(doc.id, score)
  })

  return scores
}

export interface RankedDocument<T> {
  readonly doc: T
  readonly score: number
}

const computeRecency = (timestamp: number | Date | undefined, now: number, halflifeDays: number): number => {
  if (!timestamp) return 0.5
  const time = typeof timestamp === 'number' ? timestamp : timestamp.getTime()
  if (!Number.isFinite(time)) return 0.5
  const ageDays = Math.max(0, (now - time) / 86_400_000)
  return 0.5 ** (ageDays / halflifeDays)
}

export function rankDocuments<T extends RetrievalDocument>(
  query: string,
  docs: readonly T[],
  options?: { halflifeDays?: number; now?: number }
): RankedDocument<T>[] {
  if (!docs.length) return []

  const halflife = options?.halflifeDays ?? DEFAULT_HALFLIFE_DAYS
  const now = options?.now ?? Date.now()
  const bm25 = scoreBM25(query, docs)

  let maxScore = 0
  for (const value of bm25.values()) maxScore = Math.max(maxScore, value)
  if (maxScore <= 0) return []

  return docs
    .filter((doc) => bm25.has(doc.id))
    .map((doc) => ({
      doc,
      score:
        BM25_WEIGHT * ((bm25.get(doc.id) || 0) / maxScore) +
        RECENCY_WEIGHT * computeRecency(doc.timestamp, now, halflife)
    }))
    .sort((a, b) => b.score - a.score)
}
