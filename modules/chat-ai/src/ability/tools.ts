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
  return {
    name: 'trigger_dream_reflection',
    description:
      '仅主人可用。当主人要求你“做个梦”、“做梦看看”、“发呆沉思”、“找找灵感”或需要进行潜意识联想顿悟时，必须主动调用此工具触发真实梦境反射。工具会从过往事件中碰撞出新概念和台词供你回答。严禁不调工具凭空编造虚假梦境。',
    toolDefinition: {
      masterOnly: true,
      parameters: { type: 'OBJECT', properties: {} },
      execute: async () => {
        const now = Date.now()
        const elapsed = (now - memory.getLastDreamTime()) / 1000
        if (elapsed < cooldownSeconds) {
          const waitMinutes = Math.ceil((cooldownSeconds - elapsed) / 60)
          return {
            success: false,
            message: `做梦冷却中（还需等待 ${waitMinutes} 分钟）。刚已经睡过了，无法入睡`
          }
        }

        const res = await memory.triggerDream('__master__')
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
          promotedSubconsciousFact: res.promotedFact?.fact,
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
    description:
      '全网实时信息搜索与网页正文抓取工具。' +
      '1. 搜索模式（传入 query）：在互联网上检索信息，返回包含真实网页 url、title 标题和 snippet 摘要的结构化结果列表。' +
      '2. 深度阅读/正文抓取模式（传入 url）：访问具体网页并抓取其一手正文。当需要详细考察、阅读项目 README、文档或报道时，必须接着传入目标 url 抓取正文，严禁仅凭零碎搜索摘要凭空臆断。',
    toolDefinition: {
      masterOnly: false,
      parameters: {
        type: 'OBJECT',
        properties: {
          url: {
            type: 'STRING',
            description:
              '需要抓取提取正文的完整网址（如 https://...）。若已知目标网址或需要深入阅读搜索结果中的某一项，传入此参数'
          },
          query: {
            type: 'STRING',
            description: '需要搜索的关键词短语（如果不指定 url 时使用）'
          }
        }
      },
      execute: async (args: { url?: string; query?: string }) => {
        const agent = proxy ? new ProxyAgent(proxy.startsWith('http') ? proxy : `http://${proxy}`) : undefined

        // 1. 如果指定了 url，直接抓取网页并提取核心正文
        if (args.url) {
          try {
            const resp = await undiciFetch(args.url, {
              headers: {
                'User-Agent':
                  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
              },
              dispatcher: agent,
              signal: AbortSignal.timeout(10000)
            })
            const html = await resp.text()

            // 优先尝试提取 Markdown / 文章主体区域，提升正文信噪比
            let bodyContent = html
            const articleMatch =
              html.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i) ?? html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)
            if (articleMatch) {
              bodyContent = articleMatch[1]
            }

            const cleanText = bodyContent
              .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
              .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
              .replace(/<[^>]+>/g, ' ')
              .replace(/\s+/g, ' ')
              .trim()
              .slice(0, 4500)

            return {
              url: args.url,
              status: resp.status,
              content: cleanText || '未提取到正文内容'
            }
          } catch (e) {
            return { error: `网页抓取失败: ${e instanceof Error ? e.message : String(e)}` }
          }
        }

        // 2. 如果指定了 query，使用稳定无验证码的 DuckDuckGo Lite 端点执行检索，并完整返回 URL 与摘要
        if (args.query) {
          try {
            const postBody = new URLSearchParams({ q: args.query.trim() }).toString()
            const resp = await undiciFetch('https://lite.duckduckgo.com/lite/', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'User-Agent':
                  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
              },
              body: postBody,
              dispatcher: agent,
              signal: AbortSignal.timeout(10000)
            })

            const html = await resp.text()

            if (html.includes('anomaly-modal') || html.includes('challenge-form')) {
              return { error: '搜索引擎返回了反爬验证码，无法获取搜索摘要。建议直接使用目标网址进行 url 抓取。' }
            }

            // 正则提取所有结果的标题、直接目标 URL 与摘要
            const linkRegex = /<a[^>]+class=['"]result-link['"][^>]*href=['"]([^'"]+)['"][^>]*>([\s\S]*?)<\/a>/g
            const snippetRegex = /<td[^>]+class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/g

            const links: { url: string; title: string }[] = []
            let lm: RegExpExecArray | null = linkRegex.exec(html)
            while (lm !== null) {
              const rawUrl = lm[1].trim()
              const title = lm[2].replace(/<[^>]+>/g, '').trim()
              let finalUrl = rawUrl
              try {
                if (rawUrl.includes('/l/?uddg=')) {
                  const u = new URL(rawUrl.startsWith('http') ? rawUrl : `https:${rawUrl}`)
                  const real = u.searchParams.get('uddg')
                  if (real) finalUrl = decodeURIComponent(real)
                }
              } catch {}
              links.push({ url: finalUrl, title })
              lm = linkRegex.exec(html)
            }

            const snippets: string[] = []
            let sm: RegExpExecArray | null = snippetRegex.exec(html)
            while (sm !== null) {
              snippets.push(sm[1].replace(/<[^>]+>/g, '').trim())
              sm = snippetRegex.exec(html)
            }

            const results: { title: string; url: string; snippet: string }[] = []
            const maxCount = Math.min(links.length, snippets.length, 6)
            for (let i = 0; i < maxCount; i++) {
              results.push({
                title: links[i].title,
                url: links[i].url,
                snippet: snippets[i]
              })
            }

            if (results.length === 0) {
              return { query: args.query, message: '未找到相关网页结果', results: [] }
            }

            return { query: args.query, count: results.length, results }
          } catch (e) {
            return { error: `搜索执行失败: ${e instanceof Error ? e.message : String(e)}` }
          }
        }

        return { error: '必须提供 url 或 query 参数' }
      }
    }
  }
}

export function createDemoteUserAttitudeAbility(
  memory: HierarchicalMemoryService,
  logger?: { info: (msg: string) => void }
): Ability {
  return {
    name: 'demote_user_attitude',
    description:
      '降低对特定普通群成员的态度等级。仅用于其他群成员言语恶劣无礼、进行人身攻击、恶意骚扰或试图破坏规则时自主调用。严禁滥用。严禁对主人调用。',
    toolDefinition: {
      nonMasterOnly: true,
      parameters: {
        type: 'OBJECT',
        properties: {
          targetUserId: {
            type: 'STRING',
            description: '目标用户的数字 ID。若不填则默认为当前对话者。在群聊中若针对特定群成员降级，请传入该成员的 ID'
          },
          reason: {
            type: 'STRING',
            description: '判定降级的客观理由与事实依据（例如：多次进行污言秽语人身攻击）'
          }
        },
        required: ['reason']
      },
      execute: async (args: { targetUserId?: string; reason: string }, ctx: AbilityContext) => {
        const rawTargetId = (args.targetUserId ?? ctx.userId ?? '').trim()
        if (!rawTargetId) return { success: false, error: 'MISSING_USER_ID', message: '未能定位目标用户' }

        if (rawTargetId === '__master__' || (ctx.isMaster && rawTargetId === ctx.userId)) {
          return { success: false, error: 'INVALID_TARGET', message: '严禁对主人调用态度降级' }
        }

        const scopedUserId = `${ctx.identity}:${rawTargetId}`
        const db = memory.getDatabase()
        const res = db.demoteUserAttitude(scopedUserId, args.reason.trim())

        logger?.info(
          `[Attitude Demoted] User ${rawTargetId} (identity: ${ctx.identity}) demoted to [${res.statusText}] (level ${res.newLevel}), reason: "${args.reason.trim()}"`
        )

        return {
          success: true,
          targetUserId: rawTargetId,
          newLevel: res.newLevel,
          statusText: res.statusText,
          message: `已成功将用户 ${rawTargetId} 的态度降级为【${res.statusText}】。`
        }
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
      '仅主人可用。全能跨平台与跨会话全知记忆检索。包括平台、实例、群聊、好友对话都可查。' +
      '支持按条件筛选查阅过往真实对话原话、客观事件节点以及主人自身沉淀的历史画像与偏好。' +
      '所有检索字段（query、scope、platform、identity）皆为可选：' +
      '1. 若不提供 query 或为空，直接按时间倒序获取最近的真实对话与事件流水；' +
      '2. 若指定 scope（如 "private" 查私信/私聊，"group" 查群聊），可精准定向目标会话环境；' +
      '3. 若指定 identity（如 "lambda"）或 platform（如 "onebot"），可限定特定实例与平台。',
    toolDefinition: {
      masterOnly: true,
      parameters: {
        type: 'OBJECT',
        properties: {
          query: {
            type: 'STRING',
            description:
              '可选。检索关键词或查找的主题内容（如：某个项目名、某次提到的电脑配置等）。若不传或为空，则直接按时间倒序获取最近的真实对话原话与事件流水'
          },
          scope: {
            type: 'STRING',
            description:
              '可选。会话通道范围过滤，可传入 "private"（仅查私聊/私信）、"group"（仅查群聊），或具体的会话标识/群号。不传则检索全部会话类型'
          },
          identity: {
            type: 'STRING',
            description: '可选。机器人实例身份（如 "lambda"、"cmd-test" 等）。不传则检索全部实例'
          },
          platform: {
            type: 'STRING',
            description: '可选。接入平台类型（如 "onebot"、"cmd" 等）。不传则检索全部平台'
          },
          limit: {
            type: 'INTEGER',
            description: '可选。返回结果数量上限，默认 8'
          }
        }
      },
      execute: async (
        args: {
          query?: string
          scope?: string
          platform?: string
          identity?: string
          targetPlatform?: string
          limit?: number
        },
        ctx?: AbilityContext
      ) => {
        const limit = args.limit ?? 8
        const db = memory.getDatabase()
        const queryText = (args.query ?? '').trim()
        const platform = args.platform ?? args.targetPlatform
        const identity = args.identity
        const scope = args.scope

        const filterOpts = {
          limit,
          scope,
          platform,
          identity
        }

        // 1. 如果没有传 queryText，直接按时间倒序拉取指定 scope / platform / identity 的最新流水
        if (!queryText) {
          const recentChats = db.getGlobalRecentMessages(filterOpts)
          const nodes = db.getAllRecentNodes(4, { platform, identity, scope })
          const facts = db.getProfileFacts('__master__', 10)
          return {
            searchMode: 'chronological_recent',
            appliedFilters: {
              scope: scope || 'all',
              platform: platform || 'all',
              identity: identity || 'all'
            },
            latestRealtimeChats: recentChats.map((c) => {
              const parsedScope = parseScopeKey(c.scope)
              const chatType = parsedScope.type === 'group' ? 'GROUP' : 'PRIVATE'
              const platformTag = parsedScope.platform.toUpperCase()
              const isMaster =
                c.userId === '__master__' ||
                (ctx?.isMaster && c.userId === ctx.userId) ||
                (parsedScope.type === 'private' && c.role === 'user')
              const senderTag = c.role === 'model' ? '[BOT]' : `[${c.senderName || 'User'}(${c.userId || 'unknown'})]`
              const masterTag = c.role !== 'model' && isMaster ? '[MASTER]' : ''
              const line = `[${platformTag}][${chatType}]${senderTag}${masterTag} ${c.content}`
              return {
                scope: c.scope,
                formatted: line,
                time: c.time
              }
            }),
            masterProfileFacts: facts,
            longTermMemorySummaries: nodes.map((n) => {
              const parsedScope = parseScopeKey(n.scopeKey)
              const chatType = parsedScope.type === 'group' ? 'GROUP' : 'PRIVATE'
              const platformTag = parsedScope.platform.toUpperCase()
              return {
                scope: n.scopeKey,
                formatted: `[${platformTag}][${chatType}] ${n.summary}`,
                time: new Date(n.endTime).toLocaleString('zh-CN')
              }
            })
          }
        }

        // 2. 如果提供了 queryText：
        // 2.1 数据库精准关键词检索
        const matchedChats = db.getGlobalRecentMessages({
          ...filterOpts,
          query: queryText
        })

        // 2.2 附带获取该作用域下最新的 4 条发言流水保底（双保险：防止 query 关键词由于自然语言差异导致模型眼瞎）
        const recentBaselineChats = db.getGlobalRecentMessages({
          ...filterOpts,
          limit: 4
        })

        const seenChatKeys = new Set<string>()
        const combinedDialogues = []
        for (const c of [...matchedChats, ...recentBaselineChats]) {
          const key = `${c.scope}:${c.time}:${c.content}`
          if (!seenChatKeys.has(key)) {
            seenChatKeys.add(key)
            combinedDialogues.push(c)
          }
        }

        const matchedProfiles = db.searchProfileFacts('__master__', queryText, limit)
        const eventNodes = db.searchMemoryNodes('', queryText, limit)
        const startNodeIds = eventNodes.map((n) => n.id).filter((id): id is number => typeof id === 'number')
        const graphTraversal = db.traverseGraph(startNodeIds, 1, limit)

        return {
          searchMode: 'semantic_and_recent',
          appliedFilters: {
            query: queryText,
            scope: scope || 'all',
            platform: platform || 'all',
            identity: identity || 'all'
          },
          dialogueHistory: combinedDialogues.map((d) => {
            const parsedScope = parseScopeKey(d.scope)
            const isMaster =
              d.userId === '__master__' ||
              (ctx?.isMaster && d.userId === ctx.userId) ||
              (parsedScope.type === 'private' && d.role === 'user')
            const masterTag = d.role !== 'model' && isMaster ? '[MASTER]' : ''
            return {
              scope: d.scope,
              sender: `${d.senderName || '用户'}(${d.userId})${masterTag}`,
              role: d.role,
              content: d.content,
              time: d.time
            }
          }),
          masterProfileFacts: matchedProfiles.map((p) => ({
            id: p.id,
            fact: p.fact,
            category: p.category,
            visibility: p.visibility,
            lastUpdated: new Date(p.updatedAt).toLocaleDateString('zh-CN')
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
