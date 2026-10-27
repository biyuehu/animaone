import path from 'node:path'
// import type { OnebotAdapter } from '@kotori-bot/kotori-plugin-adapter-onebot'
import { type AdapterConfig, type Context, Symbols, Tsu } from 'kotori-bot'
import { AbilityManager } from './ability'
import { systemStatusAbility } from './ability/system'
import {
  createCrossPlatformRecallAbility,
  createKotoriMessagingAbility,
  createPublicMasterRecallAbility,
  createRememberAbility,
  createSearchPastMemoriesAbility,
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
import { applyTrailingBracket, calculateTypingDelay, delay, splitSentences } from './core/split'
import { MessageGateway } from './gateway/filter'
import { formatScopeKey, groupScope, HierarchicalMemoryService, privateScope } from './memory'

export const config = Tsu.Object({
  apiKey: Tsu.String(),
  modelName: Tsu.String().default('gemini-3.5-flash-lite'),
  proxy: Tsu.String().optional(),
  whitelistedGroups: Tsu.Array(Tsu.String()).default([]),
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
  allowedPlatforms: Tsu.Array(Tsu.String()).default(['onebot']),
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
    cfg.proxy
  )
  const abilityManager = new AbilityManager()
  abilityManager.register(systemStatusAbility)
  abilityManager.register(createRememberAbility(memory))
  abilityManager.register(createCrossPlatformRecallAbility(memory))
  abilityManager.register(createPublicMasterRecallAbility(memory))
  abilityManager.register(createSearchPastMemoriesAbility(memory))
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

  ctx.midware(async (next, session) => {
    if (session.channelId || session.guildId) return next()

    const rawMessage = ((session as { messageAlt?: string }).messageAlt ?? session.message)?.trim()
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
    const { platform, identity, selfId: botSelfId } = adapter
    const masterId = String((adapter.config as AdapterConfig).master ?? '')
    const userId = String(session.userId)
    const isOwner = Boolean(masterId) && userId === masterId
    const senderName = session.sender.nickname
    const groupId = session.groupId ? String(session.groupId) : undefined

    const decision = gateway.evaluate(userId, groupId, rawMessage, platform, masterId, botSelfId, cfg.botName)
    if (!decision.allow) return next()

    const targetMessage = decision.cleanedMessage ?? rawMessage

    if (!geminiClient) {
      if (isOwner && !groupId) await session.quick('欸？笨蛋主人，你还没在配置里填 GEMINI_API_KEY 呢！快去填好再找我～')
      return next()
    }

    try {
      // if (platform === 'onebot' && typeof (adapter as OnebotAdapter)?.call === 'function') {
      //   const onebot = adapter as OnebotAdapter
      //   if (groupId) onebot.call('group_poke', { group_id: Number(groupId), user_id: Number(userId) }).catch(() => {})
      //   else onebot.call('friend_poke', { user_id: Number(userId) }).catch(() => {})
      // }

      const scope = groupId ? groupScope(platform, groupId) : privateScope(platform, userId)
      const scopeKey = formatScopeKey(scope)
      const profileKey = isOwner ? '__master__' : `${platform}:${userId}`

      const abilityCtx = { userId, groupId, platform, identity, isOwner }
      const extraContexts = await abilityManager.aggregateContext(abilityCtx)
      // 非主人群聊中，绝不注入主人的专属画像与记忆，防止群友对话串味认错人
      extraContexts.push(...memory.assemblePromptContext(scopeKey, isOwner ? profileKey : undefined))

      if (decision.reason === 'group_casual')
        extraContexts.push(
          '【群聊日常旁观提醒】你当前是路过偶尔围观群友聊天。如果你觉得他们的话题无聊或不想插嘴，请调用 choose_silence 工具保持静默；如果有想吐槽的，再做简短回应。'
        )

      const systemPrompt = buildSystemPrompt(
        cfg,
        {
          platform,
          identity,
          masterId,
          senderName,
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
      const currentInput = groupId
        ? `${timeTag} [${isOwner ? 'OWNER' : 'GUEST'}: ${session.sender.nickname ?? 'User'}] [UID: ${userId}] ${targetMessage}`
        : `${timeTag} ${targetMessage}`

      const reply = await geminiClient.chat(
        systemPrompt,
        memory.getShortTerm(scopeKey, masterId),
        currentInput,
        abilityManager,
        abilityCtx,
        cfg.maxToolLoops
      )

      const chatDuration = Date.now() - startTime
      ctx.logger.info(
        `Session round finished in <yellow>${chatDuration}ms</yellow>${reply ? ` (reply: <green>${reply.length}</green> chars)` : ''}`
      )

      if (!reply || reply === '__NO_REPLY__') return

      queueMicrotask(() => {
        memory.recordTurn(scopeKey, profileKey, targetMessage, reply, session.sender?.nickname ?? String(userId))
      })

      const segments = cfg.enableHumanDelay ? splitSentences(reply, cfg.splitThreshold) : [reply]
      if (segments.length > 0) {
        const lastIdx = segments.length - 1
        segments[lastIdx] = applyTrailingBracket(
          segments[lastIdx],
          cfg.trailingBracketRate,
          cfg.trailingBracketVariants
        )
      }
      for (let i = 0; i < segments.length; i++) {
        const delayTime = cfg.enableHumanDelay ? calculateTypingDelay(segments[i], i === 0) : 0
        if (delayTime > 0) await delay(delayTime)
        await session.quick(segments[i])
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      ctx.logger.error(`Failed to handle message: ${errorMsg}`)
      if (isOwner && !groupId) await session.quick(`切，跟 Gemini 通讯翻车了：${errorMsg}。笨蛋主人快去排查一下～`)
    }
  }, 100)
}
