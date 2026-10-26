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

  let parts: string = ''

  parts += `你叫${config.botName}\n对主人称呼：${config.ownerNick}\n${replacePlaceholders(config.basePersona)}`

  const aspectBias = config.platformAspects[runtime.platform]
  if (aspectBias) parts += replacePlaceholders(aspectBias)

  const isGroup = Boolean(runtime.groupId)
  parts += replacePlaceholders(
    runtime.isOwner ? (isGroup ? config.ownerGroup : config.ownerPrivate) : config.guestGroup
  )

  const ZONE = 'zh-CN'
  const now = new Date()
  parts += [
    '【基础感知】',
    `当前时间（${ZONE}）：${now.toLocaleString(ZONE, { hour12: false, timeZone: 'Asia/Shanghai' })}`,
    `自身诞生时间：${new Date(runtime.birthTime).toLocaleDateString(ZONE)}`,
    `诞生天数：${Math.floor((now.getTime() - runtime.birthTime) / (1000 * 60 * 60 * 24))}`,
    `接入平台${runtime.platform} (实例：${runtime.identity})`,
    `对话环境：${isGroup ? `公开群聊 (Group ID：${runtime.groupId})` : '私聊环境 (Private)'}`,
    `当前对话者身份：${runtime.isOwner ? 'MASTER' : 'GROUP'}${runtime.senderName}|ID：${runtime.masterId}`
  ].join('\n')

  if (extraContexts.length > 0) parts += `【当前对话背景与参考记忆】\n${extraContexts.map((c) => `- ${c}`).join('\n')}`

  return parts.trim()
}
