export function splitSentences(text: string, threshold: number, minLength = 12, maxLength = 35): string[] {
  if (threshold > 0 && text.trim().length >= threshold) return [text.replaceAll(/\n\n/g, '\n').trim()]
  if (text.includes('```') || text.includes('{\n') || text.includes('[\n') || /(?:^|\n)\s*(?:\d+\.|-|\*)\s+/.test(text))
    return [text.trim()]

  const cleaned = text
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if (!cleaned) return []

  const rawSegments = cleaned.split(/([。！？!?…\n]+)/g)
  const initialSentences: string[] = []
  for (let i = 0; i < rawSegments.length; i += 2) {
    const s = rawSegments[i]?.trim() ?? ''
    const p = rawSegments[i + 1]?.trim() ?? ''
    if (s) initialSentences.push(s + p)
  }

  if (initialSentences.length === 0) return [cleaned]

  const finalSentences: string[] = []
  let currentSentence = ''

  for (const sentence of initialSentences) {
    const potentialLength = currentSentence.length + sentence.length
    if (sentence.length > maxLength) {
      if (currentSentence) finalSentences.push(currentSentence)
      finalSentences.push(sentence)
      currentSentence = ''
      continue
    }

    if (potentialLength <= maxLength) {
      currentSentence += sentence
      if (currentSentence.length >= minLength && potentialLength >= maxLength * 0.8) {
        finalSentences.push(currentSentence)
        currentSentence = ''
      }
    } else {
      if (currentSentence) finalSentences.push(currentSentence)
      currentSentence = sentence
    }
  }

  if (currentSentence) finalSentences.push(currentSentence)

  return finalSentences.reduce((result, sentence) => {
    if (sentence.length < minLength && result.length > 0) result[result.length - 1] += sentence
    else result.push(sentence)
    return result
  }, [] as string[])
}

export function applyTrailingBracket(text: string, rate: number, variants: string[]): string {
  if (
    rate <= 0 ||
    variants.length === 0 ||
    text.includes('```') ||
    /(?:^|\n)\s*(?:\d+\.|-|\*)\s+/.test(text) ||
    Math.random() >= rate
  )
    return text
  return `${text.trimEnd()}${variants[Math.floor(Math.random() * variants.length)]}`
}

export function calculateTypingDelay(sentence: string, isFirstSentence = false): number {
  if (isFirstSentence) {
    return Math.floor(250 + Math.random() * 300)
  }
  const baseJitter = 800 + Math.floor(Math.random() * 400)
  const typingCost = Math.min(1000, sentence.trim().length * 35)
  return baseJitter + typingCost
}

export function stripLeadingTimestamps(text: string): string {
  return text
    .replace(/^\s*\[\d{1,2}\/\d{1,2}(?:\s+\d{1,2}:\d{1,2})?\]?\s*/g, '')
    .replace(/^\s*\[(?:MASTER|MEMBER|GUEST|BOT|USER|AI)[^\]]*\]:?\s*/gi, '')
    .trim()
}
