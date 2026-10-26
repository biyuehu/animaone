import type { OnebotAdapter } from '@kotori-bot/kotori-plugin-adapter-onebot'
import { type AdapterConfig, type Context, Symbols, Tsu } from 'kotori-bot'
import { AbilityManager } from './ability'
import { systemStatusAbility } from './ability/system'
import {
  createCrossPlatformRecallAbility,
  createKotoriMessagingAbility,
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
import { calculateTypingDelay, delay, splitSentences } from './core/split'
import { MessageGateway } from './gateway/filter'
import { HierarchicalMemoryService } from './memory'

export const config = Tsu.Object({
  apiKey: Tsu.String().default(''),
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

  const memory = new HierarchicalMemoryService(cfg.apiKey, undefined, 20, cfg.proxy, cfg.modelName)
  const abilityManager = new AbilityManager()
  abilityManager.register(systemStatusAbility)
  abilityManager.register(createRememberAbility(memory))
  abilityManager.register(createCrossPlatformRecallAbility(memory))
  abilityManager.register(createSearchPastMemoriesAbility(memory))
  abilityManager.register(terminalExecuteAbility)
  abilityManager.register(fileReadOrWriteAbility)
  abilityManager.register(silenceAbility)
  abilityManager.register(createKotoriMessagingAbility(ctx))
  abilityManager.register(createWebSearchOrFetchAbility(cfg.proxy))

  const geminiClient = cfg.apiKey
    ? new GeminiClient({ apiKey: cfg.apiKey, modelName: cfg.modelName, proxy: cfg.proxy })
    : null

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
    const masterId = (adapter.config as AdapterConfig).master
    const { userId } = session
    const isOwner = userId === masterId
    const senderName = session.sender.nickname
    const groupId = session.groupId ? session.groupId : undefined

    const decision = gateway.evaluate(userId, groupId, rawMessage, platform, masterId, botSelfId, cfg.botName)
    if (!decision.allow) return next()

    const targetMessage = decision.cleanedMessage ?? rawMessage

    if (!geminiClient) {
      if (isOwner && !groupId) await session.quick('欸？笨蛋主人，你还没在配置里填 GEMINI_API_KEY 呢！快去填好再找我～')
      return next()
    }

    try {
      if (platform === 'onebot' && typeof (adapter as OnebotAdapter)?.call === 'function') {
        const onebot = adapter as OnebotAdapter
        if (groupId) onebot.call('group_poke', { group_id: Number(groupId), user_id: Number(userId) }).catch(() => {})
        else onebot.call('friend_poke', { user_id: Number(userId) }).catch(() => {})
      }

      // 记忆作用域隔离（群聊物理隔离，主人认知全局统一于 __master__）
      const scopeKey = groupId ? `${platform}:group:${groupId}` : `${platform}:private:${userId}`
      const profileKey = isOwner ? '__master__' : `${platform}:${userId}`

      const abilityCtx = { userId, groupId, platform, identity, isOwner }
      const extraContexts = await abilityManager.aggregateContext(abilityCtx)
      // 非主人群聊中，绝不注入主人的专属画像与记忆，防止群友对话串味认错人
      extraContexts.push(...memory.assemblePromptContext(scopeKey, isOwner ? profileKey : ''))

      // 如果是群聊日常偶尔插嘴，在提示词中追加提示：可以选择发言或保持沉默
      if (decision.reason === 'group_casual')
        extraContexts.push(
          '【群聊日常旁观提醒】你当前是路过偶尔围观群友聊天。如果你觉得他们的话题无聊或不想插嘴，请调用 choose_silence 工具保持静默；如果有想吐槽的，再做简短回应。'
        )

      // 动态组装带“多态躯壳偏置”的人格 Prompt
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

      const reply = await geminiClient.chat(
        systemPrompt,
        memory.getShortTerm(scopeKey, masterId),
        groupId
          ? `[${isOwner ? 'MASTER' : 'STRANGER'}]${session.sender.nickname}(ID:${userId})]) ${targetMessage}`
          : targetMessage,
        abilityManager,
        abilityCtx,
        cfg.maxToolLoops
      )

      // 如果 AI 主动选择了沉默工具，则静默结束本次链路
      if (!reply || reply === '__NO_REPLY__') return

      memory.recordTurn(scopeKey, profileKey, targetMessage, reply, session.sender?.nickname ?? String(userId))

      // 拟人打字机分句与呼吸感延迟发送
      const segments = cfg.enableHumanDelay ? splitSentences(reply) : [reply]
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
