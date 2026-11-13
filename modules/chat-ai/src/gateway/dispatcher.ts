import type { Context, SessionMsg } from 'kotori-bot'
import type { AbilityContext, AbilityManager } from '../ability'
import type { GeminiClient } from '../core/gemini'
import { buildSystemPrompt } from '../core/persona'
import type { ChatResponder } from '../core/responder'
import { cleanBotSpeech, isMeaningfulSpeech } from '../core/split'
import type { TTSService } from '../core/tts'
import type { GatewayDecision, MessageGateway } from '../gateway/filter'
import type { Config } from '../index'
import type { HierarchicalMemoryService } from '../memory'

export interface ChatSessionContext {
  readonly session: SessionMsg
  readonly scopeKey: string
  readonly userId: string
  readonly groupId?: string
  readonly isMaster: boolean
  readonly masterId: string
  readonly decision: Extract<GatewayDecision, { allow: true }>
  readonly targetMessage: string
  readonly timeTag: string
  readonly replyHint: string
}

export class ChatDispatcher {
  public constructor(
    private readonly ctx: Context,
    private readonly cfg: Config,
    private readonly memory: HierarchicalMemoryService,
    private readonly geminiClient: GeminiClient,
    private readonly abilityManager: AbilityManager,
    private readonly tts: TTSService,
    private readonly gateway: MessageGateway,
    private readonly responder: ChatResponder,
    private readonly fetchWeather: (city: string) => Promise<string | null>
  ) {}

  public async dispatch(chatCtx: ChatSessionContext): Promise<void> {
    const { session, scopeKey, userId, groupId, isMaster, masterId, decision, targetMessage, timeTag, replyHint } =
      chatCtx
    const adapter = session.api.adapter

    const abilityCtx: AbilityContext = {
      userId,
      groupId,
      platform: adapter.platform,
      identity: adapter.identity,
      isMaster,
      session
    }

    const extraContexts = await this.abilityManager.aggregateContext(abilityCtx)
    this.assemblePersonaContexts(extraContexts, scopeKey, userId, isMaster, adapter.identity)

    if (decision.reason === 'group_casual' || decision.reason === 'group_followup')
      extraContexts.push(
        '【群聊日常旁观提醒】你当前是在群内参与聊天或路过旁观。如果你觉得不需要回复、不想搭理对方或没必要插嘴，请调用 choose_silence 工具保持静默。'
      )

    const isVoiceRequested = /(发|说|用|来)(个|条|句|段)?语音|想听你(的声音|说)/i.test(targetMessage)
    const isTtsCoolingDown = !isMaster && this.tts.isCoolingDown(scopeKey, isMaster)
    if (this.tts.isEnabled() && !isTtsCoolingDown && isVoiceRequested)
      extraContexts.push(
        `【对话者语音请求】对方表达了希望听到你语音回复的意向。如果你愿意，请挑选一句最合适的核心短句包裹在 [voice: 内容] 中发语音（请严格遵守单句 ${this.cfg.ttsMaxChars} 字以内的限制，简短精炼）。`
      )

    const senderName = session.sender?.nickname || userId
    const weather = isMaster && !groupId && this.cfg.city ? await this.fetchWeather(this.cfg.city) : undefined
    const systemPrompt = buildSystemPrompt(
      this.cfg,
      {
        platform: adapter.platform,
        identity: adapter.identity,
        masterId,
        senderName,
        userId,
        groupId,
        isMaster,
        birthTime: this.memory.getBirthTime(),
        isTtsCoolingDown,
        hasVoiceRequest: isVoiceRequested,
        weather: weather ?? undefined
      },
      extraContexts
    )

    const startTime = Date.now()
    this.ctx.logger.info(
      `Received message [type: <magenta>${decision.reason}</magenta>] from <cyan>${isMaster ? 'MASTER' : groupId ? 'MEMBER' : 'FRIEND'}</cyan>(<yellow>${userId}</yellow>) in <blue>${scopeKey}</blue> (${targetMessage.length} chars): ${targetMessage}`
    )

    let hasSentImmediate = false
    const allEmittedTexts: string[] = []

    const sendEarly = async (earlyText: string): Promise<void> => {
      if (!isMeaningfulSpeech(cleanBotSpeech(earlyText), true)) {
        this.ctx.logger.debug(`Suppressed meaningless early text before tools: ${earlyText}`)
        return
      }
      const sent = await this.responder.sendBotSpeech(
        session,
        scopeKey,
        earlyText,
        true,
        isMaster,
        groupId,
        decision.needTargetUser
      )
      if (sent) {
        hasSentImmediate = true
        allEmittedTexts.push(earlyText)
      }
    }

    const inboundPrompt = groupId
      ? `${timeTag} [${isMaster ? 'MASTER' : 'MEMBER'}: ${senderName}] [UID: ${userId}] ${replyHint}${targetMessage}`
      : `${timeTag} ${targetMessage}`

    let reply: string
    try {
      reply = await this.geminiClient.chat(
        systemPrompt,
        this.memory.getShortTerm(scopeKey, masterId),
        inboundPrompt,
        this.abilityManager,
        abilityCtx,
        this.cfg.maxToolLoops,
        sendEarly
      )
    } catch (chatErr) {
      if (chatErr instanceof Error && chatErr.message === 'PROHIBITED_CONTENT') {
        this.ctx.logger.warn(
          `<red>[Circuit Breaker]</red> PROHIBITED_CONTENT detected for scope <blue>${scopeKey}</blue>. Purging suspicious last inbound message and retrying...`
        )
        this.memory.purgeSuspiciousUserMessage(scopeKey)
        reply = await this.geminiClient.chat(
          systemPrompt,
          this.memory.getShortTerm(scopeKey, masterId),
          `${timeTag} 刚才的消息因包含潜在违规词或敏感信息被系统阻断。请简短友善地回应提示“此内容暂无法回应，请换个话题吧”，不要复述违规内容。`,
          this.abilityManager,
          abilityCtx,
          1,
          sendEarly
        )
      } else throw chatErr
    }

    this.ctx.logger.info(
      `Session round finished in <yellow>${Date.now() - startTime}ms</yellow>${reply ? ` (reply: <green>${reply.length}</green> chars)` : ''}`
    )

    if (reply && reply !== '__NO_REPLY__' && isMeaningfulSpeech(cleanBotSpeech(reply))) {
      allEmittedTexts.push(reply)
      await this.responder.sendBotSpeech(
        session,
        scopeKey,
        reply,
        !hasSentImmediate,
        isMaster,
        groupId,
        decision.needTargetUser
      )
    }

    const fullCombinedReply = this.responder.stripVoice(allEmittedTexts.join('\n'))
    if (!fullCombinedReply || !isMeaningfulSpeech(fullCombinedReply)) return

    if (groupId && (decision.reason === 'group_casual' || decision.reason === 'group_followup'))
      this.gateway.recordCasualSpeech(groupId)

    queueMicrotask(() =>
      this.memory.recordTurn(
        scopeKey,
        userId,
        targetMessage,
        fullCombinedReply,
        senderName,
        isMaster,
        session.messageId
      )
    )
  }

  private assemblePersonaContexts(
    extraContexts: string[],
    scopeKey: string,
    userId: string,
    isMaster: boolean,
    identity: string
  ): void {
    if (isMaster) {
      extraContexts.push('【关于主人的画像】', ...this.memory.assemblePromptContext(scopeKey, '__master__'))
      const dream = this.memory.consumePendingDream()
      if (dream) {
        this.ctx.logger.info(`Consumed pending dream reflection for master: "${dream}"`)
        extraContexts.push(`【夜间梦境灵感】昨夜产生了以下顿悟或梦境灵感：“${dream}”。契合时可向主人分享。`)
      }
    } else {
      const attitude = this.memory.getUserAttitude(`${identity}:${userId}`)
      if (attitude.level > 0)
        extraContexts.push(
          `【对当前对话者的态度】为${attitude.statusText}(警惕度: ${attitude.level}/4)${attitude.reason ? `，降级原因：“${attitude.reason}”` : ''}。态度会决定你的回复言语乃至沉默忽视情况`
        )
      extraContexts.push(
        '【关于当前对话者的画像】',
        ...this.memory.assemblePromptContext(scopeKey, `${identity}:${userId}`)
      )
      extraContexts.push(
        '【关于主人的公开画像】',
        ...this.memory.assemblePromptContext(scopeKey, '__master__', 'public')
      )
    }
  }
}
