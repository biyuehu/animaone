import { type Context, Symbols, Tsu } from 'kotori-bot'
import { AbilityManager } from './ability'
import { systemStatusAbility } from './ability/system'
import { GeminiClient } from './core/gemini'
import { buildSystemPrompt } from './core/persona'
import { delay, splitSentences } from './core/split'
import { MessageGateway } from './gateway/filter'
import { HierarchicalMemoryService } from './memory'

export const config = Tsu.Object({
  apiKey: Tsu.String().default(process.env.GEMINI_API_KEY ?? ''),
  whitelistedGroups: Tsu.Array(Tsu.String()).default([]),
  experimentGroups: Tsu.Array(Tsu.String()).default([]),
  experimentSampleRate: Tsu.Number().range(0, 1).default(0.05),
  commandPrefix: Tsu.String().default('/'),
  botName: Tsu.String().default('露米 (Romi)'),
  ownerNick: Tsu.String().default('大哥哥'),
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
    commandPrefix: cfg.commandPrefix,
    allowedPlatforms: cfg.allowedPlatforms
  })

  const memory = new HierarchicalMemoryService(cfg.apiKey)
  const abilityManager = new AbilityManager()
  abilityManager.register(systemStatusAbility)

  const geminiClient = cfg.apiKey ? new GeminiClient({ apiKey: cfg.apiKey }) : null

  // 优先级设置为 80（偏后），让指令系统及前置过滤/别名插件先行处理
  ctx.midware(async (next, session) => {
    const rawMessage = session.message?.trim()
    const prefix = session.api?.adapter?.config?.commandPrefix ?? ctx.config.global.commandPrefix
    if (!rawMessage || rawMessage.startsWith(prefix)) return next()

    // 检查所有已注册指令的 shortcuts，若匹配则直接放行交由 command 系统执行
    const commands = ctx[Symbols.command]
    if (commands) {
      for (const cmd of commands) {
        for (const short of cmd.meta?.shortcut ?? []) {
          if (rawMessage.startsWith(short)) return next()
        }
      }
    }

    const adapter = session.api?.adapter
    const platform = adapter?.platform ?? ''
    const identity = adapter?.identity ?? 'default'
    const masterId = (adapter?.config as { master?: string } | undefined)?.master

    const userId = String(session.userId)
    const groupId = session.groupId ? String(session.groupId) : undefined
    const isOwner = masterId ? userId === String(masterId) : false

    // 0. 网关判定（含顶层平台白名单与群聊拦截）
    const decision = gateway.evaluate(userId, groupId, rawMessage, platform, masterId)
    if (decision.reason === 'command_intercept' && decision.interceptResponse) {
      await session.quick(decision.interceptResponse)
      return
    }
    if (!decision.allow) return next()

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

      const abilityCtx = { userId, groupId, isOwner, message: rawMessage }
      const extraContexts = await abilityManager.aggregateContext(abilityCtx)
      extraContexts.push(...memory.assemblePromptContext(scopeKey, profileKey))

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
      const reply = await geminiClient.chat(systemPrompt, history, rawMessage, abilityManager, abilityCtx)

      memory.recordTurn(scopeKey, profileKey, rawMessage, reply)

      // 拟人分句打字机发送（首尾统一使用 session.quick 发送）
      const segments = cfg.enableHumanDelay ? splitSentences(reply) : [reply]
      for (let i = 0; i < segments.length; i++) {
        if (i > 0) {
          await delay(Math.min(1200, Math.max(400, segments[i].length * 40)))
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
  }, 80)
}
