export function splitSentences(text: string, minLength = 6, maxLength = 35): string[] {
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
 * 拟真活人打字延迟计算：
 * 1. 收到消息后需要“看懂 + 思考”时间（800ms ~ 1600ms）；
 * 2. 敲击键盘需要真实打字时间（每字 70ms ~ 110ms），模拟人类真实输入手速；
 * 3. 发送前后带有呼吸微停顿。
 */
export function calculateTypingDelay(sentence: string, isFirstSentence = false): number {
  if (isFirstSentence) {
    // 首句起手阅读与组织语言耗时 (800ms ~ 1500ms) + 首句极少数字敲击
    const thinkTime = 800 + Math.random() * 700
    const typeTime = Math.min(1000, sentence.length * (60 + Math.random() * 30))
    return Math.floor(thinkTime + typeTime)
  }
  // 后续句子连发：真实打字手速（每字 70~100ms）+ 句子间呼吸停顿 (300ms ~ 600ms)
  const typeTime = sentence.length * (70 + Math.random() * 30)
  const breatheTime = 300 + Math.random() * 300
  return Math.min(2800, Math.max(600, Math.floor(typeTime + breatheTime)))
}
