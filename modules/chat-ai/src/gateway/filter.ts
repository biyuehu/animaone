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
  readonly commandPrefix: string
  readonly allowedPlatforms: string[]
}

export class MessageGateway {
  constructor(private readonly config: GatewayConfig) {}

  public evaluate(userId: string, channelId?: string, message = '', platform = '', masterId?: string): GatewayDecision {
    // 0. 顶层平台白名单拦截
    if (this.config.allowedPlatforms.length > 0 && (!platform || !this.config.allowedPlatforms.includes(platform))) {
      return { allow: false, reason: 'platform_rejected' }
    }

    // 认准当前 Adapter 的 master（完全不写死 ownerId）
    const isOwner = masterId ? String(userId) === String(masterId) : false

    // 1. 确定性机械命令截流（0 Token）
    if (message.startsWith(this.config.commandPrefix)) {
      const cmd = message.slice(this.config.commandPrefix.length).trim().toLowerCase()
      if (cmd === 'ping')
        return { allow: false, reason: 'command_intercept', interceptResponse: 'pong! 本天才一直都在线呢～' }
      if (cmd === 'status')
        return { allow: false, reason: 'command_intercept', interceptResponse: '运行正常，随时待命！' }
    }

    // 2. 私聊逻辑：主人私聊直接放行，其他私聊直接忽略
    if (!channelId) return isOwner ? { allow: true, reason: 'owner_direct' } : { allow: false, reason: 'rejected' }

    // 3. 群聊白名单检查（同时支持复合键 "platform:123" 或纯数字 "123"）
    const scopedGroupKey = `${platform}:${channelId}`
    if (this.config.whitelistedGroups.includes(channelId) || this.config.whitelistedGroups.includes(scopedGroupKey)) {
      return { allow: true, reason: 'whitelisted_group' }
    }

    // 4. 放养实验群概率抽样
    if (this.config.experimentGroups.includes(channelId) || this.config.experimentGroups.includes(scopedGroupKey)) {
      return Math.random() < this.config.experimentSampleRate
        ? { allow: true, reason: 'experiment_sampled' }
        : { allow: false, reason: 'rejected' }
    }

    // 5. 其他群聊硬拦截
    return { allow: false, reason: 'rejected' }
  }
}
