/**
 * 多话自然分割（对齐 reference/src/utils.ts 实现）：
 * - 如果包含大段代码块或多行代码结构，保持整体发送，绝不切断代码；
 * - 普通聊天按标点符号（。！？!?…）分段并智能合并短句，确保自然呼吸感与分句体验。
 */
export function splitSentences(text: string, minLength = 12, maxLength = 35): string[] {
  // 保持代码块或长文本结构完整，绝不把代码切碎
  if (
    text.includes('```') ||
    text.includes('import ') ||
    text.includes('function ') ||
    text.includes('export ') ||
    text.includes('{\n') ||
    text.includes('[\n')
  )
    return [text.trim()]

  const cleaned = text
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if (!cleaned) return []

  // 标点符号正则表达式
  const PUNCTUATION_REGEX = /([。！？!?…\n]+)/g
  const rawSegments = cleaned.split(PUNCTUATION_REGEX)
  const initialSentences: string[] = []

  // 合并标点符号到前一个句子
  for (let i = 0; i < rawSegments.length; i += 2) {
    const sentence = rawSegments[i]?.trim() ?? ''
    const punctuation = rawSegments[i + 1]?.trim() ?? ''
    if (sentence) initialSentences.push(sentence + punctuation)
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

export const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 拟真活人阅读与打字轻量耗时：
 * 消除过量的人工沉睡（此前单句额外休眠 2~4 秒），保持轻快自然的即时响应
 */
export function calculateTypingDelay(sentence: string, isFirstSentence = false): number {
  if (isFirstSentence) {
    // 首句：微小起手延迟，快速发出 (150ms ~ 350ms)
    return Math.floor(150 + Math.random() * 200)
  }
  // 多句续接：短暂停顿，避免刷屏即可 (300ms ~ 600ms)
  const typing = Math.min(600, sentence.length * 15)
  return Math.floor(300 + typing)
}
