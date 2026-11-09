/**
 * 对 CQ 码进行安全精简与降维：
 * 保留语义相关的标签（如 [CQ:at,qq=...]、[CQ:face,id=...]、[CQ:image]、[CQ:record]），
 * 剔除极长的二进制 Hash、URL、fileid、rkey 等会被 LLM 安全审查判定为 PROHIBITED_CONTENT 的载荷数据。
 */
export function sanitizeCqCodes(message: string): string {
  return message
    .replace(/\[CQ:reply,id=-?\d+\]/gi, '')
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
      readonly reason: 'master_direct' | 'friend_direct' | 'group_direct' | 'group_casual' | 'group_followup'
      readonly cleanedMessage: string
      readonly needTargetUser?: boolean
      readonly replyId?: string
    }
  | {
      readonly allow: false
      readonly reason: 'platform_rejected' | 'rejected'
    }

export const allowedDecision = (
  reason: 'master_direct' | 'friend_direct' | 'group_direct' | 'group_casual' | 'group_followup',
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
  readonly allowedInstances: string[]
  readonly followupWindow: number
  readonly burstThreshold: number
  readonly allowFriendPrivate: boolean
}

export class MessageGateway {
  private readonly lastCasualSpeechTime: Map<string, number> = new Map()
  private readonly recentMsgTimestamps: Map<string, number[]> = new Map()
  private readonly calmUntil: Map<string, number> = new Map()
  private readonly shutUntil: Map<string, number> = new Map()

  constructor(private readonly config: GatewayConfig) {}

  public recordCasualSpeech(groupId: string): void {
    if (this.isCalmed(groupId)) return
    this.lastCasualSpeechTime.set(groupId, Date.now())
  }

  public calm(scope: string, durationSec?: number): number {
    const duration = (durationSec && durationSec > 0 ? durationSec : this.config.followupWindow) * 1000
    this.lastCasualSpeechTime.delete(scope)
    this.calmUntil.set(scope, Date.now() + duration)
    return Math.round(duration / 1000)
  }

  public isCalmed(scope: string): boolean {
    const until = this.calmUntil.get(scope)
    if (!until) return false
    if (Date.now() >= until) {
      this.calmUntil.delete(scope)
      return false
    }
    return true
  }

  public shut(scope: string, durationSec = 600): number {
    if (durationSec <= 0) {
      this.shutUntil.delete(scope)
      return 0
    }
    const duration = durationSec * 1000
    this.lastCasualSpeechTime.delete(scope)
    this.shutUntil.set(scope, Date.now() + duration)
    return durationSec
  }

  public isShut(scope: string): boolean {
    const until = this.shutUntil.get(scope)
    if (!until) return false
    if (Date.now() >= until) {
      this.shutUntil.delete(scope)
      return false
    }
    return true
  }

  public evaluate(
    userId: string,
    groupId: string | undefined,
    rawMessage: string,
    platform: string,
    identity: string,
    masterId: string,
    botSelfId: string,
    botNames: string[]
  ): GatewayDecision {
    if (this.config.allowedInstances.length > 0 && (!identity || !this.config.allowedInstances.includes(identity)))
      return rejectedDecision('platform_rejected')

    const currentScope = groupId ? `${identity}:${groupId}` : `${identity}:${userId}`
    if (this.isShut(currentScope) || (groupId && this.isShut(groupId))) {
      return rejectedDecision('rejected')
    }

    if (!groupId) {
      const replyId = rawMessage.match(/\[CQ:reply,id=(-?\d+)\]/i)?.[1]
      if (masterId && String(userId) === String(masterId))
        return allowedDecision('master_direct', sanitizeCqCodes(rawMessage), false, replyId)
      return this.config.allowFriendPrivate
        ? allowedDecision('friend_direct', sanitizeCqCodes(rawMessage), false, replyId)
        : rejectedDecision('rejected')
    }

    if (
      !this.config.whitelistedGroups.includes(groupId) &&
      !this.config.whitelistedGroups.includes(`${platform}:${groupId}`) &&
      !this.config.whitelistedGroups.includes(`${identity}:${groupId}`)
    )
      return rejectedDecision('rejected')

    const now = Date.now()
    const timestamps = (this.recentMsgTimestamps.get(groupId) ?? []).filter((t) => now - t < 60_000)
    timestamps.push(now)
    this.recentMsgTimestamps.set(groupId, timestamps)
    const isChatBurst = timestamps.length >= this.config.burstThreshold

    const replyId = rawMessage.match(/\[CQ:reply,id=(-?\d+)\]/i)?.[1]

    const atCq = botSelfId ? `[CQ:at,qq=${botSelfId}]` : ''
    if (
      (atCq && rawMessage.includes(atCq)) ||
      (botSelfId && rawMessage.includes(`@${botSelfId}`)) ||
      botNames.some((name) => rawMessage.includes(name) || rawMessage.includes(`@${name}`))
    ) {
      let cleaned = rawMessage
        .replace(/\[CQ:reply,id=-?\d+\]/gi, '')
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

    const scopeKey = `${identity}:${groupId}`
    const isCalm = this.isCalmed(scopeKey) || this.isCalmed(groupId)

    const lastTime = this.lastCasualSpeechTime.get(groupId) ?? this.lastCasualSpeechTime.get(scopeKey)
    if (!isCalm && lastTime && now - lastTime < this.config.followupWindow * 1000 && rawMessage.trim().length >= 2)
      return allowedDecision('group_followup', sanitizeCqCodes(rawMessage), false, replyId)

    return !isCalm && rawMessage.length >= 6 && Math.random() < this.config.groupActiveRate
      ? allowedDecision('group_casual', sanitizeCqCodes(rawMessage), false, replyId)
      : rejectedDecision('rejected')
  }
}
