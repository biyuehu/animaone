import path from 'node:path'
// import type { OnebotAdapter } from '@kotori-bot/kotori-plugin-adapter-onebot'
import { type AdapterConfig, type Api, type Context, Messages, Symbols, sleep, Tsu, UserAccess } from 'kotori-bot'
import { AbilityManager } from './ability'
import { systemStatusAbility } from './ability/system'
import {
  createDemoteUserAttitudeAbility,
  createDreamReflectionAbility,
  createKotoriMessagingAbility,
  createRememberAbility,
  createSearchChannelPublicMemoriesAbility,
  createSearchMasterOmniscientMemoriesAbility,
  createWebSearchOrFetchAbility,
  fileReadOrWriteAbility,
  silenceAbility,
  terminalExecuteAbility
} from './ability/tools'
import {
  DEFAULT_BASE_PERSONA,
  DEFAULT_BOT_NAMES,
  DEFAULT_FRIEND_PRIVATE,
  DEFAULT_IDENTITY_ASPECTS,
  DEFAULT_MASTER_GROUP,
  DEFAULT_MASTER_NICK,
  DEFAULT_MASTER_PRIVATE,
  DEFAULT_MEMBER_GROUP
} from './core/constants'
import { GeminiClient } from './core/gemini'
import { buildSystemPrompt } from './core/persona'
import {
  applyTrailingBracket,
  calculateTypingDelay,
  cleanBotSpeech,
  isMeaningfulSpeech,
  splitSentences
} from './core/split'
import { parseVoiceSegments, stripVoiceTags, TTSService, toVoicePayload } from './core/tts'
import { MessageGateway, sanitizeCqCodes } from './gateway/filter'
import { formatScopeKey, groupScope, HierarchicalMemoryService, privateScope } from './memory'

export const config = Tsu.Object({
  apiKey: Tsu.String().describe('Google Gemini API Key'),
  modelName: Tsu.String().default('gemini-3.5-flash-lite').describe('使用的 Gemini 模型名称'),
  proxy: Tsu.String().optional().describe('网络代理地址（如 http://127.0.0.1:2333）'),
  whitelistedGroups: Tsu.Array(Tsu.String())
    .default([])
    .describe('启用群聊感知的白名单群号列表（支持纯群号、platform:群号、identity:群号）'),
  allowedInstances: Tsu.Array(Tsu.String())
    .default([])
    .describe('允许响应用于交互的实例 identity 列表（留空则不限制全部放行）'),
  groupActiveRate: Tsu.Number().range(0, 1).default(0.05).describe('群聊日常偶发插话/接梗的主动回复概率 (0~1)'),
  botNames: Tsu.Array(Tsu.String()).default(DEFAULT_BOT_NAMES).describe('机器人名称列表，第一个为默认名'),
  masterNick: Tsu.String().default(DEFAULT_MASTER_NICK).describe('对主人的默认基础称呼'),
  basePersona: Tsu.String().default(DEFAULT_BASE_PERSONA).describe('基础人格与灵魂设定 Prompt'),
  masterPrivate: Tsu.String().default(DEFAULT_MASTER_PRIVATE).describe('面对主人私聊时的补充人设'),
  masterGroup: Tsu.String().default(DEFAULT_MASTER_GROUP).describe('在群聊中与主人对话时的补充人设'),
  memberGroup: Tsu.String().default(DEFAULT_MEMBER_GROUP).describe('在群聊中与普通群成员对话时的补充人设'),
  friendPrivate: Tsu.String().default(DEFAULT_FRIEND_PRIVATE).describe('在私聊中与好友对话时的补充人设'),
  allowFriendPrivate: Tsu.Boolean().default(true).describe('是否允许普通好友私聊交互'),
  identityAspects: Tsu.Custom<Record<string, string>>((x) => {
    if (!x || typeof x !== 'object') return false
    for (const v of Object.values(x)) if (typeof v !== 'string') return false
    return true
  })
    .default(DEFAULT_IDENTITY_ASPECTS)
    .describe('各实例专属特质与风格切面映射'),
  enableHumanDelay: Tsu.Boolean().default(true).describe('是否开启模拟人类打字延迟'),
  splitThreshold: Tsu.Number().default(120).describe('长回复整体发送不拆条的字符长度阈值'),
  trailingBracketRate: Tsu.Number().range(0, 1).default(0.08).describe('短句末尾随机添加半括号（）的拟人概率'),
  trailingBracketVariants: Tsu.Array(Tsu.String())
    .default(['（', '）', '（（', '（（（', '（）'])
    .describe('短句末尾随机追加的半括号变体列表'),
  followupWindow: Tsu.Number().default(45).describe('群聊跟帖会话窗口判定秒数'),
  burstThreshold: Tsu.Number().default(8).describe('判定群聊密集水群触发回复的消息条数阈值'),
  maxTurns: Tsu.Number().default(20).describe('短期对话滑动窗口最大保留轮数'),
  summaryInterval: Tsu.Number().default(10).describe('自动触发长期记忆归档与提炼的交互轮次间隔'),
  summaryCharLimit: Tsu.Number().default(1500).describe('群聊累计字符数超限自动提前触发归档总结的字数阈值'),
  idleCompactTimeout: Tsu.Number().default(300).describe('群聊无活动自动触发记忆压缩的空闲秒数'),
  activeMemoryCapacity: Tsu.Number().default(15).describe('组装上下文时最多召回的用户画像事实条数'),
  enableDreamReflection: Tsu.Boolean().default(true).describe('是否开启凌晨闲暇做梦灵感推演'),
  dreamCooldown: Tsu.Number().default(900).describe('主动调用做梦工具的冷却时间（秒，默认15分钟）'),
  maxToolLoops: Tsu.Number().default(10).describe('单轮对话大模型工具调用最大循环次数'),
  ttsCommand: Tsu.String()
    .optional()
    .describe('外部 TTS 脚本可执行命令（如 python path/to/tts.py），留空则关闭语音合成'),
  ttsCooldown: Tsu.Number().default(45).describe('群聊中发送语音条的冷却秒数'),
  ttsMaxChars: Tsu.Number().default(60).describe('允许转为语音条的单句最大字符数阈值'),
  ttsSequential: Tsu.Boolean()
    .default(false)
    .describe(
      '是否要求 TTS 语音与文字内容连续按序等待发送。默认 false（两者独立并行，文字仅等待正常打字机模拟时长即可发出，无需等待语音合成）'
    )
})

export type Config = Tsu.infer<typeof config>

function extractUserId(raw: string | undefined): string {
  if (!raw) return ''
  const atMatch = raw.match(/\[CQ:at,qq=(\d+)\]/i)
  if (atMatch) return atMatch[1]
  const idMatch = raw.match(/\d+/)
  return idMatch ? idMatch[0] : raw.trim()
}

export function main(ctx: Context, cfg: Config) {
  const gateway = new MessageGateway({
    whitelistedGroups: cfg.whitelistedGroups,
    groupActiveRate: cfg.groupActiveRate,
    allowedInstances: cfg.allowedInstances,
    followupWindow: cfg.followupWindow,
    burstThreshold: cfg.burstThreshold,
    allowFriendPrivate: cfg.allowFriendPrivate
  })

  const geminiClient = new GeminiClient({
    apiKey: cfg.apiKey,
    modelName: cfg.modelName,
    proxy: cfg.proxy,
    logger: ctx.logger
  })

  const memory = new HierarchicalMemoryService(
    geminiClient,
    path.join(ctx.baseDir.data, 'memory.db'),
    cfg.maxTurns,
    cfg.summaryInterval,
    cfg.summaryCharLimit,
    cfg.activeMemoryCapacity,
    {
      botName: cfg.botNames[0],
      masterNick: cfg.masterNick,
      basePersona: cfg.basePersona
    },
    cfg.idleCompactTimeout,
    cfg.enableDreamReflection,
    cfg.dreamCooldown,
    ctx.logger
  )

  const tts = new TTSService(
    {
      command: cfg.ttsCommand,
      cooldownSec: cfg.ttsCooldown,
      maxChars: cfg.ttsMaxChars,
      cacheDir: path.join(ctx.baseDir.data, 'cache', 'voices')
    },
    ctx.logger
  )

  const abilityManager = new AbilityManager(ctx.logger)
  abilityManager.register(systemStatusAbility)
  abilityManager.register(createRememberAbility(memory))
  abilityManager.register(createDemoteUserAttitudeAbility(memory, ctx.logger))
  abilityManager.register(createSearchMasterOmniscientMemoriesAbility(memory))
  abilityManager.register(createSearchChannelPublicMemoriesAbility(memory))
  abilityManager.register(createDreamReflectionAbility(memory, cfg.dreamCooldown))
  abilityManager.register(terminalExecuteAbility)
  abilityManager.register(fileReadOrWriteAbility)
  abilityManager.register(silenceAbility)
  abilityManager.register(createKotoriMessagingAbility(ctx))
  abilityManager.register(createWebSearchOrFetchAbility(cfg.proxy))

  let isHeartbeatRunning = false
  const heartbeatTask = ctx.task({ cron: '*/3 * * * *', timeZone: 'Asia/Shanghai', start: true }, async () => {
    if (isHeartbeatRunning) return
    isHeartbeatRunning = true
    let masterId = ''
    const botMap: Map<string, Set<Api>> = ctx[Symbols.bot]
    if (botMap)
      for (const apis of botMap.values())
        for (const api of apis) {
          const m = String((api.adapter?.config as AdapterConfig)?.master || '')
          if (m) {
            masterId = m
            break
          }
        }
    await memory.tickHeartbeat(masterId || undefined).catch((e) => {
      ctx.logger.error(`Memory heartbeat failed: ${e instanceof Error ? e.message : String(e)}`)
    })
    isHeartbeatRunning = false
  })

  ctx.on('dispose', () => {
    if (typeof heartbeatTask === 'function') (heartbeatTask as () => void)()
  })

  ctx
    .command('shut [duration:number] - 物理静默当前会话（传入 0 解除）')
    .access(UserAccess.MANGER)
    .action((data, session) => {
      const adapter = session.api.adapter
      const groupId = session.groupId ? String(session.groupId) : undefined
      const scopeKey = groupId ? `${adapter.identity}:${groupId}` : `${adapter.identity}:${session.userId}`
      const durationArg = typeof data.args[0] === 'number' ? data.args[0] : 600

      const seconds = gateway.shut(scopeKey, durationArg)
      if (groupId) gateway.shut(groupId, durationArg)

      if (seconds <= 0) {
        ctx.logger.info(`[Gateway Shut] Scope <blue>${scopeKey}</blue> unmuted by ${session.userId}`)
        return '已解除当前会话的静默状态。'
      }

      ctx.logger.info(`[Gateway Shut] Scope <blue>${scopeKey}</blue> shut down for ${seconds}s by ${session.userId}`)
      return `已完全静默当前会话，接下来的 ${seconds} 秒内将不再响应任何消息（输入 /shut 0 可提前解除）。`
    })

  ctx
    .command('calm [duration:number] - 让机器人冷静一个跟回周期，暂停当前会话的主动回复')
    .access(UserAccess.MANGER)
    .action((data, session) => {
      const adapter = session.api.adapter
      const groupId = session.groupId ? String(session.groupId) : undefined
      const scopeKey = groupId ? `${adapter.identity}:${groupId}` : `${adapter.identity}:${session.userId}`

      const durationSec = typeof data.args[0] === 'number' && data.args[0] > 0 ? data.args[0] : undefined
      const seconds = gateway.calm(scopeKey, durationSec)
      if (groupId) gateway.calm(groupId, durationSec)

      ctx.logger.info(
        `[Gateway Calm] Scope <blue>${scopeKey}</blue> entered calm state for ${seconds}s by ADMIN ${session.userId}`
      )

      return `已进入冷静状态，当前会话将暂停 ${seconds} 秒的主动跟回。`
    })

  ctx
    .command('attitude [user] - 查看用户的态度坏感度等级')
    .access(UserAccess.MEMBER)
    .action((data, session) => {
      const adapter = session.api.adapter
      let targetId = extractUserId(data.args[0])

      if (!targetId) {
        const rawMsg = (session.messageAlt ?? session.message) || ''
        const replyId = rawMsg.match(/\[CQ:reply,id=(-?\d+)\]/i)?.[1]
        if (replyId) {
          const scopeKey = session.groupId
            ? `${adapter.identity}:${session.groupId}`
            : `${adapter.identity}:${session.userId}`
          const quoted = memory.findQuotedMessage(scopeKey, replyId)
          if (quoted?.userId) targetId = quoted.userId
        }
      }
      if (!targetId) targetId = String(session.userId)

      const attitude = memory.getUserAttitude(`${adapter.identity}:${targetId}`)
      return `用户 ${targetId} 当前态度：【${attitude.statusText}】(等级: ${attitude.level}/4)${attitude.reason ? `\n原因：${attitude.reason}` : ''}`
    })

  ctx
    .command('setattitude <user> <level:number> - 设置用户的坏感度态度等级（0~4，0为赦免）')
    .access(UserAccess.ADMIN)
    .action((data, session) => {
      const adapter = session.api.adapter
      const targetId = extractUserId(data.args[0])
      const level = Number(data.args[1])

      if (!targetId) return '未能定位目标用户，请传入用户 QQ 号或 @目标成员。'
      if (Number.isNaN(level) || level < 0 || level > 4) return '态度等级必须为 0 ~ 4 的整数（0为恢复正常/赦免）。'

      const masterId = String((adapter.config as AdapterConfig)?.master || '')
      if (targetId === masterId || targetId === '__master__') {
        return '操作被拒绝：严禁更改主人的态度等级。'
      }

      const res = memory.setUserAttitude(`${adapter.identity}:${targetId}`, level, `管理员(${session.userId})手动设置`)

      ctx.logger.info(
        `[Attitude Set] User ${targetId} (identity: ${adapter.identity}) attitude set to [${res.statusText}] (level ${res.newLevel}) by ADMIN ${session.userId}`
      )

      return `已成功将用户 ${targetId} 的态度调整为【${res.statusText}】(等级: ${res.newLevel}/4)。`
    })

  ctx
    .command('flush - 清空当前会话的短期上下文记忆')
    .access(UserAccess.MANGER)
    .action((_, session) => {
      const adapter = session.api.adapter
      const scopeKey = session.groupId
        ? formatScopeKey(groupScope(adapter.identity, String(session.groupId)))
        : formatScopeKey(privateScope(adapter.identity, String(session.userId)))

      memory.clearShortTerm(scopeKey)
      ctx.logger.info(`[ShortTerm Flushed] Scope <blue>${scopeKey}</blue> flushed by ADMIN ${session.userId}`)
      return '已清空当前会话的短期上下文记忆。'
    })

  ctx
    .command('dream - 强制执行一次潜意识梦境顿悟推演')
    .access(UserAccess.ADMIN)
    .action(async (_, session) => {
      session.quick('正在入梦推演中，请稍候...')
      const res = await memory.triggerDream('__master__')
      if (res?.spoken) {
        return `梦境推演成功！顿悟灵感：“${res.spoken}”`
      }
      return '梦境推演未产生新的灵感（记忆节点不足或推演无产出）。'
    })

  ctx
    .command('tts <text:string> [lang:string] - 强制测试调用外部 TTS 脚本并发送语音')
    .access(UserAccess.ADMIN)
    .action(async (data, session) => {
      const adapter = session.api.adapter
      const text = data.args[0]?.trim()
      const lang = data.args[1]?.trim() || 'auto'
      if (!text) return '请输入需要转为语音的文本内容。'
      if (!tts.isEnabled()) return '当前插件未配置 ttsCommand，语音功能未启用。'

      session.quick('正在调用外部 TTS 脚本合成中，请稍候...')
      const wavPath = await tts.synthesize(text, adapter.identity, lang)
      if (wavPath) {
        return Messages.voice(toVoicePayload(wavPath, adapter.platform))
      }
      return 'TTS 合成失败，请检查外部脚本路径或查看后台日志报错。'
    })

  ctx.midware(async (next, session) => {
    if (session.channelId || session.guildId) return next()

    const rawMessage = (session.messageAlt ?? session.message)?.trim()
    if (
      !rawMessage ||
      rawMessage.startsWith(
        (session.api.adapter.config as AdapterConfig).commandPrefix ?? ctx.config.global.commandPrefix
      )
    )
      return next()

    for (const cmd of ctx[Symbols.command])
      for (const short of cmd.meta.shortcut) if (rawMessage.startsWith(short)) return next()

    const { adapter } = session.api
    const masterId = String((adapter.config as AdapterConfig).master)
    const userId = String(session.userId)
    const isMaster = Boolean(masterId) && userId === masterId
    const groupId = session.groupId ? String(session.groupId) : undefined

    if (!isMaster) {
      const userDislike = memory.getDatabase().getUserDislikeLevel(`${adapter.identity}:${userId}`)
      if (userDislike.level >= 4) {
        ctx.logger.info(
          `<yellow>[Physical Block]</yellow> User <cyan>${userId}</cyan> (identity: ${adapter.identity}) blocked due to attitude level 4 (ignored)`
        )
        return next()
      }
    }

    const decision = gateway.evaluate(
      userId,
      groupId,
      rawMessage,
      adapter.platform,
      adapter.identity,
      masterId,
      adapter.selfId,
      cfg.botNames
    )
    if (!decision.allow) {
      if (
        groupId &&
        decision.reason !== 'platform_rejected' &&
        (cfg.whitelistedGroups.includes(groupId) ||
          cfg.whitelistedGroups.includes(`${adapter.platform}:${groupId}`) ||
          cfg.whitelistedGroups.includes(`${adapter.identity}:${groupId}`))
      )
        memory.recordPassiveMessage(
          formatScopeKey(groupScope(adapter.identity, groupId)),
          userId,
          sanitizeCqCodes(rawMessage),
          session.sender.nickname,
          session.messageId
        )
      return next()
    }

    const targetMessage = decision.cleanedMessage ?? rawMessage

    if (!geminiClient) {
      if (isMaster && !groupId) await session.quick('插件未配置 apiKey，无法调用大模型。')
      return next()
    }

    try {
      const scopeKey = formatScopeKey(
        groupId ? groupScope(adapter.identity, groupId) : privateScope(adapter.identity, userId)
      )
      const abilityCtx = { userId, groupId, platform: adapter.platform, identity: adapter.identity, isMaster }
      const extraContexts = await abilityManager.aggregateContext(abilityCtx)

      if (isMaster) {
        extraContexts.push(`【关于主人的画像】`, ...memory.assemblePromptContext(scopeKey, '__master__'))
        const dream = memory.consumePendingDream()
        if (dream) {
          ctx.logger.info(`Consumed pending dream reflection for master: "${dream}"`)
          extraContexts.push(`【夜间梦境灵感】昨夜产生了以下顿悟或梦境灵感：“${dream}”。契合时可向主人分享。`)
        }
      } else {
        const attitude = memory.getUserAttitude(`${adapter.identity}:${userId}`)
        if (attitude.level > 0) {
          extraContexts.push(
            `【对当前对话者的态度】为${attitude.statusText}(警惕度: ${attitude.level}/4)${attitude.reason ? `，降级原因：“${attitude.reason}”` : ''}。态度会决定你的回复言语乃至沉默忽视情况`
          )
        }
        extraContexts.push(
          '【关于当前对话者的画像】',
          ...memory.assemblePromptContext(scopeKey, `${adapter.identity}:${userId}`)
        )
        extraContexts.push('【关于主人的公开画像】', ...memory.assemblePromptContext(scopeKey, '__master__', 'public'))
      }

      if (decision.reason === 'group_casual' || decision.reason === 'group_followup')
        extraContexts.push(
          '【群聊日常旁观提醒】你当前是在群内参与聊天或路过旁观。如果你觉得不需要回复、不想搭理对方或没必要插嘴，请调用 choose_silence 工具保持静默。'
        )

      const isVoiceRequested = /(发|说|用|来)(个|条|句|段)?语音|想听你(的声音|说)/i.test(targetMessage)
      const isTtsCoolingDown = !isMaster && tts.isCoolingDown(scopeKey, isMaster)

      if (tts.isEnabled() && !isTtsCoolingDown && isVoiceRequested) {
        extraContexts.push(
          `【对话者语音请求】对方表达了希望听到你语音回复的意向。如果你愿意，请挑选一句最合适的核心短句包裹在 [voice: 内容] 中发语音（请严格遵守单句 ${cfg.ttsMaxChars} 字以内的限制，简短精炼）。`
        )
      }

      const systemPrompt = buildSystemPrompt(
        cfg,
        {
          platform: adapter.platform,
          identity: adapter.identity,
          masterId,
          senderName: session.sender.nickname,
          userId,
          groupId,
          isMaster,
          birthTime: memory.getBirthTime(),
          isTtsCoolingDown,
          hasVoiceRequest: isVoiceRequested
        },
        extraContexts
      )

      const startTime = Date.now()
      const userRole = isMaster ? 'MASTER' : groupId ? 'MEMBER' : 'FRIEND'
      ctx.logger.info(
        `Received message [type: <magenta>${decision.reason}</magenta>] from <cyan>${userRole}</cyan>(<yellow>${userId}</yellow>) in <blue>${scopeKey}</blue> (${targetMessage.length} chars): ${targetMessage}`
      )

      const now = new Date()
      const timeTag = `[${String(now.getMonth() + 1).padStart(2, '0')}/${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}]`
      const quotedMsg = decision.replyId ? memory.findQuotedMessage(scopeKey, decision.replyId) : null
      const replyHint = quotedMsg ? `【引用了 [${quotedMsg.senderName}]: ${quotedMsg.content}】` : ''

      const sendBotSpeech = async (rawText: string, isFirstOutput: boolean): Promise<boolean> => {
        const text = cleanBotSpeech(rawText)
        if (!text || !isMeaningfulSpeech(text)) return false

        const voiceParts = parseVoiceSegments(text)

        interface OutputItem {
          isVoice: boolean
          content: string
          lang?: string
        }
        const items: OutputItem[] = []

        for (const part of voiceParts) {
          if (part.isVoice) {
            const cleanVoiceText = cleanBotSpeech(part.content.replace(/\r?\n+/g, '，')).trim()
            if (cleanVoiceText && isMeaningfulSpeech(cleanVoiceText)) {
              if (tts.canSynthesize(scopeKey, cleanVoiceText, isMaster)) {
                items.push({
                  isVoice: true,
                  content: cleanVoiceText,
                  lang: part.lang
                })
              } else {
                // 无法合成语音（超长、未开启或冷却中），安全降级为普通文字段
                const subSentences = cfg.enableHumanDelay
                  ? splitSentences(cleanVoiceText, cfg.splitThreshold)
                  : [cleanVoiceText]
                for (const s of subSentences) {
                  const cleanedSub = cleanBotSpeech(s).trim()
                  if (cleanedSub && isMeaningfulSpeech(cleanedSub)) {
                    items.push({ isVoice: false, content: cleanedSub })
                  }
                }
              }
            }
          } else {
            const cleanText = cleanBotSpeech(part.content).trim()
            if (!cleanText || !isMeaningfulSpeech(cleanText)) continue
            const subSentences = cfg.enableHumanDelay ? splitSentences(cleanText, cfg.splitThreshold) : [cleanText]
            for (const s of subSentences) {
              const cleanedSub = cleanBotSpeech(s).trim()
              if (cleanedSub && isMeaningfulSpeech(cleanedSub)) {
                items.push({ isVoice: false, content: cleanedSub })
              }
            }
          }
        }

        if (items.length === 0) return false

        // 针对待发送文本：若单段长度小于 50 且末尾为句号，自动去掉末尾句号
        for (const item of items) {
          if (!item.isVoice) {
            let c = cleanBotSpeech(item.content).trim()
            if (c.length < 50 && (c.endsWith('。') || (c.endsWith('.') && !c.endsWith('..')))) {
              c = c
                .replace(/[。]+$/, '')
                .replace(/(?<!\.)\.$/, '')
                .trimEnd()
            }
            item.content = c
          }
        }

        // 仅在最后一项为纯文字时附带半括号拟人尾缀
        const lastIdx = items.length - 1
        if (lastIdx >= 0 && !items[lastIdx].isVoice) {
          items[lastIdx] = {
            isVoice: false,
            content: applyTrailingBracket(items[lastIdx].content, cfg.trailingBracketRate, cfg.trailingBracketVariants)
          }
        }

        let firstTextSent = false
        let sentAny = false

        for (let i = 0; i < items.length; i++) {
          const item = items[i]

          if (item.isVoice) {
            if (cfg.ttsSequential) {
              // 连续阻塞模式：等待 TTS 脚本生成完毕后发送语音条，随后再继续后续文字
              const wavPath = await tts.synthesize(item.content, adapter.identity, item.lang)
              if (wavPath) {
                tts.recordSent(scopeKey)
                const voiceDelay = cfg.enableHumanDelay ? Math.floor(400 + Math.random() * 400) : 0
                if (voiceDelay > 0) await sleep(voiceDelay)
                await session.quick(Messages.voice(toVoicePayload(wavPath, adapter.platform)))
                sentAny = true
                continue
              }
            } else {
              // 独立非阻塞模式（默认）：语音后台异步合成并发送，不阻塞文字消息的打字机流
              void (async () => {
                try {
                  const wavPath = await tts.synthesize(item.content, adapter.identity, item.lang)
                  if (wavPath) {
                    tts.recordSent(scopeKey)
                    const voiceDelay = cfg.enableHumanDelay ? Math.floor(400 + Math.random() * 400) : 0
                    if (voiceDelay > 0) await sleep(voiceDelay)
                    await session.quick(Messages.voice(toVoicePayload(wavPath, adapter.platform)))
                  } else {
                    let fallbackText = cleanBotSpeech(item.content).trim()
                    if (fallbackText && isMeaningfulSpeech(fallbackText)) {
                      if (
                        fallbackText.length < 50 &&
                        (fallbackText.endsWith('。') || (fallbackText.endsWith('.') && !fallbackText.endsWith('..')))
                      ) {
                        fallbackText = fallbackText
                          .replace(/[。]+$/, '')
                          .replace(/(?<!\.)\.$/, '')
                          .trimEnd()
                      }
                      await session.quick(fallbackText)
                    }
                  }
                } catch (err) {
                  ctx.logger.error(`Async voice synthesis failed: ${err instanceof Error ? err.message : String(err)}`)
                }
              })()
              sentAny = true
              continue
            }
          }

          let cleanText = cleanBotSpeech(item.content).trim()
          if (!cleanText || !isMeaningfulSpeech(cleanText)) continue

          if (
            cleanText.length < 50 &&
            (cleanText.endsWith('。') || (cleanText.endsWith('.') && !cleanText.endsWith('..')))
          ) {
            cleanText = cleanText
              .replace(/[。]+$/, '')
              .replace(/(?<!\.)\.$/, '')
              .trimEnd()
          }
          if (!cleanText || !isMeaningfulSpeech(cleanText)) continue

          const isFirstText = isFirstOutput && !firstTextSent
          firstTextSent = true

          const delayTime = cfg.enableHumanDelay ? Math.max(0, calculateTypingDelay(cleanText, isFirstText)) : 0
          if (delayTime > 0) {
            ctx.logger.debug(`Typing delay: ${delayTime}ms for segment ${i + 1}/${items.length}`)
            await sleep(delayTime)
          }
          await session.quick(
            isFirstText && groupId && decision.needTargetUser
              ? Math.random() > 0.5
                ? Messages(Messages.mention(session.userId), ' ', cleanText)
                : Messages(Messages.reply(session.messageId), cleanText)
              : cleanText
          )
          sentAny = true
        }

        return sentAny
      }

      let hasSentImmediate = false
      const allEmittedTexts: string[] = []

      let reply: string
      try {
        reply = await geminiClient.chat(
          systemPrompt,
          memory.getShortTerm(scopeKey, masterId),
          groupId
            ? `${timeTag} [${isMaster ? 'MASTER' : 'MEMBER'}: ${session.sender.nickname}] [UID: ${userId}] ${replyHint}${targetMessage}`
            : `${timeTag} ${targetMessage}`,
          abilityManager,
          abilityCtx,
          cfg.maxToolLoops,
          async (earlyText) => {
            const cleaned = cleanBotSpeech(earlyText)
            if (!isMeaningfulSpeech(cleaned, true)) {
              ctx.logger.debug(`Suppressed meaningless early text before tools: ${earlyText}`)
              return
            }
            const sent = await sendBotSpeech(earlyText, true)
            if (sent) {
              hasSentImmediate = true
              allEmittedTexts.push(earlyText)
            }
          }
        )
      } catch (chatErr) {
        if (chatErr instanceof Error && chatErr.message === 'PROHIBITED_CONTENT') {
          ctx.logger.warn(
            `<red>[Circuit Breaker]</red> PROHIBITED_CONTENT detected for scope <blue>${scopeKey}</blue>. Purging suspicious last inbound message and retrying...`
          )
          // 熔断自愈：从短期滑窗和数据库中剔除最近可疑入站消息
          memory.purgeSuspiciousUserMessage(scopeKey)

          // 降级重试：以安全无害的占位降级提问重试，引导模型平稳过渡而不致会话死锁瘫痪
          const sanitizedPrompt =
            '刚才的消息因包含潜在违规词或敏感信息被系统阻断。请简短友善地回应提示“此内容暂无法回应，请换个话题吧”，不要复述违规内容。'
          reply = await geminiClient.chat(
            systemPrompt,
            memory.getShortTerm(scopeKey, masterId),
            `${timeTag} ${sanitizedPrompt}`,
            abilityManager,
            abilityCtx,
            1,
            async (earlyText) => {
              const cleaned = cleanBotSpeech(earlyText)
              if (!isMeaningfulSpeech(cleaned, true)) {
                ctx.logger.debug(`Suppressed meaningless early text before tools: ${earlyText}`)
                return
              }
              const sent = await sendBotSpeech(earlyText, true)
              if (sent) {
                hasSentImmediate = true
                allEmittedTexts.push(earlyText)
              }
            }
          )
        } else {
          throw chatErr
        }
      }

      ctx.logger.info(
        `Session round finished in <yellow>${Date.now() - startTime}ms</yellow>${reply ? ` (reply: <green>${reply.length}</green> chars)` : ''}`
      )

      if (reply && reply !== '__NO_REPLY__') {
        const cleaned = cleanBotSpeech(reply)
        if (isMeaningfulSpeech(cleaned)) {
          allEmittedTexts.push(reply)
          await sendBotSpeech(reply, !hasSentImmediate)
        }
      }

      const fullCombinedReply = cleanBotSpeech(stripVoiceTags(allEmittedTexts.join('\n'))).trim()
      if (!fullCombinedReply || !isMeaningfulSpeech(fullCombinedReply)) return

      if (groupId && (decision.reason === 'group_casual' || decision.reason === 'group_followup'))
        gateway.recordCasualSpeech(groupId)

      queueMicrotask(() =>
        memory.recordTurn(
          scopeKey,
          userId,
          targetMessage,
          fullCombinedReply,
          session.sender.nickname,
          isMaster,
          session.messageId
        )
      )
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      ctx.logger.error(`Failed to handle message: ${errorMsg}`)
      if (isMaster && !groupId) await session.quick(`模型通讯失败: ${errorMsg}`)
    }
  }, 100)
}
