export interface GatewayDecision {
  readonly allow: boolean
  readonly reason: 'platform_rejected' | 'owner_direct' | 'group_direct' | 'group_casual' | 'rejected'
  readonly cleanedMessage?: string
}

export interface GatewayConfig {
  readonly whitelistedGroups: string[]
  readonly experimentGroups: string[]
  readonly experimentSampleRate: number
  readonly allowedPlatforms: string[]
}

export class MessageGateway {
  constructor(private readonly config: GatewayConfig) {}

  /**
   * 判定消息是否放行，并处理群聊中的艾特/提及与偶尔水群判定
   */
  public evaluate(
    userId: string,
    groupId: string | undefined,
    rawMessage: string,
    platform = '',
    masterId?: string,
    botSelfId?: string,
    botName = '露米'
  ): GatewayDecision {
    // 0. 顶层平台白名单拦截
    if (this.config.allowedPlatforms.length > 0 && (!platform || !this.config.allowedPlatforms.includes(platform))) {
      return { allow: false, reason: 'platform_rejected' }
    }

    // 认准当前 Adapter 的 master
    const isOwner = masterId ? String(userId) === String(masterId) : false

    // 1. 私聊逻辑：主人私聊直接放行，其他私聊直接忽略
    if (!groupId) {
      return isOwner
        ? { allow: true, reason: 'owner_direct', cleanedMessage: rawMessage }
        : { allow: false, reason: 'rejected' }
    }

    // 2. 检查是否在白名单群或实验群中
    const scopedGroupKey = `${platform}:${groupId}`
    const isWhitelisted =
      this.config.whitelistedGroups.includes(groupId) || this.config.whitelistedGroups.includes(scopedGroupKey)
    const isExperiment =
      this.config.experimentGroups.includes(groupId) || this.config.experimentGroups.includes(scopedGroupKey)
    if (!isWhitelisted && !isExperiment) {
      return { allow: false, reason: 'rejected' }
    }

    // 3. 检查群聊触发条件：是否艾特(CQ:at)或者显式提及名字
    const atCq = botSelfId ? `[CQ:at,qq=${botSelfId}]` : ''
    const hasAt = (atCq && rawMessage.includes(atCq)) || rawMessage.includes(`@${botName}`)
    const hasMention = rawMessage.includes(botName)

    if (hasAt || hasMention) {
      // 剥除艾特与开头的称呼，提取纯文本意图
      let cleaned = rawMessage
      if (atCq) cleaned = cleaned.replaceAll(atCq, '')
      cleaned = cleaned.replaceAll(`@${botName}`, '')
      cleaned = cleaned.trim()
      // 如果去掉艾特后为空，给一个打招呼默认文本
      if (!cleaned) cleaned = '你好呀'
      return { allow: true, reason: 'group_direct', cleanedMessage: cleaned }
    }

    // 4. 未被直接艾特或提及时：真实拟人“偶尔水群”机制 (5% 概率)
    // 过滤掉超短的无意义字符(如 "1", "ok")，只在有人讲正经话时偶尔参与讨论
    if (rawMessage.length >= 6 && Math.random() < this.config.experimentSampleRate) {
      return { allow: true, reason: 'group_casual', cleanedMessage: rawMessage }
    }

    return { allow: false, reason: 'rejected' }
  }
}
