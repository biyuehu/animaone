import type { Config } from '../index'
import { DEFAULT_TOP_PROMPT } from './constants'

export interface PersonaRuntimeContext {
  readonly platform: string
  readonly identity: string
  readonly masterId: string
  readonly senderName: string
  readonly userId: string
  readonly groupId?: string
  readonly isMaster: boolean
  readonly birthTime: number
}

export function buildSystemPrompt(
  config: Config,
  runtime: PersonaRuntimeContext,
  extraContexts: string[] = []
): string {
  const defaultBotName = config.botNames[0]
  const replacePlaceholders = (text: string) =>
    text
      .replaceAll('{botName}', defaultBotName)
      .replaceAll('{masterNick}', config.masterNick)
      .replaceAll('{masterId}', runtime.masterId)
      .replaceAll('{userId}', runtime.userId)
      .replaceAll('{identity}', runtime.identity)
      .replaceAll('{platform}', runtime.platform)

  const ZONE = 'zh-CN'
  const now = new Date()

  return [
    `你叫${defaultBotName}`,
    DEFAULT_TOP_PROMPT,
    `【核心灵魂人格】`,
    `对主人的默认基础称呼：${config.masterNick}（如果在下方【核心事实】中有主人最新要求或约定的具体称呼，必须优先遵从最新记忆事实）`,
    replacePlaceholders(config.basePersona),
    config.identityAspects[runtime.identity] ? replacePlaceholders(config.identityAspects[runtime.identity]) : null,
    replacePlaceholders(
      runtime.isMaster
        ? runtime.groupId
          ? `【群聊环境-与唯一主人对话】\n${config.masterGroup}`
          : `【私聊环境-与唯一主人对话】\n${config.masterPrivate}`
        : runtime.groupId
          ? `【群聊环境-与群成员对话】\n${config.memberGroup}`
          : `【私聊环境-与好友对话】\n${config.friendPrivate}`
    ),
    [
      '【基础感知】',
      `当前时间（${ZONE}）：${now.toLocaleString(ZONE, { hour12: false, timeZone: 'Asia/Shanghai' })}`,
      `自身诞生时间：${new Date(runtime.birthTime).toLocaleDateString(ZONE)}`,
      `诞生天数：${Math.floor((now.getTime() - runtime.birthTime) / (1000 * 60 * 60 * 24))}`,
      `平台实例名字：${runtime.identity}`,
      `接入平台：${runtime.platform}`,
      `对话环境：${runtime.groupId ? `群聊 (群 ID：${runtime.groupId})` : '私聊'}`,
      runtime.groupId
        ? '【群聊公屏流提示】上下文中带有 [成员: 昵称] 或 [主人: 昵称] 是你在群内旁听到的不同群成员真实公屏发言，你可以随时结合这些前文信息接梗、吐槽、回答或概括'
        : null,
      `当前对话者身份：${runtime.isMaster ? '主人' : runtime.groupId ? '群成员' : '好友'} | 昵称：${runtime.senderName} | ID：${runtime.userId}`
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
    .join('\n')
    .trim()
}
