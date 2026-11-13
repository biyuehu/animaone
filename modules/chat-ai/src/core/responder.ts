import type { Context, SessionMsg } from 'kotori-bot'
import { Messages, sleep } from 'kotori-bot'
import type { Config } from '../index'
import { applyTrailingBracket, calculateTypingDelay, cleanBotSpeech, isMeaningfulSpeech, splitSentences } from './split'
import { parseVoiceSegments, stripVoiceTags, type TTSService, toVoicePayload } from './tts'

interface OutputItem {
  readonly isVoice: boolean
  readonly content: string
  readonly lang?: string
}

export class ChatResponder {
  public constructor(
    private readonly ctx: Context,
    private readonly cfg: Config,
    private readonly tts: TTSService
  ) {}

  public async sendBotSpeech(
    session: SessionMsg,
    scopeKey: string,
    rawText: string,
    isFirstOutput: boolean,
    isMaster: boolean,
    groupId: string | undefined,
    needTargetUser: boolean | undefined
  ): Promise<boolean> {
    const text = cleanBotSpeech(rawText)
    if (!text || !isMeaningfulSpeech(text)) return false

    const items = this.prepareOutputItems(text, scopeKey, isMaster)
    if (items.length === 0) return false

    const formatted = this.applyPersonaStyle(items)
    const adapter = session.api.adapter
    let firstTextSent = false
    let sentAny = false

    for (let i = 0; i < formatted.length; i++) {
      const item = formatted[i]
      if (item.isVoice) {
        if (this.cfg.ttsSequential) {
          const wavPath = await this.tts.synthesize(item.content, adapter.identity, item.lang)
          if (wavPath) {
            this.tts.recordSent(scopeKey)
            const voiceDelay = this.cfg.enableHumanDelay ? Math.floor(400 + Math.random() * 400) : 0
            if (voiceDelay > 0) await sleep(voiceDelay)
            await session.quick(Messages.voice(toVoicePayload(wavPath, adapter.platform)))
            sentAny = true
            continue
          }
        } else {
          void (async () => {
            try {
              const wavPath = await this.tts.synthesize(item.content, adapter.identity, item.lang)
              if (wavPath) {
                this.tts.recordSent(scopeKey)
                const voiceDelay = this.cfg.enableHumanDelay ? Math.floor(400 + Math.random() * 400) : 0
                if (voiceDelay > 0) await sleep(voiceDelay)
                await session.quick(Messages.voice(toVoicePayload(wavPath, adapter.platform)))
              } else {
                const fallbackText = this.trimPeriod(cleanBotSpeech(item.content).trim())
                if (fallbackText && isMeaningfulSpeech(fallbackText)) await session.quick(fallbackText)
              }
            } catch (err) {
              this.ctx.logger.error(`Async voice synthesis failed: ${err instanceof Error ? err.message : String(err)}`)
            }
          })()
          sentAny = true
          continue
        }
      }

      const cleanText = this.trimPeriod(cleanBotSpeech(item.content).trim())
      if (!cleanText || !isMeaningfulSpeech(cleanText)) continue

      const isFirstText = isFirstOutput && !firstTextSent
      firstTextSent = true

      const delayTime = this.cfg.enableHumanDelay ? Math.max(0, calculateTypingDelay(cleanText, isFirstText)) : 0
      if (delayTime > 0) {
        this.ctx.logger.debug(`Typing delay: ${delayTime}ms for segment ${i + 1}/${formatted.length}`)
        await sleep(delayTime)
      }

      await session.quick(
        isFirstText && groupId && needTargetUser
          ? Math.random() > 0.5
            ? Messages(Messages.mention(session.userId), ' ', cleanText)
            : Messages(Messages.reply(session.messageId), cleanText)
          : cleanText
      )
      sentAny = true
    }

    return sentAny
  }

  public stripVoice(text: string): string {
    return cleanBotSpeech(stripVoiceTags(text)).trim()
  }

  private trimPeriod(text: string): string {
    return text.length < 50 && (text.endsWith('。') || (text.endsWith('.') && !text.endsWith('..')))
      ? text
          .replace(/[。]+$/, '')
          .replace(/(?<!\.)\.$/, '')
          .trimEnd()
      : text
  }

  private prepareOutputItems(text: string, scopeKey: string, isMaster: boolean): OutputItem[] {
    const items: OutputItem[] = []
    for (const part of parseVoiceSegments(text))
      if (part.isVoice) {
        const cleanVoiceText = cleanBotSpeech(part.content.replace(/\r?\n+/g, '，')).trim()
        if (cleanVoiceText && isMeaningfulSpeech(cleanVoiceText))
          if (this.tts.canSynthesize(scopeKey, cleanVoiceText, isMaster)) {
            this.tts.recordSent(scopeKey)
            items.push({ isVoice: true, content: cleanVoiceText, lang: part.lang })
          } else {
            const sub = this.cfg.enableHumanDelay
              ? splitSentences(cleanVoiceText, this.cfg.splitThreshold)
              : [cleanVoiceText]
            for (const s of sub) {
              const cleaned = cleanBotSpeech(s).trim()
              if (cleaned && isMeaningfulSpeech(cleaned)) items.push({ isVoice: false, content: cleaned })
            }
          }
      } else {
        const cleanText = cleanBotSpeech(part.content).trim()
        if (cleanText && isMeaningfulSpeech(cleanText)) {
          const sub = this.cfg.enableHumanDelay ? splitSentences(cleanText, this.cfg.splitThreshold) : [cleanText]
          for (const s of sub) {
            const cleaned = cleanBotSpeech(s).trim()
            if (cleaned && isMeaningfulSpeech(cleaned)) items.push({ isVoice: false, content: cleaned })
          }
        }
      }
    return items
  }

  private applyPersonaStyle(items: OutputItem[]): OutputItem[] {
    const lastIndex = items.length - 1
    return items.map((item, index) =>
      item.isVoice
        ? item
        : {
            isVoice: false,
            content:
              index === lastIndex
                ? applyTrailingBracket(
                    this.trimPeriod(cleanBotSpeech(item.content).trim()),
                    this.cfg.trailingBracketRate,
                    this.cfg.trailingBracketVariants
                  )
                : this.trimPeriod(cleanBotSpeech(item.content).trim())
          }
    )
  }
}
