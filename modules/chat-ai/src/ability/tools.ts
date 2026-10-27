import { exec } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import type { OnebotApi } from '@kotori-bot/kotori-plugin-adapter-onebot'
import { type Api, type Context, Symbols } from 'kotori-bot'
import { ProxyAgent, fetch as undiciFetch } from 'undici'
import type { HierarchicalMemoryService } from '../memory'
import { parseScopeKey } from '../memory/scope'
import type { Ability, AbilityContext } from './index'

const execAsync = promisify(exec)

export const SILENT_SENTINEL = '__NO_REPLY__'

/**
 * 主动做梦灵感推演工具（仅主人可用）：
 * 主动从潜意识中随机抽取旧记忆碎片进行概念碰撞，产生新顿悟并沉淀为灵感
 */
export function createDreamReflectionAbility(memory: HierarchicalMemoryService): Ability {
  return {
    name: 'trigger_dream_reflection',
    description: '仅主人可用。主动闭上眼睛做梦发呆，从潜意识抽取过往经历进行联想与反思，寻找新的灵感与认知。',
    toolDefinition: {
      ownerOnly: true,
      parameters: { type: 'OBJECT', properties: {} },
      execute: async (_args, ctx: AbilityContext) => ({
        success: true,
        reflectionSpoken:
          (await memory.triggerDream(ctx.userId)) ?? '潜意识里稍微发了会儿呆，不过暂时没有形成特别鲜明的画面呢'
      })
    }
  }
}
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
        const agent = proxy ? new ProxyAgent(proxy.startsWith('http') ? proxy : `http://${proxy}`) : undefined

        if (args.url)
          try {
            const resp = await undiciFetch(args.url, {
              headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36' },
              dispatcher: agent,
              signal: AbortSignal.timeout(8000)
            })
            const html = await resp.text()
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

        // 2. 如果指定了 query，使用 DuckDuckGo Lite 进行即时搜索
        if (args.query)
          try {
            const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(args.query)}`
            const resp = await undiciFetch(searchUrl, {
              headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36'
              },
              dispatcher: agent,
              signal: AbortSignal.timeout(8000)
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

            if (snippets.length === 0)
              return {
                query: args.query,
                results: [
                  html
                    .replace(/<[^>]+>/g, ' ')
                    .replace(/\s+/g, ' ')
                    .slice(0, 1000)
                ]
              }

            return { query: args.query, results: snippets }
          } catch (e) {
            return { error: `搜索执行失败: ${e instanceof Error ? e.message : String(e)}` }
          }

        return { error: '必须提供 url 或 query 参数' }
      }
    }
  }
}

/**
 * 即刻记忆工具：主动沉淀事实到 SQLite user_profiles
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
          },
          visibility: {
            type: 'STRING',
            enum: ['public', 'private'],
            description: '公开属性：public(允许向群友透露的公开特征/爱好/技术栈), private(现实隐私/住址等绝密档案)'
          }
        },
        required: ['fact']
      },
      execute: async (args: { fact: string; category?: string; visibility?: string }, ctx?: AbilityContext) => {
        const cat = (args.category ?? 'preference') as 'preference' | 'identity' | 'event' | 'relation'
        const vis = args.visibility === 'public' ? 'public' : 'private'
        const sourceScope = ctx
          ? ctx.groupId
            ? `${ctx.platform}:group:${ctx.groupId}`
            : `${ctx.platform}:private:${ctx.userId}`
          : ''
        memory.getDatabase().upsertFact('__master__', args.fact, cat, vis, sourceScope)
        return { success: true, message: `已成功把事实写入大哥哥的长期档案：${args.fact} (${vis})` }
      }
    }
  }
}

/**
 * 跨平台/分身灵魂穿梭：调取在其他平台终端或最近会话中的聊天记录与记忆要点
 */
export function createCrossPlatformRecallAbility(memory: HierarchicalMemoryService): Ability {
  return {
    name: 'recall_cross_platform_chat',
    description: '主动穿梭查阅在其他平台终端（如 onebot、cmd）或最近会话中的聊天记录与记忆要点',
    toolDefinition: {
      ownerOnly: true,
      parameters: {
        type: 'OBJECT',
        properties: {
          targetPlatform: {
            type: 'STRING',
            description: '可选的目标平台名称，如 onebot、cmd。不传则返回所有已知平台的最近对话'
          },
          limit: { type: 'INTEGER', description: '获取的条数，默认 6' }
        }
      },
      execute: async (args: { targetPlatform?: string; limit?: number }) => {
        const limit = args.limit ?? 6
        // 1. 优先查阅跨平台最新发生的原话记录（无需等待10轮压缩）
        const recentChats = memory.getDatabase().getGlobalRecentMessages(limit, args.targetPlatform)
        // 2. 查阅长期沉淀的记忆节点与主人核心事实
        const nodes = memory.getDatabase().getAllRecentNodes(4, args.targetPlatform)
        const facts = memory.getDatabase().getProfileFacts('__master__', 10)
        return {
          latestRealtimeChats: recentChats.map((c) => {
            const scope = parseScopeKey(c.scope)
            const chatType = scope.type === 'group' ? 'GROUP' : 'PRIVATE'
            const platformTag = scope.platform.toUpperCase()
            const isOwner = c.userId === '__master__' || c.role === 'model'
            const senderTag = c.role === 'model' ? '[BOT]' : `[${c.senderName || 'User'}(${c.userId || 'unknown'})]`
            const ownerTag = c.role !== 'model' && isOwner ? '[OWNER]' : ''
            const line = `[${platformTag}][${chatType}]${senderTag}${ownerTag} ${c.content}`
            return {
              formatted: line,
              time: c.time
            }
          }),
          masterProfileFacts: facts,
          longTermMemorySummaries: nodes.map((n) => {
            const scope = parseScopeKey(n.scopeKey)
            const chatType = scope.type === 'group' ? 'GROUP' : 'PRIVATE'
            const platformTag = scope.platform.toUpperCase()
            return {
              formatted: `[${platformTag}][${chatType}] ${n.summary}`,
              time: new Date(n.endTime).toLocaleString('zh-CN')
            }
          })
        }
      }
    }
  }
}

/**
 * 主人全知记忆溯源（仅主人可用）：
 * 允许跨平台、跨群聊、跨私聊全局穿透，检索历史原话、事件总结以及深层沉淀的主人历史画像
 */
export function createSearchMasterOmniscientMemoriesAbility(memory: HierarchicalMemoryService): Ability {
  return {
    name: 'search_master_omniscient_memories',
    description:
      '仅主人可用。跨平台、跨所有群聊与私聊进行全知记忆检索。支持查阅过往原话、客观事件节点以及主人自身沉淀的历史画像与偏好设定。',
    toolDefinition: {
      ownerOnly: true,
      parameters: {
        type: 'OBJECT',
        properties: {
          query: {
            type: 'STRING',
            description: '检索关键词或自然语言描述（如：大学、某次提到的电脑配置等）'
          },
          targetPlatform: {
            type: 'STRING',
            description: '可选限定平台（如 onebot），不传则搜索全部平台'
          },
          limit: {
            type: 'INTEGER',
            description: '返回结果数量上限，默认 5'
          }
        },
        required: ['query']
      },
      execute: async (args: { query: string; targetPlatform?: string; limit?: number }) => {
        const limit = args.limit ?? 5
        const db = memory.getDatabase()

        // 1. 深度检索主人的历史全量画像（使用 refer2 分词重叠度 + 权重时序打分，不过滤 private）
        const matchedProfiles = db.searchProfileFacts('__master__', args.query, limit)

        // 2. 跨平台/跨群检索近期相关原话
        const allRecent = db.getGlobalRecentMessages(50, args.targetPlatform)
        const queryLower = args.query.toLowerCase()
        const matchedDialogues = allRecent
          .filter((msg) => msg.content.toLowerCase().includes(queryLower))
          .slice(0, limit)

        // 3. 全局检索事件总结节点并顺带沿 memory_links 遍历拓扑邻居
        const eventNodes = db.searchMemoryNodes('', args.query, limit)
        const startNodeIds = eventNodes.map((n) => n.id).filter((id): id is number => typeof id === 'number')
        const graphTraversal = db.traverseGraph(startNodeIds, 1, limit)

        return {
          masterProfileFacts: matchedProfiles.map((p) => ({
            id: p.id,
            fact: p.fact,
            category: p.category,
            visibility: p.visibility,
            lastUpdated: new Date(p.updatedAt).toLocaleDateString('zh-CN')
          })),
          dialogueHistory: matchedDialogues.map((d) => ({
            scope: d.scope,
            sender: `${d.senderName || '用户'}(${d.userId})`,
            role: d.role,
            content: d.content,
            time: d.time
          })),
          eventSummaries: eventNodes.map((n) => ({
            level: n.level,
            summary: n.summary,
            time: new Date(n.startTime).toLocaleDateString('zh-CN'),
            tags: n.tags
          })),
          associatedClues: graphTraversal.cluesToExplore,
          associatedContextNodes: graphTraversal.nodes.map((n) => ({
            summary: n.summary,
            tags: n.tags
          }))
        }
      }
    }
  }
}

/**
 * 频道公开记忆检索（群友与公开可用）：
 * 严格限制在当前群聊/当前私聊作用域内，仅允许检索本群事件原话与打了 public 标签的主人公开设定
 */
export function createSearchChannelPublicMemoriesAbility(memory: HierarchicalMemoryService): Ability {
  return {
    name: 'search_channel_public_memories',
    description:
      '翻阅当前群聊内发生过的公开历史对话与事件总结，也可检索关于大哥哥（主人）允许公开的对外人设。严格受本群作用域与隐私限制。',
    toolDefinition: {
      ownerOnly: false,
      parameters: {
        type: 'OBJECT',
        properties: {
          query: {
            type: 'STRING',
            description: '检索关键词或探索概念'
          },
          offset: {
            type: 'INTEGER',
            description: '偏移量，用于深入翻页'
          },
          limit: {
            type: 'INTEGER',
            description: '期望调取的条数，默认 5'
          }
        },
        required: ['query']
      },
      execute: async (args: { query: string; offset?: number; limit?: number }, ctx?: AbilityContext) => {
        const scopeKey = ctx ? `${ctx.platform}:${ctx.groupId ? `group:${ctx.groupId}` : `private:${ctx.userId}`}` : ''
        if (!scopeKey) return { error: '无法获取当前会话上下文' }

        const limit = args.limit ?? 5
        const db = memory.getDatabase()

        // 1. 严格限定在当前 scopeKey 下检索聊天原话
        const messages = db.searchDeepHistory(scopeKey, {
          keyword: args.query,
          offset: args.offset ?? 0,
          limit
        })

        // 2. 严格限定在当前 scopeKey 下检索事件总结与图谱
        const seedNodes = db.searchMemoryNodes(scopeKey, args.query, 3)
        const startIds = seedNodes.map((n) => n.id).filter((id): id is number => id !== undefined)
        const graphResult = db.traverseGraph(startIds, 2, 4)
        const combinedNodes = graphResult.nodes.length > 0 ? graphResult.nodes : seedNodes

        // 3. 仅允许检索打了 public 的公开主人人设（严格卡死 visibility = 'public'，且只返回对外偏好与身份）
        const publicProfiles = db
          .searchProfileFacts('__master__', args.query, 3, 'public')
          .filter((p) => p.category === 'identity' || p.category === 'preference')

        return {
          currentChannelDialogues: messages,
          currentChannelEvents: combinedNodes.map((n) => ({
            time: new Date(n.startTime).toLocaleDateString('zh-CN'),
            level: n.level,
            summary: n.summary,
            tags: n.tags
          })),
          masterPublicPersona: publicProfiles.map((p) => ({
            fact: p.fact,
            category: p.category
          })),
          cluesToExplore: graphResult.cluesToExplore
        }
      }
    }
  }
}

/**
 * 宿主机终端 Shell 执行能力
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
 * 专有文件系统读写能力（无命令行转义与编码问题）
 */
export const fileReadOrWriteAbility: Ability = {
  name: 'file_read_or_write',
  description:
    '安全读写工作区本地文件。写文件直接写入多行完整内容，无需命令行转义，避免平台编码与换行问题（仅主人可用）',
  toolDefinition: {
    ownerOnly: true,
    parameters: {
      type: 'OBJECT',
      properties: {
        action: { type: 'STRING', description: '操作类型: read 或 write' },
        filePath: { type: 'STRING', description: '相对或绝对文件路径，如 TODO.md, src/app.ts' },
        content: { type: 'STRING', description: '写入内容（write 必填）' },
        append: { type: 'BOOLEAN', description: '是否为追加模式（默认 false 为覆盖）' }
      },
      required: ['action', 'filePath']
    },
    execute: async (args: { action: 'read' | 'write'; filePath: string; content?: string; append?: boolean }) => {
      try {
        const targetPath = path.resolve(process.cwd(), args.filePath)
        if (args.action === 'read')
          return { success: true, filePath: args.filePath, content: await fs.readFile(targetPath, 'utf-8') }
        await fs.mkdir(path.dirname(targetPath), { recursive: true })
        if (args.append) await fs.appendFile(targetPath, args.content ?? '', 'utf-8')
        else await fs.writeFile(targetPath, args.content ?? '', 'utf-8')
        return { success: true, message: `已成功保存文件: ${args.filePath}` }
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) }
      }
    }
  }
}

/**
 * 拟人选择性沉默工具：在群聊偶尔插嘴、或对方无理取闹时，AI可主动选择“已读不回”
 */
export const silenceAbility: Ability = {
  name: 'choose_silence',
  description:
    '仅在无明确指名或偶发围观群聊时，如果你觉得群内话题与你无关、无需插嘴时调用此工具保持静默。注意：当有人明确艾特你、引用你的话或直接对你发起提问时，请正常友好作答，严禁随意滥用此工具已读不回。',
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
 * Kotori 框架内部联动能力：主动向指定实例与目标群或好友投递消息
 */
export function createKotoriMessagingAbility(ctx: Context): Ability {
  return {
    name: 'kotori_send_message',
    description: '通过 Kotori 底层适配器主动向指定的实例投递群消息或私聊消息',
    toolDefinition: {
      ownerOnly: true,
      parameters: {
        type: 'OBJECT',
        properties: {
          identity: {
            type: 'STRING',
            description: '目标适配器实例名称（如 lambda、cmd-test），不传则自动匹配当前在线的 OneBot 实例'
          },
          targetGroup: { type: 'STRING', description: '目标群号（如果是发到群里）' },
          targetUser: { type: 'STRING', description: '目标用户ID（如果是私聊）' },
          message: { type: 'STRING', description: '要投递的消息文本' }
        },
        required: ['message']
      },
      execute: async (
        args: { identity?: string; targetGroup?: string; targetUser?: string; message: string },
        abilityCtx: AbilityContext
      ) => {
        const botMap: Map<string, Set<Api>> = ctx[Symbols.bot]
        let targetApi: OnebotApi | null = null
        const targetIdentity = args.identity ?? abilityCtx.identity

        if (botMap)
          for (const apis of botMap.values()) {
            for (const api of apis) {
              if (targetIdentity && api.adapter.identity === targetIdentity) {
                targetApi = api as OnebotApi
                break
              }
              if (!targetApi && api.adapter.platform === 'onebot') targetApi = api as OnebotApi
            }
            if (targetApi && (!targetIdentity || targetApi.adapter.identity === targetIdentity)) break
          }

        if (!targetApi) return { error: `未找到匹配的适配器实例 (${targetIdentity || 'onebot'})` }

        try {
          if (args.targetGroup) {
            await targetApi.adapter.call('send_group_msg', {
              group_id: Number(args.targetGroup),
              message: args.message
            })
            return {
              success: true,
              message: `已通过实例 ${targetApi.adapter.identity} 成功投递消息至群 ${args.targetGroup}`
            }
          }
          if (args.targetUser) {
            await targetApi.adapter.call('send_msg', {
              user_id: Number(args.targetUser),
              message: args.message
            })
            return {
              success: true,
              message: `已通过实例 ${targetApi.adapter.identity} 成功投递私聊消息至用户 ${args.targetUser}`
            }
          }
          return { error: '必须指定 targetGroup 或 targetUser' }
        } catch (e) {
          return { error: e instanceof Error ? e.message : String(e) }
        }
      }
    }
  }
}
