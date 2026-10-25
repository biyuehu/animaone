/**
 * 拟真分句：
 * - 绝大多数普通闲聊（60 字以内）直接整段发一条，绝不切碎成 3~4 句轰炸刷屏；
 * - 仅在有明显换行（\n\n）或字数较长且有明确段落感时，才最多切为 2 句。
 */
export function splitSentences(text: string): string[] {
  const trimmed = text.trim()
  if (!trimmed) return []

  // 保持代码块完整
  if (trimmed.includes('```')) return [trimmed]

  // 如果原本就不长（60 字以内），或者没有明显的段落，直接发 1 条，最具人类自然感
  if (trimmed.length <= 60 && !trimmed.includes('\n\n')) {
    return [trimmed]
  }

  // 尝试优先按双换行或段落分
  if (trimmed.includes('\n\n')) {
    const parts = trimmed
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .filter(Boolean)
    if (parts.length <= 2) return parts
    // 最多 2 句，剩下的合并为第 2 句，严禁连发 3 条以上
    return [parts[0], parts.slice(1).join('\n\n')]
  }

  // 如果字数超过 60 字，在句号/感叹号处寻找一次天然切分点（最多拆成 2 句）
  const splitIndex = trimmed.search(/[。！？!?…~](\s*)/)
  if (splitIndex > 10 && splitIndex < trimmed.length - 10) {
    const first = trimmed.slice(0, splitIndex + 1).trim()
    const second = trimmed.slice(splitIndex + 1).trim()
    if (first && second) {
      return [first, second]
    }
  }

  return [trimmed]
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
