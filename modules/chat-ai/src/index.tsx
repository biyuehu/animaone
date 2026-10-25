import { type Context, Symbols, Tsu } from 'kotori-bot'
import { AbilityManager } from './ability'
import { systemStatusAbility } from './ability/system'
import {
  createCrossPlatformRecallAbility,
  createKotoriMessagingAbility,
  createRememberAbility,
  createWebSearchOrFetchAbility,
  silenceAbility,
  terminalExecuteAbility
} from './ability/tools'
import { DEFAULT_BOT_NAME, DEFAULT_OWNER_NICK } from './core/constants'
import { GeminiClient } from './core/gemini'
import { buildSystemPrompt } from './core/persona'
import { calculateTypingDelay, delay, splitSentences } from './core/split'
import { MessageGateway } from './gateway/filter'
import { HierarchicalMemoryService } from './memory'

export const config = Tsu.Object({
  apiKey: Tsu.String().default(process.env.GEMINI_API_KEY ?? ''),
  modelName: Tsu.String().default('gemini-3.5-flash-lite'),
  proxy: Tsu.String().optional(),
  whitelistedGroups: Tsu.Array(Tsu.String()).default([]),
  experimentGroups: Tsu.Array(Tsu.String()).default([]),
  experimentSampleRate: Tsu.Number().range(0, 1).default(0.05),
  botName: Tsu.String().default(DEFAULT_BOT_NAME),
  ownerNick: Tsu.String().default(DEFAULT_OWNER_NICK),
  basePersona: Tsu.String().optional(),
  ownerPrivate: Tsu.String().optional(),
  ownerGroup: Tsu.String().optional(),
  guestGroup: Tsu.String().optional(),
  platformAspects: Tsu.Object({}).default({}),
  enableHumanDelay: Tsu.Boolean().default(true),
  allowedPlatforms: Tsu.Array(Tsu.String()).default(['onebot'])
})

type Config = Tsu.infer<typeof config>

export function main(ctx: Context, cfg: Config) {
  const gateway = new MessageGateway({
    whitelistedGroups: cfg.whitelistedGroups,
    experimentGroups: cfg.experimentGroups,
    experimentSampleRate: cfg.experimentSampleRate,
    allowedPlatforms: cfg.allowedPlatforms
  })

  const memory = new HierarchicalMemoryService(cfg.apiKey, undefined, 20, cfg.proxy, cfg.modelName)
  const abilityManager = new AbilityManager()
  abilityManager.register(systemStatusAbility)
  abilityManager.register(createRememberAbility(memory))
  abilityManager.register(createCrossPlatformRecallAbility(memory))
  abilityManager.register(terminalExecuteAbility)
  abilityManager.register(silenceAbility)
  abilityManager.register(createKotoriMessagingAbility(ctx))
  abilityManager.register(createWebSearchOrFetchAbility(cfg.proxy))

  const geminiClient = cfg.apiKey
    ? new GeminiClient({ apiKey: cfg.apiKey, modelName: cfg.modelName, proxy: cfg.proxy })
    : null

  ctx.midware(async (next, session) => {
    if (session.channelId || session.guildId) return next()

    const rawMessage = session.message?.trim()
    const prefix = session.api?.adapter?.config?.commandPrefix ?? ctx.config.global.commandPrefix
    if (!rawMessage || rawMessage.startsWith(prefix)) return next()

    const commands = ctx[Symbols.command]
    if (commands)
      for (const cmd of commands)
        for (const short of cmd.meta?.shortcut ?? []) if (rawMessage.startsWith(short)) return next()

    const adapter = session.api?.adapter
    const platform = adapter?.platform ?? ''
    const identity = adapter?.identity ?? 'default'
    const masterId = (adapter?.config as { master?: string } | undefined)?.master
    const botSelfId = String(adapter?.selfId ?? '')

    const userId = String(session.userId)
    const groupId = session.groupId ? String(session.groupId) : undefined
    const isOwner = masterId ? userId === String(masterId) : false

    // 0. 网关判定（含艾特检测、名字提及、白名单与偶尔水群）
    const decision = gateway.evaluate(userId, groupId, rawMessage, platform, masterId, botSelfId, cfg.botName)
    if (!decision.allow) return next()

    const targetMessage = decision.cleanedMessage ?? rawMessage

    if (!geminiClient) {
      if (isOwner && !groupId) {
        await session.quick('欸？笨蛋大哥哥，你还没在配置里填 GEMINI_API_KEY 呢！快去填好再找我～')
      }
      return next()
    }

    try {
      // OneBot 平台专属动态交互：收到消息时触发异步动作/指示
      if (platform === 'onebot' && typeof (adapter as any)?.call === 'function') {
        const onebot = adapter as any
        if (groupId) {
          onebot.call('group_poke', { group_id: Number(groupId), user_id: Number(userId) }).catch(() => {})
        } else {
          onebot.call('friend_poke', { user_id: Number(userId) }).catch(() => {})
        }
      }

      // 记忆作用域隔离（群聊物理隔离，主人认知全局统一于 __master__）
      const scopeKey = groupId ? `${platform}:group:${groupId}` : `${platform}:private:${userId}`
      const profileKey = isOwner ? '__master__' : `${platform}:${userId}`

      const abilityCtx = { userId, groupId, platform, identity, isOwner, message: targetMessage }
      const extraContexts = await abilityManager.aggregateContext(abilityCtx)
      extraContexts.push(...memory.assemblePromptContext(scopeKey, profileKey))

      // 如果是群聊日常偶尔插嘴，在提示词中追加提示：可以选择发言或保持沉默
      if (decision.reason === 'group_casual') {
        extraContexts.push(
          '【群聊日常旁观提醒】你当前是路过偶尔围观群友聊天。如果你觉得他们的话题无聊或不想插嘴，请调用 choose_silence 工具保持静默；如果有想吐槽的，再做简短回应。'
        )
      }

      // 如果是群聊日常偶尔插嘴，在提示词中追加提示：可以选择发言或保持沉默
      if (decision.reason === 'group_casual') {
        extraContexts.push(
          '【群聊日常旁观提醒】你当前是路过偶尔围观群友聊天。如果你觉得他们的话题无聊或不想插嘴，请调用 choose_silence 工具保持静默；如果有想吐槽的，再做简短回应。'
        )
      }

      // 动态组装带“多态躯壳偏置”的人格 Prompt
      const systemPrompt = buildSystemPrompt(
        {
          botName: cfg.botName,
          ownerNick: cfg.ownerNick,
          basePersona: cfg.basePersona,
          ownerPrivate: cfg.ownerPrivate,
          ownerGroup: cfg.ownerGroup,
          guestGroup: cfg.guestGroup,
          platformAspects: cfg.platformAspects as Record<string, string>
        },
        {
          platform,
          identity,
          masterId,
          userId,
          groupId,
          isOwner
        },
        extraContexts
      )
      const history = memory.getShortTerm(scopeKey)
      const reply = await geminiClient.chat(systemPrompt, history, targetMessage, abilityManager, abilityCtx)

      // 如果 AI 主动选择了沉默工具，则静默结束本次链路
      if (!reply || reply === '__NO_REPLY__') {
        return
      }

      memory.recordTurn(scopeKey, profileKey, targetMessage, reply)

      // 拟人打字机分句与呼吸感延迟发送
      const segments = cfg.enableHumanDelay ? splitSentences(reply) : [reply]
      for (let i = 0; i < segments.length; i++) {
        const delayTime = cfg.enableHumanDelay ? calculateTypingDelay(segments[i], i === 0) : 0
        if (delayTime > 0) {
          await delay(delayTime)
        }
        await session.quick(segments[i])
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      ctx.logger.error(`Failed to handle message: ${errorMsg}`)
      if (isOwner && !groupId) {
        await session.quick(`切，跟 Gemini 通讯翻车了：${errorMsg}。笨蛋大哥哥快去排查一下～`)
      }
    }
  }, 100)
}
