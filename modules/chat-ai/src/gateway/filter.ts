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
    .replace(/\[CQ:at,qq=(.*?)\]/gi, '@$1')
  // .replace(/\[CQ:[a-z]+,[^\]]*\]/gi, '')
}

export type GatewayDecision =
  | {
      readonly allow: true
      readonly reason: 'owner_direct' | 'group_direct' | 'group_casual' | 'group_followup'
      readonly cleanedMessage: string
      readonly needTargetUser?: boolean
      readonly replyId?: string
    }
  | {
      readonly allow: false
      readonly reason: 'platform_rejected' | 'rejected'
    }

export const allowedDecision = (
  reason: 'owner_direct' | 'group_direct' | 'group_casual' | 'group_followup',
  cleanedMessage: string,
  needTargetUser = false,
  replyId?: string
): GatewayDecision => ({
  allow: true,
  reason,
  cleanedMessage,
  needTargetUser,
  replyId
})

export const rejectedDecision = (reason: 'platform_rejected' | 'rejected' = 'rejected'): GatewayDecision => ({
  allow: false,
  reason
})

export interface GatewayConfig {
  readonly whitelistedGroups: string[]
  readonly groupActiveRate: number
  readonly allowedPlatforms: string[]
  readonly followupWindow?: number
  readonly burstThreshold?: number
}

export class MessageGateway {
  /** 记录机器人最后一次在各群发言的时间戳，用于跟帖会话窗口判断 */
  private readonly lastBotSpeechTime: Map<string, number> = new Map()
  /** 记录各群在滑动窗口时间内的消息时间戳，用于判定群聊是否消息过密 */
  private readonly recentMsgTimestamps: Map<string, number[]> = new Map()

  constructor(private readonly config: GatewayConfig) {}

  public recordBotSpeech(groupId: string): void {
    this.lastBotSpeechTime.set(groupId, Date.now())
  }

  public evaluate(
    userId: string,
    groupId: string | undefined,
    rawMessage: string,
    platform: string,
    masterId: string,
    botSelfId: string,
    botName: string
  ): GatewayDecision {
    if (this.config.allowedPlatforms.length > 0 && (!platform || !this.config.allowedPlatforms.includes(platform)))
      return rejectedDecision('platform_rejected')

    if (!groupId)
      return masterId && String(userId) === String(masterId)
        ? allowedDecision('owner_direct', sanitizeCqCodes(rawMessage))
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
    const isChatBurst = timestamps.length >= (this.config.burstThreshold ?? 8)

    const replyMatch = rawMessage.match(/\[CQ:reply,id=(\d+)\]/i)
    const atCq = botSelfId ? `[CQ:at,qq=${botSelfId}]` : ''
    const isAtMe = (atCq && rawMessage.includes(atCq)) || (botSelfId && rawMessage.includes(`@${botSelfId}`))
    if (replyMatch || isAtMe || rawMessage.includes(`@${botName}`) || rawMessage.includes(botName))
      return allowedDecision(
        'group_direct',
        sanitizeCqCodes(
          rawMessage
            .replace(/\[CQ:reply,id=\d+\]/gi, '')
            .replaceAll(atCq, '')
            .replaceAll(`@${botSelfId}`, '')
            .replaceAll(`@${botName}`, '')
            .trim() || '[艾特了你]'
        ),
        isChatBurst,
        replyMatch?.[1]
      )

    // 3. 水群跟帖判定（Follow-up Window）：
    // 若机器人在本群最近指定窗口时间内发过言，且群友紧接着发出有意义的回复（>= 2字），
    // 判定为群友顺着刚才的话题与机器人对话，直接放行，不再要求重复命中随机概率
    const lastTime = this.lastBotSpeechTime.get(groupId)
    const followupMs = (this.config.followupWindow ?? 45) * 1000
    if (lastTime && now - lastTime < followupMs && rawMessage.trim().length >= 2)
      return allowedDecision('group_followup', sanitizeCqCodes(rawMessage), isChatBurst)

    // 4. 普通偶发主动水群
    return rawMessage.length >= 6 && Math.random() < this.config.groupActiveRate
      ? allowedDecision('group_casual', sanitizeCqCodes(rawMessage), isChatBurst)
      : rejectedDecision('rejected')
  }
}
