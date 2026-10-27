import path from 'node:path'
// import type { OnebotAdapter } from '@kotori-bot/kotori-plugin-adapter-onebot'
import { type AdapterConfig, type Api, type Context, Messages, Symbols, sleep, Tsu } from 'kotori-bot'
import { AbilityManager } from './ability'
import { systemStatusAbility } from './ability/system'
import {
  createCrossPlatformRecallAbility,
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
  DEFAULT_GUEST_GROUP,
  DEFAULT_MASTER_GROUP,
  DEFAULT_MASTER_NICK,
  DEFAULT_MASTER_PRIVATE,
  DEFAULT_PLATFORM_ASPECTS
} from './core/constants'
import { GeminiClient } from './core/gemini'
import { buildSystemPrompt } from './core/persona'
import { applyTrailingBracket, calculateTypingDelay, splitSentences } from './core/split'
import { MessageGateway, sanitizeCqCodes } from './gateway/filter'
import { formatScopeKey, groupScope, HierarchicalMemoryService, privateScope } from './memory'

export const config = Tsu.Object({
  apiKey: Tsu.String().describe('Google Gemini API Key'),
  modelName: Tsu.String().default('gemini-3.5-flash-lite').describe('使用的 Gemini 模型名称'),
  proxy: Tsu.String().optional().describe('网络代理地址（如 http://127.0.0.1:2333）'),
  whitelistedGroups: Tsu.Array(Tsu.String()).default([]).describe('启用群聊感知的白名单群号列表'),
  allowedPlatforms: Tsu.Array(Tsu.String()).default(['cmd', 'onebot']).describe('允许响应用于交互的平台列表'),
  groupActiveRate: Tsu.Number().range(0, 1).default(0.05).describe('群聊日常偶发插话/接梗的主动回复概率 (0~1)'),
  botNames: Tsu.Array(Tsu.String()).default(DEFAULT_BOT_NAMES).describe('机器人名称列表，第一个为默认名'),
  masterNick: Tsu.String().default(DEFAULT_MASTER_NICK).describe('对主人的默认基础称呼'),
  basePersona: Tsu.String().default(DEFAULT_BASE_PERSONA).describe('基础人格与灵魂设定 Prompt'),
  masterPrivate: Tsu.String().default(DEFAULT_MASTER_PRIVATE).describe('面对主人私聊时的补充人设'),
  masterGroup: Tsu.String().default(DEFAULT_MASTER_GROUP).describe('在群聊中与主人对话时的补充人设'),
  guestGroup: Tsu.String().default(DEFAULT_GUEST_GROUP).describe('在群聊中与普通群员对话时的补充人设'),
  platformAspects: Tsu.Custom<Record<string, string>>((x) => {
    if (!x || typeof x !== 'object') return false
    for (const v of Object.values(x)) if (typeof v !== 'string') return false
    return true
  })
    .default(DEFAULT_PLATFORM_ASPECTS)
    .describe('各平台专属特质与风格映射'),
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
  maxToolLoops: Tsu.Number().default(10).describe('单轮对话大模型工具调用最大循环次数')
})

export type Config = Tsu.infer<typeof config>

export function main(ctx: Context, cfg: Config) {
  const gateway = new MessageGateway({
    whitelistedGroups: cfg.whitelistedGroups,
    groupActiveRate: cfg.groupActiveRate,
    allowedPlatforms: cfg.allowedPlatforms,
    followupWindow: cfg.followupWindow,
    burstThreshold: cfg.burstThreshold
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
    ctx.logger
  )
  const abilityManager = new AbilityManager(ctx.logger)
  abilityManager.register(systemStatusAbility)
  abilityManager.register(createRememberAbility(memory))
  abilityManager.register(createCrossPlatformRecallAbility(memory))
  abilityManager.register(createSearchMasterOmniscientMemoriesAbility(memory))
  abilityManager.register(createSearchChannelPublicMemoriesAbility(memory))
  abilityManager.register(createDreamReflectionAbility(memory))
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

    const decision = gateway.evaluate(
      userId,
      groupId,
      rawMessage,
      adapter.platform,
      masterId,
      adapter.selfId,
      cfg.botNames
    )
    if (!decision.allow) {
      if (
        groupId &&
        decision.reason !== 'platform_rejected' &&
        (cfg.whitelistedGroups.includes(groupId) || cfg.whitelistedGroups.includes(`${adapter.platform}:${groupId}`))
      )
        memory.recordPassiveMessage(
          formatScopeKey(groupScope(adapter.platform, groupId)),
          userId,
          sanitizeCqCodes(rawMessage),
          session.sender.nickname,
          session.messageId
        )
      return next()
    }

    const targetMessage = decision.cleanedMessage ?? rawMessage

    if (!geminiClient) {
      if (isMaster && !groupId)
        await session.quick('欸？笨蛋主人，你还没在配置里填 GEMINI_API_KEY 呢！快去填好再找我～') // TODO
      return next()
    }

    try {
      const scopeKey = formatScopeKey(
        groupId ? groupScope(adapter.platform, groupId) : privateScope(adapter.platform, userId)
      )
      const abilityCtx = { userId, groupId, platform: adapter.platform, identity: adapter.identity, isMaster }
      const extraContexts = await abilityManager.aggregateContext(abilityCtx)
      extraContexts.push(...memory.assemblePromptContext(scopeKey, isMaster ? '__master__' : undefined))

      if (isMaster) {
        const dream = memory.consumePendingDream()
        if (dream) {
          ctx.logger.info(`Consumed pending dream reflection for master: "${dream}"`)
          extraContexts.push(
            `【潜意识昨夜梦境/顿悟提醒】你昨夜在潜意识中曾产生了以下顿悟或梦境灵感：“${dream}”。如果在当前对话中自然契合，你可以像刚睡醒或随口提起一样轻柔地向主人分享。`
          )
        }
      }

      if (decision.reason === 'group_casual' || decision.reason === 'group_followup')
        extraContexts.push(
          '【群聊日常旁观提醒】你当前是在群内参与聊天或路过旁观。如果你觉得不需要回复、不想搭理对方或没必要插嘴，请调用 choose_silence 工具保持静默。'
        )

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
          birthTime: memory.getBirthTime()
        },
        extraContexts
      )

      const startTime = Date.now()
      ctx.logger.info(
        `Received message [type: <magenta>${decision.reason}</magenta>] from <cyan>${isMaster ? 'MASTER' : 'USER'}</cyan>(<yellow>${userId}</yellow>) in <blue>${scopeKey}</blue> (${targetMessage.length} chars): ${targetMessage}`
      )

      const now = new Date()
      const timeTag = `[${String(now.getMonth() + 1).padStart(2, '0')}/${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}]`
      const quotedMsg = decision.replyId ? memory.findQuotedMessage(scopeKey, decision.replyId) : null
      const replyHint = quotedMsg ? `【引用了 [${quotedMsg.senderName}]: ${quotedMsg.content}】` : ''

      const reply = await geminiClient.chat(
        systemPrompt,
        memory.getShortTerm(scopeKey, masterId),
        groupId
          ? `${timeTag} [${isMaster ? 'MASTER' : 'GUEST'}: ${session.sender.nickname}] [UID: ${userId}] ${replyHint}${targetMessage}`
          : `${timeTag} ${targetMessage}`,
        abilityManager,
        abilityCtx,
        cfg.maxToolLoops
      )

      ctx.logger.info(
        `Session round finished in <yellow>${Date.now() - startTime}ms</yellow>${reply ? ` (reply: <green>${reply.length}</green> chars)` : ''}`
      )

      if (!reply || reply === '__NO_REPLY__') return

      // const reply = reply
      //   .replace(/^\[\d{1,2}\/\d{1,2}\s+\d{1,2}:\d{1,2}\]\s*/, '')
      //   .replace(/<\/?[a-z]+[^>]*>/gi, '')
      //   .trim()
      if (!reply) return

      if (groupId) gateway.recordBotSpeech(groupId)

      queueMicrotask(() => {
        memory.recordTurn(scopeKey, userId, targetMessage, reply, session.sender.nickname, isMaster, session.messageId)
      })

      const segments = cfg.enableHumanDelay ? splitSentences(reply, cfg.splitThreshold) : [reply]
      if (segments.length > 0)
        segments[segments.length - 1] = applyTrailingBracket(
          segments[segments.length - 1],
          cfg.trailingBracketRate,
          cfg.trailingBracketVariants
        )

      for (let i = 0; i < segments.length; i++) {
        const delayTime = cfg.enableHumanDelay ? calculateTypingDelay(segments[i], i === 0) : 0
        if (delayTime > 0) {
          ctx.logger.debug(`Typing delay: ${delayTime}ms for segment ${i + 1}/${segments.length}`)
          await sleep(delayTime)
        }
        await session.quick(
          i === 0 && groupId && decision.needTargetUser
            ? Math.random() > 0.5
              ? Messages(Messages.mention(session.userId), segments[i])
              : Messages(Messages.reply(session.messageId), segments[i])
            : segments[i]
        )
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      ctx.logger.error(`Failed to handle message: ${errorMsg}`)
      if (isMaster && !groupId) await session.quick(`切，跟 Gemini 通讯翻车了：${errorMsg}。笨蛋主人快去排查一下～`) // TODO
    }
  }, 100)
}
