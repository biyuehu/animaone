export function splitSentences(text: string, minLength = 20, maxLength = 80): string[] {
  // 保持代码块等特殊结构完整，不打碎代码
  if (text.includes('```')) return [text.trim()]

  const rawSegments = text.split(/([。！？!?…\n]+)/g)
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
      if (current.length >= minLength && current.length + sentence.length >= maxLength * 0.8) {
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
