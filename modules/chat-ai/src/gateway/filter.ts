/**
 * 对 CQ 码进行安全精简与降维：
 * 保留语义相关的标签（如 [CQ:at,qq=...]、[CQ:face,id=...]、[CQ:image]、[CQ:record]），
 * 剔除极长的二进制 Hash、URL、fileid、rkey 等会被 LLM 安全审查判定为 PROHIBITED_CONTENT 的载荷数据。
 */
export function sanitizeCqCodes(message: string): string {
  return message
    .replace(/\[CQ:image,[^\]]*\]/gi, (match) => {
      // 提取可能有意义的 summary（如动画表情描述）
      const summaryMatch = match.match(/summary=([^,\]]+)/i)
      if (summaryMatch) {
        const decoded = summaryMatch[1].replace(/&#91;/g, '[').replace(/&#93;/g, ']')
        return `[图片:${decoded}]`
      }
      return '[图片]'
    })
    .replace(/\[CQ:record,[^\]]*\]/gi, '[语音]')
    .replace(/\[CQ:video,[^\]]*\]/gi, '[视频]')
    .replace(/\[CQ:face,id=(\d+)[^\]]*\]/gi, '[表情:$1]')
}

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

    if (!groupId)
      return isOwner ? allowedDecision('owner_direct', sanitizeCqCodes(rawMessage)) : rejectedDecision('rejected')

    const scopedGroupKey = `${platform}:${groupId}`
    if (!this.config.whitelistedGroups.includes(groupId) && !this.config.whitelistedGroups.includes(scopedGroupKey))
      return rejectedDecision('rejected')

    const atCq = botSelfId ? `[CQ:at,qq=${botSelfId}]` : ''

    if ((atCq && rawMessage.includes(atCq)) || rawMessage.includes(`@${botName}`) || rawMessage.includes(botName)) {
      let cleaned = rawMessage
      if (atCq) cleaned = cleaned.replaceAll(atCq, '')
      cleaned = cleaned.replaceAll(`@${botName}`, '').trim()
      return allowedDecision('group_direct', sanitizeCqCodes(cleaned))
    }

    return rawMessage.length >= 6 && Math.random() < this.config.groupActiveRate
      ? allowedDecision('group_casual', sanitizeCqCodes(rawMessage))
      : rejectedDecision('rejected')
  }
}
