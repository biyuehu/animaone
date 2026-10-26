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
 * 拟真活人阅读与打字耗时：
 * 1. 模拟真人先“读完消息 + 思考构思”（1.2s ~ 2.2s）；
 * 2. 模拟真实人类双手打字敲键盘时间（每字 60ms ~ 85ms）；
 * 3. 第二句发出前带有 1.5s ~ 2.5s 的思考与输入停顿。
 */
export function calculateTypingDelay(sentence: string, isFirstSentence = false): number {
  if (isFirstSentence) {
    // 读完大哥哥的话并思考准备回答 (1200ms ~ 2000ms) + 敲出前几个字
    const readAndThink = 1200 + Math.random() * 800
    const typing = Math.min(1200, sentence.length * (50 + Math.random() * 25))
    return Math.floor(readAndThink + typing)
  }
  // 第二句：发送前停顿 (1000ms ~ 1800ms) + 敲完本句耗时
  const pause = 1000 + Math.random() * 800
  const typing = sentence.length * (60 + Math.random() * 25)
  return Math.min(3500, Math.max(1200, Math.floor(pause + typing)))
}
