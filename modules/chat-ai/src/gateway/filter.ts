export interface GatewayDecision {
  allow: boolean
  reason: 'owner_direct' | 'whitelisted_group' | 'experiment_sampled' | 'command_intercept' | 'rejected'
  interceptResponse?: string
}

export interface GatewayConfig {
  ownerId: string
  whitelistedGroups: string[]
  experimentGroups: string[]
  experimentSampleRate: number // 默认 0.05 (5%)
  commandPrefix: string
}

export class MessageGateway {
  constructor(private readonly config: GatewayConfig) {}

  evaluate(userId: string, channelId?: string, message: string = ''): GatewayDecision {
    const isOwner = String(userId) === String(this.config.ownerId)

    // 1. 确定性机械命令截流（0 Token，优先秒杀）
    if (message.startsWith(this.config.commandPrefix)) {
      const cmd = message.slice(this.config.commandPrefix.length).trim().toLowerCase()
      if (cmd === 'ping') {
        return { allow: false, reason: 'command_intercept', interceptResponse: 'pong! 本天才一直都在线呢～' }
      }
      if (cmd === 'status') {
        return { allow: false, reason: 'command_intercept', interceptResponse: '运行正常，随时待命！' }
      }
    }

    // 2. 私聊逻辑
    if (!channelId) {
      if (isOwner) {
        return { allow: true, reason: 'owner_direct' }
      }
      // 普通私聊直接忽略，0 消耗
      return { allow: false, reason: 'rejected' }
    }

    // 3. 群聊白名单检查
    if (this.config.whitelistedGroups.includes(channelId)) {
      return { allow: true, reason: 'whitelisted_group' }
    }

    // 4. 放养实验群概率抽样
    if (this.config.experimentGroups.includes(channelId)) {
      const sampled = Math.random() < this.config.experimentSampleRate
      return sampled ? { allow: true, reason: 'experiment_sampled' } : { allow: false, reason: 'rejected' }
    }

    // 5. 其他群聊硬拦截
    return { allow: false, reason: 'rejected' }
  }
}
