/**
 * 多话自然分割（对齐 reference/src/utils.ts 实现）：
 * - 如果文本总长度达到 threshold（默认 80），或包含列表/代码结构，则整体发送，避免技术或深度回复被切割得稀碎；
 * - 普通短句聊天按标点符号（。！？!?…）分段并智能合并短句，确保自然呼吸感与分句体验。
 */
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

/**
 * 随机末尾半括号修饰器：
 * 在日常短句回复后随机添加末尾括号（如 "好呀（", "笑死（（", "行吧）"），模拟真实网民心理语气。
 * 技术场景（包含代码、Markdown 列表）或已有结尾标点时自动规避。
 */
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
  return isFirstSentence ? Math.floor(150 + Math.random() * 200) : Math.floor(300 + Math.min(600, sentence.length * 15))
}

/**
 * 清除模型偶发复读的时间戳或身份标签前缀（如 `[10/28 00:44]`、`[10/28 00:44`、`[MEMBER: xxx]` 等）
 */
export function stripLeadingTimestamps(text: string): string {
  return text
    .replace(/^\s*\[\d{1,2}\/\d{1,2}(?:\s+\d{1,2}:\d{1,2})?\]?\s*/g, '')
    .replace(/^\s*\[(?:MASTER|MEMBER|GUEST|BOT|USER|AI)[^\]]*\]:?\s*/gi, '')
    .trim()
}
