/**
 * 对 CQ 码进行安全精简与降维：
 * 保留语义相关的标签（如 [CQ:at,qq=...]、[CQ:face,id=...]、[CQ:image]、[CQ:record]），
 * 剔除极长的二进制 Hash、URL、fileid、rkey 等会被 LLM 安全审查判定为 PROHIBITED_CONTENT 的载荷数据。
 */
export function sanitizeCqCodes(message: string): string {
  return message
    .replace(/\[CQ:image,[^\]]*\]/gi, (match) => {
      const summaryMatch = match.match(/summary=([^,\]]+)/i)
      return summaryMatch ? `[图片:${summaryMatch[1].replace(/&#91;/g, '[').replace(/&#93;/g, ']')}]` : '[图片]'
    })
    .replace(/\[CQ:record,[^\]]*\]/gi, '[语音]')
    .replace(/\[CQ:video,[^\]]*\]/gi, '[视频]')
    .replace(/\[CQ:face,[^\]]*\]/gi, '[表情]')
    .replace(/\[CQ:at,qq=(.*?)\]/gi, '@$1(其他人)')
  // .replace(/\[CQ:[a-z]+,[^\]]*\]/gi, '')
}

export type GatewayDecision =
  | {
      readonly allow: true
      readonly reason: 'master_direct' | 'group_direct' | 'group_casual' | 'group_followup'
      readonly cleanedMessage: string
      readonly needTargetUser?: boolean
      readonly replyId?: string
    }
  | {
      readonly allow: false
      readonly reason: 'platform_rejected' | 'rejected'
    }

export const allowedDecision = (
  reason: 'master_direct' | 'group_direct' | 'group_casual' | 'group_followup',
  cleanedMessage: string,
  needTargetUser?: boolean,
  replyId?: string
): GatewayDecision => ({
  allow: true,
  reason,
  cleanedMessage,
  needTargetUser,
  replyId
})

export const rejectedDecision = (reason: 'platform_rejected' | 'rejected'): GatewayDecision => ({
  allow: false,
  reason
})

export interface GatewayConfig {
  readonly whitelistedGroups: string[]
  readonly groupActiveRate: number
  readonly allowedPlatforms: string[]
  readonly followupWindow: number
  readonly burstThreshold: number
}

export class MessageGateway {
  private readonly lastCasualSpeechTime: Map<string, number> = new Map()
  private readonly recentMsgTimestamps: Map<string, number[]> = new Map()

  constructor(private readonly config: GatewayConfig) {}

  public recordCasualSpeech(groupId: string): void {
    this.lastCasualSpeechTime.set(groupId, Date.now())
  }

  public evaluate(
    userId: string,
    groupId: string | undefined,
    rawMessage: string,
    platform: string,
    masterId: string,
    botSelfId: string,
    botNames: string[]
  ): GatewayDecision {
    if (this.config.allowedPlatforms.length > 0 && (!platform || !this.config.allowedPlatforms.includes(platform)))
      return rejectedDecision('platform_rejected')

    if (!groupId)
      return masterId && String(userId) === String(masterId)
        ? allowedDecision('master_direct', sanitizeCqCodes(rawMessage))
        : rejectedDecision('rejected')

    if (
      !this.config.whitelistedGroups.includes(groupId) &&
      !this.config.whitelistedGroups.includes(`${platform}:${groupId}`)
    )
      return rejectedDecision('rejected')

    const now = Date.now()
    const timestamps = (this.recentMsgTimestamps.get(groupId) ?? []).filter((t) => now - t < 60_000)
    timestamps.push(now)
    this.recentMsgTimestamps.set(groupId, timestamps)
    const isChatBurst = timestamps.length >= this.config.burstThreshold

    const replyId = rawMessage.match(/\[CQ:reply,id=(\d+)\]/i)?.[1]

    const atCq = botSelfId ? `[CQ:at,qq=${botSelfId}]` : ''
    if (
      (atCq && rawMessage.includes(atCq)) ||
      (botSelfId && rawMessage.includes(`@${botSelfId}`)) ||
      botNames.some((name) => rawMessage.includes(name) || rawMessage.includes(`@${name}`))
    ) {
      let cleaned = rawMessage
        .replace(/\[CQ:reply,id=\d+\]/gi, '')
        .replaceAll(atCq, '')
        .replaceAll(`@${botSelfId}`, '')
      for (const name of botNames) cleaned = cleaned.replaceAll(`@${name}`, '')
      return allowedDecision(
        'group_direct',
        sanitizeCqCodes(cleaned.trim() || '[艾特了你]'),
        isChatBurst || Math.random() > 0.35,
        replyId
      )
    }

    const lastTime = this.lastCasualSpeechTime.get(groupId)
    if (lastTime && now - lastTime < this.config.followupWindow * 1000 && rawMessage.trim().length >= 2)
      return allowedDecision('group_followup', sanitizeCqCodes(rawMessage), isChatBurst, replyId)

    return rawMessage.length >= 6 && Math.random() < this.config.groupActiveRate
      ? allowedDecision('group_casual', sanitizeCqCodes(rawMessage), isChatBurst, replyId)
      : rejectedDecision('rejected')
  }
}
