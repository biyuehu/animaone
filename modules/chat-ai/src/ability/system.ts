import os from 'node:os'
import type { Ability } from './index'

interface SystemStatusArgs {
  readonly detail?: boolean
}

interface SystemStatusResult {
  readonly status: 'online'
  readonly cpuCores: number
  readonly memoryUsage: string
  readonly platform: NodeJS.Platform
  readonly uptimeSeconds: number
  readonly detailRequested: boolean
}

export const systemStatusAbility: Ability<SystemStatusArgs, SystemStatusResult> = {
  name: 'get_system_status',
  description: 'Query host OS CPU architecture, system load, remaining RAM, and uptime',
  provideContext: async () =>
    `[Host] OS: ${os.type()} ${os.arch()}, Free RAM: ${(os.freemem() / (1024 * 1024)).toFixed(0)}MB/${(os.totalmem() / (1024 * 1024)).toFixed(0)}MB, Uptime: ${(os.uptime() / 3600).toFixed(1)}h`,
  toolDefinition: {
    parameters: {
      type: 'OBJECT',
      properties: {
        detail: {
          type: 'BOOLEAN',
          description: 'Whether to return verbose diagnostic info'
        }
      }
    },
    execute: async (args) => ({
      status: 'online',
      cpuCores: os.cpus().length,
      memoryUsage: `${(os.freemem() / (1024 * 1024)).toFixed(1)}MB free / ${(os.totalmem() / (1024 * 1024)).toFixed(1)}MB total`,
      platform: os.platform(),
      uptimeSeconds: os.uptime(),
      detailRequested: Boolean(args?.detail)
    })
  }
}
