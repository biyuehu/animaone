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

export function createDreamReflectionAbility(memory: HierarchicalMemoryService, cooldownSeconds = 900): Ability {
  let lastDreamTime = 0

  return {
    name: 'trigger_dream_reflection',
    description:
      '仅主人可用。当主人要求你“做个梦”、“做梦看看”、“发呆沉思”、“找找灵感”或需要进行潜意识联想顿悟时，必须主动调用此工具触发真实梦境反射。工具会从过往事件中碰撞出新概念和台词供你回答。严禁不调工具凭空编造虚假梦境。',
    toolDefinition: {
      masterOnly: true,
      parameters: { type: 'OBJECT', properties: {} },
      execute: async (_args, ctx: AbilityContext) => {
        const now = Date.now()
        const elapsed = (now - lastDreamTime) / 1000
        if (elapsed < cooldownSeconds) {
          const waitMinutes = Math.ceil((cooldownSeconds - elapsed) / 60)
          return {
            success: false,
            message: `做梦技能正在冷却中（还需等待 ${waitMinutes} 分钟）。`
          }
        }

        lastDreamTime = now
        const res = await memory.triggerDream(ctx.userId)
        if (!res) {
          return {
            success: false,
            message: '当前事件记忆不足2条，暂时无法做梦。'
          }
        }

        return {
          success: true,
          concept: res.concept,
          learnedFact: res.learnedFact,
          connectedMemoryA: res.nodeA.summary,
          connectedMemoryB: res.nodeB.summary,
          reflectionSpoken: res.spoken || '灵感闪过，但暂时没有想到合适吐槽的话呢'
        }
      }
    }
  }
}

export function createWebSearchOrFetchAbility(proxy?: string): Ability {
  return {
    name: 'web_search_or_fetch',
    description: '抓取指定 URL 网页的正文文本，或者通过 DuckDuckGo 搜索即时网络信息与摘要',
    toolDefinition: {
      masterOnly: false,
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

export function createRememberAbility(memory: HierarchicalMemoryService): Ability {
  return {
    name: 'remember_master_fact',
    description:
      '当主人告知其个人喜好、习惯、特征、重要事实或明确要求记住某事时，必须主动调用此工具立即持久化到数据库中',
    toolDefinition: {
      masterOnly: true,
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
        return { success: true, message: `已成功把事实写入主人的长期档案：${args.fact} (${vis})` }
      }
    }
  }
}

export function createSearchMasterOmniscientMemoriesAbility(memory: HierarchicalMemoryService): Ability {
  return {
    name: 'search_master_omniscient_memories',
    description:
      '仅主人可用。跨平台、跨所有群聊与私聊进行全知记忆与对话检索。支持查阅过往原话、客观事件节点以及主人自身沉淀的历史画像与偏好设定。query可选：传入时执行关键词语义检索；不传时直接查阅跨平台最新原话与最近事件摘要。',
    toolDefinition: {
      masterOnly: true,
      parameters: {
        type: 'OBJECT',
        properties: {
          query: {
            type: 'STRING',
            description:
              '可选检索关键词或自然语言描述（如：大学、某次提到的电脑配置）。不传则获取跨平台/群聊最近的实时对话与事件'
          },
          targetPlatform: {
            type: 'STRING',
            description: '可选限定平台（如 onebot、cmd），不传则搜索全部平台'
          },
          limit: {
            type: 'INTEGER',
            description: '返回结果数量上限，默认 6'
          }
        }
      },
      execute: async (args: { query?: string; targetPlatform?: string; limit?: number }) => {
        const limit = args.limit ?? 6
        const db = memory.getDatabase()
        const queryText = (args.query ?? '').trim()

        if (!queryText) {
          const recentChats = db.getGlobalRecentMessages(limit, args.targetPlatform)
          const nodes = db.getAllRecentNodes(4, args.targetPlatform)
          const facts = db.getProfileFacts('__master__', 10)
          return {
            latestRealtimeChats: recentChats.map((c) => {
              const scope = parseScopeKey(c.scope)
              const chatType = scope.type === 'group' ? 'GROUP' : 'PRIVATE'
              const platformTag = scope.platform.toUpperCase()
              const isMaster = c.userId === '__master__' || c.role === 'model'
              const senderTag = c.role === 'model' ? '[BOT]' : `[${c.senderName || 'User'}(${c.userId || 'unknown'})]`
              const masterTag = c.role !== 'model' && isMaster ? '[MASTER]' : ''
              const line = `[${platformTag}][${chatType}]${senderTag}${masterTag} ${c.content}`
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

        const matchedProfiles = db.searchProfileFacts('__master__', queryText, limit)
        const allRecent = db.getGlobalRecentMessages(50, args.targetPlatform)
        const queryLower = queryText.toLowerCase()
        const matchedDialogues = allRecent
          .filter((msg) => msg.content.toLowerCase().includes(queryLower))
          .slice(0, limit)

        const eventNodes = db.searchMemoryNodes('', queryText, limit)
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

export function createSearchChannelPublicMemoriesAbility(memory: HierarchicalMemoryService): Ability {
  return {
    name: 'search_channel_public_memories',
    description:
      '翻阅当前群聊内发生过的公开历史对话与事件总结，也可检索关于主人允许公开的对外人设。严格受本群作用域与隐私限制。',
    toolDefinition: {
      masterOnly: false,
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

export const terminalExecuteAbility: Ability = {
  name: 'execute_terminal_command',
  description: '在宿主机系统中执行 shell / terminal 命令并返回标准输出与错误（仅主人可用）',
  toolDefinition: {
    masterOnly: true,
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

export const fileReadOrWriteAbility: Ability = {
  name: 'file_read_or_write',
  description:
    '安全读写工作区本地文件。写文件直接写入多行完整内容，无需命令行转义，避免平台编码与换行问题（仅主人可用）',
  toolDefinition: {
    masterOnly: true,
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

export const silenceAbility: Ability = {
  name: 'choose_silence',
  description: '如果你觉得群内话题与你无关、无需插嘴时调用此工具保持静默。但禁随意滥用此工具。',
  toolDefinition: {
    masterOnly: false,
    parameters: {
      type: 'OBJECT',
      properties: {
        reason: { type: 'STRING', description: '选择沉默不回复的原因' }
      }
    },
    execute: async (args: { reason?: string }) => ({ silent: true, reason: args.reason ?? '无话可说，保持沉默' })
  }
}

export function createKotoriMessagingAbility(ctx: Context): Ability {
  return {
    name: 'kotori_send_message',
    description: '通过 Kotori 底层适配器主动向指定的实例投递群消息或私聊消息',
    toolDefinition: {
      masterOnly: true,
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
