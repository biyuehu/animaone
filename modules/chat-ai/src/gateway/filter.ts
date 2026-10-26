export type GatewayDecision =
  | {
      readonly allow: true
      readonly reason: 'owner_direct' | 'group_direct' | 'group_casual'
      readonly cleanedMessage: string
    }
  | {
      readonly allow: false
      readonly reason: 'platform_rejected' | 'rejected'
    }

export const allowedDecision = (
  reason: 'owner_direct' | 'group_direct' | 'group_casual',
  cleanedMessage: string
): GatewayDecision => ({
  allow: true,
  reason,
  cleanedMessage
})

export const rejectedDecision = (reason: 'platform_rejected' | 'rejected' = 'rejected'): GatewayDecision => ({
  allow: false,
  reason
})

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
      return rejectedDecision('platform_rejected')

    const isOwner = masterId ? String(userId) === String(masterId) : false

    if (!groupId) return isOwner ? allowedDecision('owner_direct', rawMessage) : rejectedDecision('rejected')

    const scopedGroupKey = `${platform}:${groupId}`
    if (!this.config.whitelistedGroups.includes(groupId) && !this.config.whitelistedGroups.includes(scopedGroupKey))
      return rejectedDecision('rejected')

    const atCq = botSelfId ? `[CQ:at,qq=${botSelfId}]` : ''

    if ((atCq && rawMessage.includes(atCq)) || rawMessage.includes(`@${botName}`) || rawMessage.includes(botName)) {
      let cleaned = rawMessage
      if (atCq) cleaned = cleaned.replaceAll(atCq, '')
      cleaned = cleaned.replaceAll(`@${botName}`, '').trim()
      return allowedDecision('group_direct', cleaned)
    }

    return rawMessage.length >= 6 && Math.random() < this.config.groupActiveRate
      ? allowedDecision('group_casual', rawMessage)
      : rejectedDecision('rejected')
  }
}
