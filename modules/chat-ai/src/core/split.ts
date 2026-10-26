/**
 * 拟真分句：
 * - 绝大多数普通闲聊直接整段发一条，绝不切碎成多句轰炸刷屏；
 * - 仅在字数确实较长（>70 字）且有非常明确的换行段落时，最多拆分成 2 句；
 * - 会自动清洗掉多余的连续空行与首尾空白，避免单条消息内部出现怪异的大空行。
 */
export function splitSentences(text: string): string[] {
  // 先把文本里可能存在的 3 个及以上连续换行压缩为双换行，去掉多余空洞
  const cleaned = text.replace(/\n{3,}/g, '\n\n').trim()
  if (!cleaned) return []

  // 保持代码块完整
  if (cleaned.includes('```')) return [cleaned]

  // 如果原本就不长（70 字以内），直接发 1 条，最具人类自然感（即使内部有换行，也只压成一条发）
  if (cleaned.length <= 70) {
    // 把内部空行压紧为单换行，真人打字在同条消息里不会留大片空行
    return [cleaned.replace(/\n\s*\n/g, '\n')]
  }

  // 超过 70 字且包含换行段落时，按段落拆分（最多拆 2 条消息）
  if (cleaned.includes('\n')) {
    const parts = cleaned
      .split(/\n+/)
      .map((p) => p.trim())
      .filter(Boolean)
    if (parts.length === 1) return parts
    // 第 1 句发第一段，剩下的合并为第 2 句（内部多余空行合为单换行）
    return [parts[0], parts.slice(1).join('\n')]
  }

  // 如果是一大坨长文本（超过 80 字）且没有换行，在句号/感叹号处寻找一次天然切分点（最多拆成 2 句）
  if (cleaned.length > 80) {
    const splitIndex = cleaned.search(/[。！？!?](\s*)/)
    if (splitIndex > 15 && splitIndex < cleaned.length - 15) {
      const first = cleaned.slice(0, splitIndex + 1).trim()
      const second = cleaned.slice(splitIndex + 1).trim()
      if (first && second) {
        return [first, second]
      }
    }
  }

  return [cleaned]
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
