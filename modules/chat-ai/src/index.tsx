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
  DEFAULT_BOT_NAME,
  DEFAULT_GUEST_GROUP,
  DEFAULT_OWNER_GROUP,
  DEFAULT_OWNER_NICK,
  DEFAULT_OWNER_PRIVATE,
  DEFAULT_PLATFORM_ASPECTS
} from './core/constants'
import { GeminiClient } from './core/gemini'
import { buildSystemPrompt } from './core/persona'
import { applyTrailingBracket, calculateTypingDelay, splitSentences } from './core/split'
import { MessageGateway, sanitizeCqCodes } from './gateway/filter'
import { formatScopeKey, groupScope, HierarchicalMemoryService, privateScope } from './memory'

export const config = Tsu.Object({
  apiKey: Tsu.String(),
  modelName: Tsu.String().default('gemini-3.5-flash-lite'),
  proxy: Tsu.String().optional(),
  whitelistedGroups: Tsu.Array(Tsu.String()).default([]),
  allowedPlatforms: Tsu.Array(Tsu.String()).default(['cmd', 'onebot']),
  groupActiveRate: Tsu.Number().range(0, 1).default(0.05),
  botName: Tsu.String().default(DEFAULT_BOT_NAME),
  ownerNick: Tsu.String().default(DEFAULT_OWNER_NICK),
  basePersona: Tsu.String().default(DEFAULT_BASE_PERSONA),
  ownerPrivate: Tsu.String().default(DEFAULT_OWNER_PRIVATE),
  ownerGroup: Tsu.String().default(DEFAULT_OWNER_GROUP),
  guestGroup: Tsu.String().default(DEFAULT_GUEST_GROUP),
  platformAspects: Tsu.Custom<Record<string, string>>((x) => {
    if (!x || typeof x !== 'object') return false
    for (const v of Object.values(x)) if (typeof v !== 'string') return false
    return true
  }).default(DEFAULT_PLATFORM_ASPECTS),
  enableHumanDelay: Tsu.Boolean().default(true),
  splitThreshold: Tsu.Number().default(120),
  trailingBracketRate: Tsu.Number().range(0, 1).default(0.08),
  trailingBracketVariants: Tsu.Array(Tsu.String()).default(['（', '）', '（（', '（（（', '（）']),
  maxTurns: Tsu.Number().default(20),
  summaryInterval: Tsu.Number().default(10),
  activeMemoryCapacity: Tsu.Number().default(15),
  maxToolLoops: Tsu.Number().default(10)
})

export type Config = Tsu.infer<typeof config>

export function main(ctx: Context, cfg: Config) {
  const gateway = new MessageGateway({
    whitelistedGroups: cfg.whitelistedGroups,
    groupActiveRate: cfg.groupActiveRate,
    allowedPlatforms: cfg.allowedPlatforms
  })

  const memory = new HierarchicalMemoryService(
    cfg.modelName,
    cfg.apiKey,
    path.join(ctx.baseDir.data, 'memory.db'),
    cfg.maxTurns,
    cfg.summaryInterval,
    cfg.activeMemoryCapacity,
    cfg.proxy
  )
  const abilityManager = new AbilityManager()
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

  const geminiClient = new GeminiClient({
    apiKey: cfg.apiKey,
    modelName: cfg.modelName,
    proxy: cfg.proxy,
    logger: ctx.logger
  })

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
    const isOwner = Boolean(masterId) && userId === masterId
    const groupId = session.groupId ? String(session.groupId) : undefined

    const decision = gateway.evaluate(
      userId,
      groupId,
      rawMessage,
      adapter.platform,
      masterId,
      adapter.selfId,
      cfg.botName
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
      if (isOwner && !groupId) await session.quick('欸？笨蛋主人，你还没在配置里填 GEMINI_API_KEY 呢！快去填好再找我～')
      return next()
    }

    try {
      const scopeKey = formatScopeKey(
        groupId ? groupScope(adapter.platform, groupId) : privateScope(adapter.platform, userId)
      )
      const abilityCtx = { userId, groupId, platform: adapter.platform, identity: adapter.identity, isOwner }
      const extraContexts = await abilityManager.aggregateContext(abilityCtx)
      extraContexts.push(...memory.assemblePromptContext(scopeKey, isOwner ? '__master__' : undefined))

      if (isOwner) {
        const dream = memory.consumePendingDream()
        if (dream)
          extraContexts.push(
            `【潜意识昨夜梦境/顿悟提醒】你昨夜在潜意识中曾产生了以下顿悟或梦境灵感：“${dream}”。如果在当前对话中自然契合，你可以像刚睡醒或随口提起一样轻柔地向主人分享。`
          )
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
          isOwner,
          birthTime: memory.getBirthTime()
        },
        extraContexts
      )

      const startTime = Date.now()
      ctx.logger.info(
        `Received message from <cyan>${isOwner ? 'OWNER' : 'USER'}</cyan>(<yellow>${userId}</yellow>) in <blue>${scopeKey}</blue> (${targetMessage.length} chars): ${targetMessage}`
      )

      const now = new Date()
      const timeTag = `[${String(now.getMonth() + 1).padStart(2, '0')}/${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}]`
      const quotedMsg = decision.replyId ? memory.getDatabase().findMessageByMessageId(decision.replyId) : null

      const reply = await geminiClient.chat(
        systemPrompt,
        memory.getShortTerm(scopeKey, masterId),
        groupId
          ? `${timeTag} [${isOwner ? 'OWNER' : 'GUEST'}: ${session.sender.nickname}] [UID: ${userId}] ${quotedMsg ? `【引用了 [${quotedMsg.senderName}]: ${quotedMsg.content}】` : ''}${targetMessage}`
          : `${timeTag} ${targetMessage}`,
        abilityManager,
        abilityCtx,
        cfg.maxToolLoops,
        decision.reason === 'group_direct' || decision.reason === 'owner_direct'
      )

      ctx.logger.info(
        `Session round finished in <yellow>${Date.now() - startTime}ms</yellow>${reply ? ` (reply: <green>${reply.length}</green> chars)` : ''}`
      )

      if (!reply || reply === '__NO_REPLY__') return

      const cleanReply = reply.replace(/^\[\d{1,2}\/\d{1,2}\s+\d{1,2}:\d{1,2}\]\s*/, '').trim()
      if (!cleanReply) return

      if (groupId) gateway.recordBotSpeech(groupId)

      queueMicrotask(() => {
        memory.recordTurn(
          scopeKey,
          userId,
          targetMessage,
          cleanReply,
          session.sender.nickname,
          isOwner,
          session.messageId
        )
      })

      const segments = cfg.enableHumanDelay ? splitSentences(cleanReply, cfg.splitThreshold) : [cleanReply]
      if (segments.length > 0)
        segments[segments.length - 1] = applyTrailingBracket(
          segments[segments.length - 1],
          cfg.trailingBracketRate,
          cfg.trailingBracketVariants
        )

      for (let i = 0; i < segments.length; i++) {
        const delayTime = cfg.enableHumanDelay ? calculateTypingDelay(segments[i], i === 0) : 0
        if (delayTime > 0) await sleep(delayTime)
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
      if (isOwner && !groupId) await session.quick(`切，跟 Gemini 通讯翻车了：${errorMsg}。笨蛋主人快去排查一下～`)
    }
  }, 100)
}
