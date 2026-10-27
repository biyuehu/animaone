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
    .replace(/\[CQ:face,id=(\d+)[^\]]*\]/gi, '[表情:$1]')
}

export type GatewayDecision =
  | {
      readonly allow: true
      readonly reason: 'owner_direct' | 'group_direct' | 'group_casual' | 'group_followup'
      readonly cleanedMessage: string
    }
  | {
      readonly allow: false
      readonly reason: 'platform_rejected' | 'rejected'
    }

export const allowedDecision = (
  reason: 'owner_direct' | 'group_direct' | 'group_casual' | 'group_followup',
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
  /** 记录机器人最后一次在各群发言的时间戳，用于跟帖会话窗口判断 */
  private readonly lastBotSpeechTime: Map<string, number> = new Map()

  constructor(private readonly config: GatewayConfig) {}

  public recordBotSpeech(groupId: string): void {
    this.lastBotSpeechTime.set(groupId, Date.now())
  }

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

    if (
      !this.config.whitelistedGroups.includes(groupId) &&
      !this.config.whitelistedGroups.includes(`${platform}:${groupId}`)
    )
      return rejectedDecision('rejected')

    // 包含 [CQ:reply,id=...]，且该回复消息中通常伴随 [CQ:at,qq=机器人] 或直接针对机器人发言
    // TODO: reply id 是 message id
    const atCq = `[CQ:at,qq=${botSelfId}]`

    if (
      /\[CQ:reply,id=\d+\]/i.test(rawMessage) ||
      (atCq && rawMessage.includes(atCq)) ||
      rawMessage.includes(`@${botName}`) ||
      rawMessage.includes(botName)
    )
      return allowedDecision(
        'group_direct',
        sanitizeCqCodes(
          rawMessage
            .replace(/\[CQ:reply,id=\d+\]/gi, '')
            .replaceAll(atCq, '[艾特了你]')
            .replaceAll(`@${botName}`, '[艾特了你]')
            .trim() || '[艾特了你]'
        )
      )

    // 3. 水群跟帖判定（Follow-up Window）：
    // 若机器人在本群最近 45 秒内发过言，且群友紧接着发出有意义的回复（>= 2字），
    // 判定为群友顺着刚才的话题与机器人对话，直接放行，不再要求重复命中随机概率
    const lastTime = this.lastBotSpeechTime.get(groupId)
    if (lastTime && Date.now() - lastTime < 45_000 && rawMessage.trim().length >= 2)
      return allowedDecision('group_followup', sanitizeCqCodes(rawMessage))

    // 4. 普通偶发主动水群
    return rawMessage.length >= 6 && Math.random() < this.config.groupActiveRate
      ? allowedDecision('group_casual', sanitizeCqCodes(rawMessage))
      : rejectedDecision('rejected')
  }
}
