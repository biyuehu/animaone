export interface GatewayDecision {
  readonly allow: boolean
  readonly reason:
    | 'platform_rejected'
    | 'owner_direct'
    | 'whitelisted_group'
    | 'experiment_sampled'
    | 'command_intercept'
    | 'rejected'
  readonly interceptResponse?: string
}

export interface GatewayConfig {
  readonly whitelistedGroups: string[]
  readonly experimentGroups: string[]
  readonly experimentSampleRate: number
  readonly allowedPlatforms: string[]
}

export class MessageGateway {
  constructor(private readonly config: GatewayConfig) {}

  public evaluate(userId: string, groupId?: string, platform = '', masterId?: string): GatewayDecision {
    // 0. 顶层平台白名单拦截
    if (this.config.allowedPlatforms.length > 0 && (!platform || !this.config.allowedPlatforms.includes(platform))) {
      return { allow: false, reason: 'platform_rejected' }
    }

    // 认准当前 Adapter 的 master（完全不写死 ownerId）
    const isOwner = masterId ? String(userId) === String(masterId) : false

    // 1. 私聊逻辑：主人私聊直接放行，其他私聊直接忽略
    if (!groupId) return isOwner ? { allow: true, reason: 'owner_direct' } : { allow: false, reason: 'rejected' }

    // 2. 群聊白名单检查（同时支持复合键 "platform:123" 或纯数字 "123"）
    const scopedGroupKey = `${platform}:${groupId}`
    if (this.config.whitelistedGroups.includes(groupId) || this.config.whitelistedGroups.includes(scopedGroupKey)) {
      return { allow: true, reason: 'whitelisted_group' }
    }

    // 3. 放养实验群概率抽样
    if (this.config.experimentGroups.includes(groupId) || this.config.experimentGroups.includes(scopedGroupKey)) {
      return Math.random() < this.config.experimentSampleRate
        ? { allow: true, reason: 'experiment_sampled' }
        : { allow: false, reason: 'rejected' }
    }

    // 4. 其他群聊硬拦截
    return { allow: false, reason: 'rejected' }
  }
}
