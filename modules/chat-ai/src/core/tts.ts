import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
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
 */
export function parseVoiceSegments(text: string): SpeechSegment[] {
  const segments: SpeechSegment[] = []
  const regex = /\[voice(?:\(([a-zA-Z_-]+)\))?:\s*([^\]]+)\]/gi
  let lastIndex = 0
  let match: RegExpExecArray | null = regex.exec(text)

  while (match !== null) {
    if (match.index > lastIndex) {
      const leading = text.slice(lastIndex, match.index).trim()
      if (leading) segments.push({ isVoice: false, content: leading })
    }
    const specifiedLang = match[1]?.trim().toLowerCase()
    const voiceText = match[2]?.trim()
    if (voiceText) {
      segments.push({
        isVoice: true,
        content: voiceText,
        lang: specifiedLang || 'auto'
      })
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
 * 将本地生成的音频文件转换为兼容本地及远程 OneBot 实例的语音负载 (base64://)
 */
export function toVoicePayload(wavPath: string): string {
  try {
    const buffer = fs.readFileSync(wavPath)
    return `base64://${buffer.toString('base64')}`
  } catch {
    return path.resolve(wavPath)
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
   * 检查指定会话是否允许发送语音
   */
  public canSynthesize(scopeKey: string, text: string, isMaster = false): boolean {
    if (!this.isEnabled()) return false
    const cleanText = text.trim()
    if (!cleanText) return false

    // 主人享有特权：私聊和群聊中均无视冷却，单句上限放宽
    if (isMaster) {
      return cleanText.length <= this.maxChars * 2
    }

    if (cleanText.length > this.maxChars) return false

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
