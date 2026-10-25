export function splitSentences(text: string, minLength = 8, maxLength = 45): string[] {
  // 保持代码块等特殊结构完整，不打碎代码
  if (text.includes('```')) return [text.trim()]

  // 匹配常见中文标点、英文标点及换行
  const rawSegments = text.split(/([。！？!?…~\n]+)/g)
  const initialSentences: string[] = []

  for (let i = 0; i < rawSegments.length; i += 2) {
    const segment = rawSegments[i]?.trim() ?? ''
    const punctuation = rawSegments[i + 1]?.trim() ?? ''
    if (segment) initialSentences.push(`${segment}${punctuation}`)
  }

  const finalSentences: string[] = []
  let current = ''

  for (const sentence of initialSentences) {
    if (sentence.length > maxLength) {
      if (current) finalSentences.push(current)
      finalSentences.push(sentence)
      current = ''
      continue
    }

    if (current.length + sentence.length <= maxLength) {
      current += sentence
      if (current.length >= minLength && current.length + sentence.length >= maxLength * 0.7) {
        finalSentences.push(current)
        current = ''
      }
    } else {
      if (current) finalSentences.push(current)
      current = sentence
    }
  }

  if (current) finalSentences.push(current)
  return finalSentences.length > 0 ? finalSentences : [text.trim()]
}

export const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 拟人打字延迟计算
 * @param sentence 本句文本
 * @param isFirstSentence 是否为回复的第一句话
 */
export function calculateTypingDelay(sentence: string, isFirstSentence = false): number {
  if (isFirstSentence) {
    // 模拟真人阅读、思考准备的起手微停顿 (500ms ~ 1100ms)
    return Math.floor(500 + Math.random() * 600)
  }
  // 模拟真实手速敲键盘 (每字 40~65ms) + 标点微停顿，上限 1600ms
  const lengthTime = sentence.length * (40 + Math.random() * 25)
  return Math.min(1600, Math.max(350, Math.floor(lengthTime)))
}
