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
  ownerId: Tsu.String().default('3105896973'),
  whitelistedGroups: Tsu.Array(Tsu.String()).default([]),
  experimentGroups: Tsu.Array(Tsu.String()).default([]),
  experimentSampleRate: Tsu.Number().range(0, 1).default(0.05),
  commandPrefix: Tsu.String().default('/'),
  botName: Tsu.String().default('露米 (Romi)'),
  ownerNick: Tsu.String().default('大哥哥'),
  enableHumanDelay: Tsu.Boolean().default(true)
})

type Config = Tsu.infer<typeof config>

export function main(ctx: Context, cfg: Config) {
  const gateway = new MessageGateway({
    ownerId: cfg.ownerId,
    whitelistedGroups: cfg.whitelistedGroups,
    experimentGroups: cfg.experimentGroups,
    experimentSampleRate: cfg.experimentSampleRate,
    commandPrefix: cfg.commandPrefix
  })

  const memory = new HierarchicalMemoryService(cfg.apiKey)
  const abilityManager = new AbilityManager()
  abilityManager.register(systemStatusAbility)

  const geminiClient = cfg.apiKey ? new GeminiClient({ apiKey: cfg.apiKey }) : null

  ctx.midware(async (next, session) => {
    const rawMessage = session.message?.trim()
    if (!rawMessage) return next()

    const userId = String(session.userId)
    const channelId = session.channelId ? String(session.channelId) : undefined
    const isOwner = userId === String(cfg.ownerId)

    const decision = gateway.evaluate(userId, channelId, rawMessage)
    if (decision.reason === 'command_intercept' && decision.interceptResponse) return decision.interceptResponse
    if (!decision.allow) return next()

    if (!geminiClient) {
      return isOwner ? '欸？笨蛋大哥哥，你还没在配置里填 GEMINI_API_KEY 呢！快去填好再找我～' : next()
    }

    try {
      const scopeKey = channelId ? `group:${channelId}` : `private:${userId}`
      const abilityCtx = { userId, channelId, isOwner, message: rawMessage }
      const extraContexts = await abilityManager.aggregateContext(abilityCtx)
      extraContexts.push(...memory.assemblePromptContext(scopeKey, userId))

      const systemPrompt = buildSystemPrompt({ botName: cfg.botName, ownerNick: cfg.ownerNick }, isOwner, extraContexts)
      const history = memory.getShortTerm(scopeKey)
      const reply = await geminiClient.chat(systemPrompt, history, rawMessage, abilityManager, abilityCtx)

      memory.recordTurn(scopeKey, userId, rawMessage, reply)

      // 拟人分句与打字机节奏发送
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
      return isOwner
        ? `切，刚才脑子突然卡了一下（${err instanceof Error ? err.message : err}），本天才可没有出错！`
        : next()
    }
  })
}
