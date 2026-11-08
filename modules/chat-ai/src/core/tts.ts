import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Logger } from 'kotori-bot'

export interface TTSConfig {
  readonly command?: string
  readonly cooldownSec: number
  readonly maxChars: number
  readonly cacheDir: string
}

export interface SpeechSegment {
  readonly isVoice: boolean
  readonly content: string
  readonly lang?: string
}

/**
 * 提取文本中的 [voice: 文本] 或 [voice(ja): 文本] 标签，将其分离为文字段与语音段
 * 规则：
 * 1. 单轮回复最多只提取 1 条有效语音，后续多余语音标签自动降级为普通文字段，防止多条语音连发刷屏；
 * 2. 语种校验：若声明为 ja 但句子长度 > 5 且完全不包含日文假名（如误将中文释义包裹入 voice(ja)），自动降级为普通文字；
 */
export function parseVoiceSegments(text: string): SpeechSegment[] {
  const segments: SpeechSegment[] = []
  const regex = /\[voice(?:\(([a-zA-Z_-]+)\))?:\s*([^\]]+)\]/gi
  let lastIndex = 0
  let match: RegExpExecArray | null = regex.exec(text)
  let voiceCount = 0

  while (match !== null) {
    if (match.index > lastIndex) {
      const leading = text.slice(lastIndex, match.index).trim()
      if (leading) segments.push({ isVoice: false, content: leading })
    }
    const specifiedLang = match[1]?.trim().toLowerCase()
    const voiceText = match[2]?.trim()
    if (voiceText) {
      // 语种校验：若声明为 ja 但较长句子完全不含平假名或片假名，判定为误标的中文/非日文内容
      const hasJapaneseKana = /[\u3040-\u309F\u30A0-\u30FF]/.test(voiceText)
      const isMismatchedJa = specifiedLang === 'ja' && voiceText.length > 5 && !hasJapaneseKana

      if (voiceCount === 0 && !isMismatchedJa) {
        voiceCount++
        segments.push({
          isVoice: true,
          content: voiceText,
          lang: specifiedLang || 'auto'
        })
      } else {
        // 多于1条语音，或语音标签语种错配（如把中文塞进了 voice(ja)），安全降级为普通文字
        segments.push({
          isVoice: false,
          content: voiceText
        })
      }
    }
    lastIndex = regex.lastIndex
    match = regex.exec(text)
  }

  if (lastIndex < text.length) {
    const trailing = text.slice(lastIndex).trim()
    if (trailing) segments.push({ isVoice: false, content: trailing })
  }

  return segments.length > 0 ? segments : [{ isVoice: false, content: text }]
}

/**
 * 清除文本中的 [voice: xxx] 或 [voice(ja): xxx] 标签，还原为普通自然文本（用于降级或落库）
 */
export function stripVoiceTags(text: string): string {
  return text.replace(/\[voice(?:\([a-zA-Z_-]+\))?:\s*([^\]]+)\]/gi, (_match, _lang, content) => content).trim()
}

/**
 * 将本地生成的音频文件转换为语音负载：
 * - cmd 平台：保留标准 file:// URL 形式，防止终端被大量 Base64 刷屏；
 * - 非 cmd 平台（如 OneBot 等跨网络实例）：读取文件转换为 base64:// 负载，确保远端实例顺利接收并播放。
 */
export function toVoicePayload(wavPath: string, platform?: string): string {
  if (platform === 'cmd') {
    return pathToFileURL(path.resolve(wavPath)).href
  }
  try {
    const buffer = fs.readFileSync(wavPath)
    return `base64://${buffer.toString('base64')}`
  } catch {
    return pathToFileURL(path.resolve(wavPath)).href
  }
}

/**
 * 解析用户配置的外部命令行字符串，拆解为可执行文件路径与初始参数列表
 */
function parseCommandLine(cmdStr: string): { executable: string; args: string[] } {
  const parts: string[] = []
  const regex = /[^\s"']+|"([^"]*)"|'([^']*)'/g
  let match: RegExpExecArray | null = regex.exec(cmdStr)

  while (match !== null) {
    parts.push(match[1] ?? match[2] ?? match[0])
    match = regex.exec(cmdStr)
  }

  const executable = parts[0] ?? ''
  const args = parts.slice(1)
  return { executable, args }
}

export class TTSService {
  private readonly command?: string
  private readonly cooldownSec: number
  private readonly maxChars: number
  private readonly cacheDir: string
  private readonly lastVoiceTimes: Map<string, number> = new Map()
  private readonly logger?: Logger

  constructor(config: TTSConfig, logger?: Logger) {
    this.command = config.command?.trim()
    this.cooldownSec = config.cooldownSec
    this.maxChars = config.maxChars
    this.cacheDir = config.cacheDir
    this.logger = logger?.label('TTS')

    if (this.command) {
      this.ensureCacheDir()
      this.cleanOldCacheFiles()
    }
  }

  public isEnabled(): boolean {
    return Boolean(this.command && this.command.length > 0)
  }

  /**
   * 检查指定会话当前是否处于语音冷却中（主人永远不处于冷却）
   */
  public isCoolingDown(scopeKey: string, isMaster = false): boolean {
    if (!this.isEnabled()) return false
    if (isMaster) return false
    const lastTime = this.lastVoiceTimes.get(scopeKey)
    return Boolean(lastTime && Date.now() - lastTime < this.cooldownSec * 1000)
  }

  /**
   * 检查指定会话是否允许发送语音
   */
  public canSynthesize(scopeKey: string, text: string, isMaster = false): boolean {
    if (!this.isEnabled()) return false
    const cleanText = text.trim()
    if (!cleanText) return false

    // 字符上限严格统一限制（包括主人在内，单句过长的 TTS 失去听觉交互意义）
    if (cleanText.length > this.maxChars) return false

    // 主人享有特权：私聊和群聊中均无视发言冷却
    if (isMaster) return true

    const lastTime = this.lastVoiceTimes.get(scopeKey)
    if (lastTime && Date.now() - lastTime < this.cooldownSec * 1000) {
      return false
    }

    return true
  }

  public recordSent(scopeKey: string): void {
    this.lastVoiceTimes.set(scopeKey, Date.now())
  }

  /**
   * 调用外部脚本进行 TTS 语音合成
   * 遵循标准约定: {command} --text "<text>" --out "<out_path>" --identity "<identity>" --lang "<lang>"
   */
  public async synthesize(text: string, identity: string, lang = 'auto'): Promise<string | null> {
    if (!this.isEnabled() || !this.command) return null

    this.ensureCacheDir()
    const filename = `voice_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.wav`
    const outPath = path.resolve(this.cacheDir, filename)
    const { executable, args: baseArgs } = parseCommandLine(this.command)

    if (!executable) {
      this.logger?.warn('Invalid TTS command specified in configuration')
      return null
    }

    const fullArgs = [...baseArgs, '--text', text, '--out', outPath, '--identity', identity, '--lang', lang]
    const startTime = Date.now()

    this.logger?.info(
      `[TTS Synthesizing] User/Scope requested voice for identity [${identity}] (lang: ${lang}), text: "${text}"`
    )

    return new Promise<string | null>((resolve) => {
      let resolved = false
      let timer: NodeJS.Timeout | null = null

      try {
        const child = spawn(executable, fullArgs, {
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe']
        })

        timer = setTimeout(() => {
          if (!resolved) {
            resolved = true
            try {
              child.kill('SIGKILL')
            } catch {}
            this.logger?.warn(`[TTS Timeout] Execution timed out (>60s) for text: "${text}"`)
            resolve(null)
          }
        }, 60_000)

        let stderrOutput = ''
        child.stderr?.on('data', (chunk) => {
          stderrOutput += chunk.toString()
        })

        child.on('error', (err) => {
          if (!resolved) {
            resolved = true
            if (timer) clearTimeout(timer)
            this.logger?.error(`[TTS Execution Error] Failed to spawn process: ${err.message}`)
            resolve(null)
          }
        })

        child.on('close', (code) => {
          if (!resolved) {
            resolved = true
            if (timer) clearTimeout(timer)
            const duration = Date.now() - startTime
            if (code === 0 && fs.existsSync(outPath) && fs.statSync(outPath).size > 0) {
              this.logger?.info(`[TTS Completed] Generated speech in ${duration}ms: ${outPath}`)
              resolve(outPath)
            } else {
              this.logger?.warn(
                `[TTS Process Failed] Exit code ${code} (${duration}ms). Error: ${stderrOutput.trim() || 'Empty/Missing audio output'}`
              )
              resolve(null)
            }
          }
        })
      } catch (err) {
        if (!resolved) {
          resolved = true
          if (timer) clearTimeout(timer)
          this.logger?.error(`[TTS Exception] Unexpected error: ${err instanceof Error ? err.message : String(err)}`)
          resolve(null)
        }
      }
    })
  }

  private ensureCacheDir(): void {
    if (!fs.existsSync(this.cacheDir)) {
      fs.mkdirSync(this.cacheDir, { recursive: true })
    }
  }

  private cleanOldCacheFiles(): void {
    try {
      if (!fs.existsSync(this.cacheDir)) return
      const files = fs.readdirSync(this.cacheDir)
      const now = Date.now()
      for (const file of files) {
        if (!file.endsWith('.wav')) continue
        const fullPath = path.join(this.cacheDir, file)
        const stat = fs.statSync(fullPath)
        // 清理超过 12 小时的过期临时音频
        if (now - stat.mtimeMs > 12 * 60 * 60 * 1000) {
          fs.unlinkSync(fullPath)
        }
      }
    } catch {}
  }
}
