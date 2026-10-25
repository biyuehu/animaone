import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import { type Context, Symbols } from 'kotori-bot'
import { ProxyAgent, fetch as undiciFetch } from 'undici'
import type { HierarchicalMemoryService } from '../memory'
import type { Ability } from './index'

const execAsync = promisify(exec)

export const SILENT_SENTINEL = '__NO_REPLY__'

/**
 * 网页抓取与搜索工具
 */
export function createWebSearchOrFetchAbility(proxy?: string): Ability {
  return {
    name: 'web_search_or_fetch',
    description: '抓取指定 URL 网页的正文文本，或者通过 DuckDuckGo 搜索即时网络信息与摘要',
    toolDefinition: {
      ownerOnly: false,
      parameters: {
        type: 'OBJECT',
        properties: {
          url: { type: 'STRING', description: '需要直接抓取提取正文的完整网址（如 https://...）' },
          query: { type: 'STRING', description: '需要搜索的关键词短语（如果不指定 url 时使用）' }
        }
      },
      execute: async (args: { url?: string; query?: string }) => {
        let agent: ProxyAgent | undefined
        if (proxy) {
          const proxyUrl = proxy.startsWith('http') ? proxy : `http://${proxy}`
          agent = new ProxyAgent(proxyUrl)
        }

        // 1. 如果指定了 URL，直接抓取页面内容
        if (args.url) {
          try {
            const resp = await undiciFetch(args.url, {
              headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36' },
              dispatcher: agent
            })
            const html = await resp.text()
            // 简单剔除 script、style 与 html 标签，提取干净的正文前 2000 字
            const cleanText = html
              .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
              .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
              .replace(/<[^>]+>/g, ' ')
              .replace(/\s+/g, ' ')
              .trim()
              .slice(0, 2000)

            return { url: args.url, title: resp.statusText, content: cleanText || '未提取到正文内容' }
          } catch (e) {
            return { error: `网页抓取失败: ${e instanceof Error ? e.message : String(e)}` }
          }
        }

        // 2. 如果指定了 query，使用 DuckDuckGo Lite 进行即时搜索
        if (args.query) {
          try {
            const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(args.query)}`
            const resp = await undiciFetch(searchUrl, {
              headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36'
              },
              dispatcher: agent
            })
            const html = await resp.text()
            // 正则匹配提取搜索结果标题与摘要 snippet
            const snippetRegex = /<a class="result__snippet[^>]*>(.*?)<\/a>/g
            const snippets: string[] = []
            let match = snippetRegex.exec(html)
            while (match !== null && snippets.length < 4) {
              const text = match[1].replace(/<[^>]+>/g, '').trim()
              if (text) snippets.push(text)
              match = snippetRegex.exec(html)
            }

            if (snippets.length === 0) {
              // 备选纯文本兜底提取
              const fallback = html
                .replace(/<[^>]+>/g, ' ')
                .replace(/\s+/g, ' ')
                .slice(0, 1000)
              return { query: args.query, results: [fallback] }
            }

            return { query: args.query, results: snippets }
          } catch (e) {
            return { error: `搜索执行失败: ${e instanceof Error ? e.message : String(e)}` }
          }
        }

        return { error: '必须提供 url 或 query 参数' }
      }
    }
  }
}

/**
 * 1. 即刻记忆工具：主动沉淀事实到 SQLite user_profiles
 */
export function createRememberAbility(memory: HierarchicalMemoryService): Ability {
  return {
    name: 'remember_master_fact',
    description:
      '当主人告知其个人喜好、习惯、特征、重要事实或明确要求记住某事时，必须主动调用此工具立即持久化到数据库中',
    toolDefinition: {
      ownerOnly: true,
      parameters: {
        type: 'OBJECT',
        properties: {
          fact: { type: 'STRING', description: '提炼出的核心事实陈述，如：喜欢的水果是梨子' },
          category: {
            type: 'STRING',
            enum: ['preference', 'identity', 'event', 'relation'],
            description: '事实类别：preference(喜好), identity(身份), event(事件), relation(关系)'
          }
        },
        required: ['fact']
      },
      execute: async (args: { fact: string; category?: string }) => {
        const cat = (args.category ?? 'preference') as 'preference' | 'identity' | 'event' | 'relation'
        memory.getDatabase().upsertFact('__master__', args.fact, cat)
        return { success: true, message: `已成功把事实写入大哥哥的长期档案：${args.fact}` }
      }
    }
  }
}

/**
 * 2. 跨平台/分身灵魂穿梭：调取主人在其他平台或会话中的近期记忆与对话
 */
export function createCrossPlatformRecallAbility(memory: HierarchicalMemoryService): Ability {
  return {
    name: 'recall_cross_platform_chat',
    description: '主动穿梭查阅主人在其他平台终端（如 onebot、cmd）或最近会话中的聊天记录与记忆要点',
    toolDefinition: {
      ownerOnly: true,
      parameters: {
        type: 'OBJECT',
        properties: {
          targetPlatform: {
            type: 'STRING',
            description: '可选的目标平台名称，如 onebot、cmd。不传则返回所有已知平台的最近对话'
          },
          limit: { type: 'INTEGER', description: '获取的条数，默认 5' }
        }
      },
      execute: async (args: { targetPlatform?: string; limit?: number }) => {
        const limit = args.limit ?? 5
        // 从 memory_nodes 与 user_profiles 查阅跨域内容
        const nodes = memory.getDatabase().getAllRecentNodes(limit, args.targetPlatform)
        const facts = memory.getDatabase().getProfileFacts('__master__', 10)
        return {
          masterProfileFacts: facts,
          recentCrossPlatformNodes: nodes.map((n) => ({
            platform: n.scopeKey.split(':')[0],
            scope: n.scopeKey,
            summary: n.summary,
            tags: n.tags,
            time: new Date(n.endTime).toLocaleString('zh-CN')
          }))
        }
      }
    }
  }
}

/**
 * 3. 宿主机终端 Shell 执行能力
 */
export const terminalExecuteAbility: Ability = {
  name: 'execute_terminal_command',
  description: '在宿主机系统中执行 shell / terminal 命令并返回标准输出与错误（仅主人可用）',
  toolDefinition: {
    ownerOnly: true,
    parameters: {
      type: 'OBJECT',
      properties: {
        command: { type: 'STRING', description: '要执行的 terminal 命令，如 git status, dir, node -v' }
      },
      required: ['command']
    },
    execute: async (args: { command: string }) => {
      try {
        const { stdout, stderr } = await execAsync(args.command, { timeout: 15000, maxBuffer: 1024 * 512 })
        return { stdout: stdout.trim(), stderr: stderr.trim() }
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) }
      }
    }
  }
}

/**
 * 4. 拟人选择性沉默工具：在群聊偶尔插嘴、或对方无理取闹时，AI可主动选择“已读不回”
 */
export const silenceAbility: Ability = {
  name: 'choose_silence',
  description:
    '在群聊日常观察中，或者当你觉得不需要回复、不想搭理对方、觉得没必要插嘴时调用此工具。调用后你将保持沉默，不向聊天中发送任何消息。',
  toolDefinition: {
    ownerOnly: false,
    parameters: {
      type: 'OBJECT',
      properties: {
        reason: { type: 'STRING', description: '选择沉默不回复的原因' }
      }
    },
    execute: async (args: { reason?: string }) => ({ silent: true, reason: args.reason ?? '无话可说，保持沉默' })
  }
}

/**
 * 5. Kotori 框架内部联动能力：主动向指定群或好友投递消息
 */
export function createKotoriMessagingAbility(ctx: Context): Ability {
  return {
    name: 'kotori_send_message',
    description: '通过 Kotori 底层适配器主动向指定的群组或指定私聊投递一条消息',
    toolDefinition: {
      ownerOnly: true,
      parameters: {
        type: 'OBJECT',
        properties: {
          targetGroup: { type: 'STRING', description: '目标群号（如果是发到群里）' },
          targetUser: { type: 'STRING', description: '目标用户ID（如果是私聊）' },
          message: { type: 'STRING', description: '要投递的消息文本' }
        },
        required: ['message']
      },
      execute: async (args: { targetGroup?: string; targetUser?: string; message: string }) => {
        const botMap = ctx[Symbols.bot]
        let onebotApi: any = null

        if (botMap) {
          for (const apis of botMap.values()) {
            for (const api of apis) {
              if (api.adapter?.platform === 'onebot') {
                onebotApi = api
                break
              }
            }
            if (onebotApi) break
          }
        }

        if (!onebotApi) return { error: '未找到在线的 OneBot 适配器实例' }

        try {
          if (args.targetGroup) {
            await onebotApi.call('send_group_msg', {
              group_id: Number(args.targetGroup),
              message: args.message
            })
            return { success: true, message: `已成功投递消息至群 ${args.targetGroup}` }
          }
          if (args.targetUser) {
            await onebotApi.call('send_msg', {
              user_id: Number(args.targetUser),
              message: args.message
            })
            return { success: true, message: `已成功投递私聊消息至用户 ${args.targetUser}` }
          }
          return { error: '必须指定 targetGroup 或 targetUser' }
        } catch (e) {
          return { error: e instanceof Error ? e.message : String(e) }
        }
      }
    }
  }
}
