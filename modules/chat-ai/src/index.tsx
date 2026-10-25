import { type Context, Tsu } from 'kotori-bot'
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

  ctx.midware(async (next, session) => {
    const rawMessage = session.message?.trim()
    if (!rawMessage) return next()

    const adapter = session.api?.adapter
    const platform = adapter?.platform ?? ''
    const identity = adapter?.identity ?? 'default'
    const masterId = (adapter?.config as { master?: string } | undefined)?.master

    const userId = String(session.userId)
    const channelId = session.channelId ? String(session.channelId) : undefined
    const isOwner = masterId ? userId === String(masterId) : false

    // 0. 网关判定（含顶层平台白名单与复合群聊拦截）
    const decision = gateway.evaluate(userId, channelId, rawMessage, platform, masterId)
    if (decision.reason === 'command_intercept' && decision.interceptResponse) return decision.interceptResponse
    if (!decision.allow) return next()

    if (!geminiClient) {
      return isOwner ? '欸？笨蛋大哥哥，你还没在配置里填 GEMINI_API_KEY 呢！快去填好再找我～' : next()
    }

    try {
      // OneBot 平台专属动态交互：收到消息时触发异步动作/指示
      if (platform === 'onebot' && typeof (adapter as any)?.call === 'function') {
        const onebot = adapter as any
        if (channelId)
          onebot.call('group_poke', { group_id: Number(channelId), user_id: Number(userId) }).catch(() => {})
        else onebot.call('friend_poke', { user_id: Number(userId) }).catch(() => {})
      }

      // 记忆作用域隔离（群聊物理隔离，主人认知全局统一于 __master__）
      const scopeKey = channelId ? `${platform}:group:${channelId}` : `${platform}:private:${userId}`
      const profileKey = isOwner ? '__master__' : `${platform}:${userId}`

      const abilityCtx = { userId, channelId, isOwner, message: rawMessage }
      const extraContexts = await abilityManager.aggregateContext(abilityCtx)
      extraContexts.push(...memory.assemblePromptContext(scopeKey, profileKey))

      // 动态组装带“多态躯壳偏置”的人格 Prompt
      const systemPrompt = buildSystemPrompt(
        { botName: cfg.botName, ownerNick: cfg.ownerNick, platform, identity },
        isOwner,
        extraContexts
      )
      const history = memory.getShortTerm(scopeKey)
      const reply = await geminiClient.chat(systemPrompt, history, rawMessage, abilityManager, abilityCtx)

      memory.recordTurn(scopeKey, profileKey, rawMessage, reply)

      // 拟人分句打字机发送
      const segments = cfg.enableHumanDelay ? splitSentences(reply) : [reply]
      if (segments.length > 1) {
        for (let i = 0; i < segments.length - 1; i++) {
          await session.send(segments[i])
          await delay(Math.min(1200, Math.max(400, segments[i].length * 40)))
        }
        return segments[segments.length - 1]
      }

      return reply
    } catch (err) {
      console.error('Chat-AI execution error:', err instanceof Error ? err.message : err)
      // 私聊对主人娇嗔抱怨报告异常，公开群聊保持绝对静默
      return isOwner
        ? `切，刚才脑子突然卡了一下（${err instanceof Error ? err.message : err}），本天才可没有出错！`
        : next()
    }
  })
}
