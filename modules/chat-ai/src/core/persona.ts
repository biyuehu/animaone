import type { Config } from '../index'

export interface PersonaRuntimeContext {
  readonly platform: string
  readonly identity: string
  readonly masterId: string
  readonly senderName: string
  readonly userId: string
  readonly groupId?: string
  readonly isOwner: boolean
  readonly birthTime: number
}

export function buildSystemPrompt(
  config: Config,
  runtime: PersonaRuntimeContext,
  extraContexts: string[] = []
): string {
  const replacePlaceholders = (text: string) =>
    text
      .replaceAll('{botName}', config.botName)
      .replaceAll('{ownerNick}', config.ownerNick)
      .replaceAll('{masterId}', runtime.masterId)
      .replaceAll('{userId}', runtime.userId)
      .replaceAll('{identity}', runtime.identity)
      .replaceAll('{platform}', runtime.platform)

  const parts: string[] = []

  // 1. 基础人设
  parts.push(`你叫${config.botName}`)
  parts.push(
    `对主人的默认基础称呼：${config.ownerNick}（注意：如果在下方【参考记忆与已知事实】中有主人最新要求或约定的具体称呼，必须优先遵从最新记忆事实）`
  )
  parts.push(replacePlaceholders(config.basePersona))

  // 2. 平台分化偏好
  const aspectBias = config.platformAspects[runtime.platform]
  if (aspectBias) parts.push(replacePlaceholders(aspectBias))

  // 3. 场景权限人设
  const isGroup = Boolean(runtime.groupId)
  parts.push(
    replacePlaceholders(runtime.isOwner ? (isGroup ? config.ownerGroup : config.ownerPrivate) : config.guestGroup)
  )

  // 4. 基础感知
  const ZONE = 'zh-CN'
  const now = new Date()
  parts.push(
    [
      '【基础感知】',
      `当前时间（${ZONE}）：${now.toLocaleString(ZONE, { hour12: false, timeZone: 'Asia/Shanghai' })}`,
      `自身诞生时间：${new Date(runtime.birthTime).toLocaleDateString(ZONE)}`,
      `诞生天数：${Math.floor((now.getTime() - runtime.birthTime) / (1000 * 60 * 60 * 24))}`,
      `接入平台：${runtime.platform} (实例：${runtime.identity})`,
      `对话环境：${isGroup ? `公开群聊 (Group ID：${runtime.groupId})` : '私聊环境 (Private)'}`,
      `当前对话者身份：${runtime.isOwner ? 'MASTER' : 'GROUP_MEMBER'} | 昵称：${runtime.senderName} | ID：${runtime.userId}`
    ].join('\n')
  )

  // 5. 记忆与核心事实（最高优先级，放在最后强化模型遵守）
  if (extraContexts.length > 0) {
    parts.push(
      [
        '【长期记忆与核心事实（最高优先级）】',
        '以下是关于对话者的确凿事实与历史约定。你必须严格遵从这些事实，包括但不限于对方的喜好、约定称呼、重要经历等：',
        ...extraContexts
      ].join('\n')
    )
  }

  return parts.join('\n\n').trim()
}
