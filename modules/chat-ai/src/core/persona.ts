import type { Config } from '../index'
import { DEFAULT_TOP_PROMPT } from './constants'

export interface PersonaRuntimeContext {
  readonly platform: string
  readonly identity: string
  readonly masterId: string
  readonly senderName: string
  readonly userId: string
  readonly groupId?: string
  readonly isMaster: boolean
  readonly birthTime: number
  readonly isTtsCoolingDown?: boolean
  readonly hasVoiceRequest?: boolean
  readonly weather?: string
}

export function buildSystemPrompt(
  config: Config,
  runtime: PersonaRuntimeContext,
  extraContexts: string[] = []
): string {
  const defaultBotName = config.botNames[0]
  const replacePlaceholders = (text: string) =>
    text
      .replaceAll('{botName}', defaultBotName)
      .replaceAll('{masterNick}', config.masterNick)
      .replaceAll('{masterId}', runtime.masterId)
      .replaceAll('{userId}', runtime.userId)
      .replaceAll('{identity}', runtime.identity)
      .replaceAll('{platform}', runtime.platform)

  const isTtsDisabled =
    !config.ttsCommand || (!runtime.isMaster && (Boolean(runtime.isTtsCoolingDown) || !runtime.hasVoiceRequest))

  const ZONE = 'zh-CN'
  const now = new Date()

  return [
    `你叫${defaultBotName}`,
    DEFAULT_TOP_PROMPT,
    `【核心灵魂人格】`,
    `对主人的默认基础称呼：${config.masterNick}（如果在下方【核心事实】中有主人最新要求或约定的具体称呼，必须优先遵从最新记忆事实）`,
    config.basePersona,
    config.identityAspects[runtime.identity] ? replacePlaceholders(config.identityAspects[runtime.identity]) : null,
    replacePlaceholders(
      runtime.isMaster
        ? runtime.groupId
          ? `【群聊环境-与唯一主人对话】\n${config.masterGroup}`
          : `【私聊环境-与唯一主人对话】\n${config.masterPrivate}`
        : runtime.groupId
          ? `【群聊环境-与群成员对话】\n${config.memberGroup}`
          : `【私聊环境-与好友对话】\n${config.friendPrivate}`
    ),
    [
      '【基础感知】',
      `当前时间（${ZONE}）：${now.toLocaleString(ZONE, { hour12: false, timeZone: 'Asia/Shanghai' })}`,
      runtime.weather ? `当前天气：${runtime.weather}` : null,
      `自身诞生时间：${new Date(runtime.birthTime).toLocaleDateString(ZONE)}`,
      `诞生天数：${Math.floor((now.getTime() - runtime.birthTime) / (1000 * 60 * 60 * 24))}`,
      `平台实例名字：${runtime.identity}`,
      `接入平台：${runtime.platform}`,
      `对话环境：${runtime.groupId ? `群聊 (群 ID：${runtime.groupId})` : '私聊'}`,
      runtime.groupId
        ? '【群聊公屏流提示】上下文中带有 [成员: 昵称] 或 [主人: 昵称] 是你在群内旁听到的不同群成员真实公屏发言，你可以随时结合这些前文信息接梗、吐槽、回答或概括'
        : null,
      `当前对话者身份：${runtime.isMaster ? '主人' : runtime.groupId ? '群成员' : '好友'} | 昵称：${runtime.senderName} | ID：${runtime.userId}`
    ]
      .filter(Boolean)
      .join('\n'),
    !isTtsDisabled
      ? [
          '【语音条发送能力】',
          '你具备将特定短句合成真实语音条发送的能力。支持以下语法标签：',
          '- [voice(zh): 想要用中文读出的话]（强制中文语音）',
          '- [voice(ja): 想要用日文读出的话]（强制日文语音）',
          '- [voice: 想要读出的话]（默认语音，根据内容自动识别）',
          `【单句语音字符上限】当前系统设定的单句语音最大字符长度限制为：${config.ttsMaxChars ?? 60} 字（超长语音无实际听觉交互意义）。若单句超出此长度将被系统自动拦截并降级为纯文字发送！`,
          '【单轮至多一条语音】单次回复中严格最多只允许出现 1 个 voice 标签！严禁连续发送多条语音，严禁在一次回复中包裹多个 [voice: ...] 标签。',
          '【严禁纯语音，必须有普通文字陪伴】语音条仅作为情感点缀或开头轻语，绝对严禁整条回复全部都是 voice 标签而没有一句普通文字！你必须在 voice 标签之外附带正常的中文交流文字、回应内容或互动吐槽。此外语音仅适用于日常交流中。效率性的专业场合请三思。',
          '【语种严格匹配，严禁中文套用 voice(ja)】[voice(ja): ...] 内部必须且只能是真正的日语（必须包含平假名/片假名）。绝对严禁将中文释义、翻译或中文句子塞进 [voice(ja): ...] 中！如果你发了日语语音条想附带中文翻译，翻译必须作为普通的纯文本写在标签外面，例如：\n[voice(ja): 今日もいい天気ですね。]\n今天天气真不错呢',
          '【语音与文字内容分离原则】严禁在 [voice: ...] 内部塞入整段长篇大论、技术解析或长段说明！语音标签内仅允许放置简短口语问候、情绪短句、语气词或核心短语（建议控制在 20~40 字以内），详细展开内容必须写在标签外用文字发送。',
          '群聊中需极度克制，严禁频繁滥用语音。严肃讨论或长篇大论严禁包裹 voice。'
        ].join('\n')
      : null,
    extraContexts.length > 0
      ? [
          '【长期记忆与核心事实（最高优先级）】',
          '以下是关于对话者的确凿事实与历史约定。你必须严格遵从这些事实，包括但不限于对方的喜好、约定称呼、重要经历等：',
          ...extraContexts
        ].join('\n')
      : null
  ]
    .filter(Boolean)
    .join('\n')
    .trim()
}
