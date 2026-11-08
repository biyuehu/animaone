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

/**
 * 终极清洗机器人发送的文本，过滤掉包括时间戳、时间标签残留、秒数尾缀、角色元数据等在内的无意义碎片
 */
export function cleanBotSpeech(text: string): string {
  if (!text) return ''
  return (
    text
      // 1. 匹配标准带方括号时间戳及其紧随的秒数或序号（如 [11/08 21:29], [11/08 21:29:13], [11/08 21:29]13, [2026/11/08 21:29]）
      .replace(
        /(?:^|\n|\s*)\[\d{1,4}[-/.]\d{1,2}(?:[-/.]\d{1,4})?(?:\s+\d{1,2}:\d{1,2}(?::\d{1,2})?)?\](?:\s*:\s*\d{1,2}|\s*\d{1,2})?\s*/g,
        ' '
      )
      // 2. 匹配纯时间方括号标签（如 [21:29], [21:29:13], [21:29]13）
      .replace(/(?:^|\n|\s*)\[\d{1,2}:\d{1,2}(?::\d{1,2})?\](?:\s*:\s*\d{1,2}|\s*\d{1,2})?\s*/g, ' ')
      // 3. 匹配行首未带方括号的时间戳（如 11/08 21:29:13 或 2026-11-08 21:29）
      .replace(
        /(?:^|\n)\s*\d{1,4}[-/.]\d{1,2}(?:\s+\d{1,2}:\d{1,2}(?::\d{1,2})?)?(?:\s*:\s*\d{1,2}|\s*\d{1,2})?\s*/g,
        ' '
      )
      // 4. 匹配残破截断的时间戳尾缀（如行首残留的 :13]、13]、:29:13]）
      .replace(/(?:^|\n|\s*)(?::?\d{1,2})+\s*\]\s*(?:\d{1,2})?\s*/g, ' ')
      // 5. 匹配元数据标签（如 [MASTER: ...], [UID: ...], [MEMBER: ...], [BOT], [AI] 等）
      .replace(/(?:^|\n|\s*)\[(?:MASTER|MEMBER|GUEST|BOT|USER|AI|UID|主人|成员|助手|系统)[^\]]*\]:?\s*/gi, ' ')
      // 6. 清理残缺破损的开头括号及跟随的残留数字（如 ']13', ':13', ']'）
      .replace(/^\s*[:\])\s]+(?:\d{1,2}\b)?\s*/g, '')
      // 7. 清理末尾残留的孤立标点符号残片与括号
      .replace(/[:[(\s]+$/, '')
      // 8. 规范化空格
      .replace(/[ \t]+/g, ' ')
      .trim()
  )
}

/**
 * 校验文本段是否具备真实人类对话的有效语义，拦截所有纯数字、残缺时间戳及符号乱码
 */
export function isMeaningfulSpeech(text: string, isEarlyOutput = false): boolean {
  if (!text) return false
  const t = text.trim()
  if (!t) return false
  if (/^(?:undefined|null|NaN|__NO_REPLY__|None)$/i.test(t)) return false

  // 纯 ASCII 标点符号 / 符号残片（如 ']', '::', '...', '---', '[]'）
  if (/^[.,;:!?\-_~`'"/\\[\](){}|<>@#$%^&*+=]+$/.test(t)) return false
  // 带有括号冒号和数字的残片（如 ']13', ':13', '] 13', '13]'）
  if (/^[\]:\s\d()[\]]+$/.test(t) && /[\]:[]/.test(t)) return false
  // 残留时间格式（如 '21:29', '11/08', '21:29:13'）
  if (/^\d{1,4}[:/]\d{1,2}(?::\d{1,2})?$/.test(t)) return false

  // 若为工具调用前的即时输出（earlyText），绝不能是纯数字或极短杂音
  if (isEarlyOutput) {
    if (/^\d+$/.test(t)) return false
    if (t.length < 2) return false
  }

  // 即便非 earlyText，纯 1~2 位孤立纯数字（很可能是秒数、序号遗留）在拟人对话中也应过滤
  if (/^\d{1,2}$/.test(t)) return false

  return true
}

export function stripLeadingTimestamps(text: string): string {
  return cleanBotSpeech(text)
}
