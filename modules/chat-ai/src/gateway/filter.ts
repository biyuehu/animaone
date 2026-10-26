export interface GatewayDecision {
  readonly allow: boolean
  readonly reason: 'platform_rejected' | 'owner_direct' | 'group_direct' | 'group_casual' | 'rejected'
  readonly cleanedMessage?: string
}

export interface GatewayConfig {
  readonly whitelistedGroups: string[]
  readonly groupActiveRate: number
  readonly allowedPlatforms: string[]
}

export class MessageGateway {
  constructor(private readonly config: GatewayConfig) {}

  public evaluate(
    userId: string,
    groupId: string | undefined,
    rawMessage: string,
    platform = '',
    masterId: string,
    botSelfId: string,
    botName: string
  ): GatewayDecision {
    if (this.config.allowedPlatforms.length > 0 && (!platform || !this.config.allowedPlatforms.includes(platform)))
      return { allow: false, reason: 'platform_rejected' }

    const isOwner = masterId ? String(userId) === String(masterId) : false

    if (!groupId)
      return isOwner
        ? { allow: true, reason: 'owner_direct', cleanedMessage: rawMessage }
        : { allow: false, reason: 'rejected' }

    const scopedGroupKey = `${platform}:${groupId}`
    if (!this.config.whitelistedGroups.includes(groupId) && !this.config.whitelistedGroups.includes(scopedGroupKey))
      return { allow: false, reason: 'rejected' }

    const atCq = botSelfId ? `[CQ:at,qq=${botSelfId}]` : ''

    if ((atCq && rawMessage.includes(atCq)) || rawMessage.includes(`@${botName}`) || rawMessage.includes(botName)) {
      let cleaned = rawMessage
      if (atCq) cleaned = cleaned.replaceAll(atCq, '')
      cleaned = cleaned.replaceAll(`@${botName}`, '').trim()
      return { allow: true, reason: 'group_direct', cleanedMessage: cleaned }
    }

    return rawMessage.length >= 6 && Math.random() < this.config.groupActiveRate
      ? { allow: false, reason: 'rejected' }
      : { allow: true, reason: 'group_casual', cleanedMessage: rawMessage }
  }
}
