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

  const ZONE = 'zh-CN'
  const now = new Date()

  return [
    `你叫${config.botName}`,
    `对主人的默认基础称呼：${config.ownerNick}（注意：如果在下方【参考记忆与已知事实】中有主人最新要求或约定的具体称呼，必须优先遵从最新记忆事实）`,
    replacePlaceholders(config.basePersona),
    config.platformAspects[runtime.platform] ? replacePlaceholders(config.platformAspects[runtime.platform]) : null,
    replacePlaceholders(
      runtime.isOwner ? (runtime.groupId ? config.ownerGroup : config.ownerPrivate) : config.guestGroup
    ),
    [
      '【基础感知】',
      `当前时间（${ZONE}）：${now.toLocaleString(ZONE, { hour12: false, timeZone: 'Asia/Shanghai' })}`,
      `自身诞生时间：${new Date(runtime.birthTime).toLocaleDateString(ZONE)}`,
      `诞生天数：${Math.floor((now.getTime() - runtime.birthTime) / (1000 * 60 * 60 * 24))}`,
      `接入平台：${runtime.platform} (实例：${runtime.identity})`,
      `对话环境：${runtime.groupId ? `公开群聊 (Group ID：${runtime.groupId})` : '私聊环境 (Private)'}`,
      runtime.groupId
        ? '【群聊公屏流提示】上下文中带有 [群员: 昵称] 或 [OWNER: 昵称] 是你在群内旁听到的不同群友真实公屏发言，你可以随时结合这些前文信息接梗、吐槽、回答或概括'
        : null,
      `当前对话者身份：${runtime.isOwner ? 'MASTER' : 'GROUP_MEMBER'} | 昵称：${runtime.senderName} | ID：${runtime.userId}`
    ]
      .filter(Boolean)
      .join('\n'),
    extraContexts.length > 0
      ? [
          '【长期记忆与核心事实（最高优先级）】',
          '以下是关于对话者的确凿事实与历史约定。你必须严格遵从这些事实，包括但不限于对方的喜好、约定称呼、重要经历等：',
          ...extraContexts
        ].join('\n')
      : null
  ]
    .filter(Boolean)
    .join('\n\n')
    .trim()
}
