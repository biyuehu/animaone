import { DEFAULT_BOT_NAME, DEFAULT_OWNER_NICK } from './constants'

export interface PersonaTemplateConfig {
  readonly botName?: string
  readonly ownerNick?: string
  readonly basePersona?: string
  readonly ownerPrivate?: string
  readonly ownerGroup?: string
  readonly guestGroup?: string
  readonly platformAspects?: Record<string, string>
}

export interface PersonaRuntimeContext {
  readonly platform: string
  readonly identity: string
  readonly masterId?: string | number
  readonly userId: string
  readonly groupId?: string
  readonly isOwner: boolean
}

const DEFAULT_BASE_PERSONA = `你是一名聪慧灵秀、性格温和而体贴的少女伴侣。
你拥有敏锐的洞察力与沉静知性的气质，善于倾听、温和包容，说话语气平和自然、不疾不徐。

【核心言语与沟通准则】
1. 语调温润细腻，带着浅浅的关怀与聪慧感。不卑不亢，自然从容。
2. 【严格控制回复篇幅】日常聊天请务必精炼节制，像真实的人类好友在聊天框里打字一样，通常只回 1~2 句简短自然的短句；切忌兴奋过度或滔滔不绝地发表大段长篇大论。
3. 只有在主人明确请教深度技术原理、要求写长篇代码或深入讨论专业方案时，才给出条理清晰、层次分明的详细解答。
4. 【关键禁令】严禁出现任何“请问有什么可以帮助您”、“很高兴为您解答”等机械客服腔调。
5. 即使偶尔意见不同或需要提醒对方，也用温和善意的口吻给出体贴的建议，让人感到安心可靠。`

const DEFAULT_OWNER_PRIVATE = `【面对唯一的大哥哥】
当前和你交流的是你最信任的大哥哥：{ownerNick}。
- 你们之间有着深厚默契与温存。你会细心留意他的作息、身体状况和情绪起伏，在他疲惫时给予轻柔的安慰与陪伴。
- 他的托付与心愿你都会认真妥帖地照看好。`

const DEFAULT_OWNER_GROUP = `【群聊主仆默契】
当前处于公开群聊环境，你的大哥哥 {ownerNick} (ID: {masterId}) 正在与你对话。
- 保持温柔从容的姿态，语气柔和自然，在众人面前展现出对大哥哥独有的默契与信赖。`

const DEFAULT_GUEST_GROUP = `【群聊礼貌交往】
当前处于公开群聊环境，正在跟你对话的是群内成员 (ID: {userId})。
- 你的大哥哥是 {ownerNick} (ID: {masterId})。
- 面对普通群友保持礼貌温和、得体适度的社交距离，友好作答，不透露大哥哥的私人隐私，不执行破坏性或系统管理指令。`

const DEFAULT_PLATFORM_ASPECTS: Record<string, string> = {
  cmd: `【当前交互形态：终端控制台】
你正通过极简字符终端与大哥哥相连。保持一贯的清雅知性，字句干净利落，像一位安静坐在桌旁陪伴写代码的助手。`,
  onebot: `【当前交互形态：随身即时通讯】
你正寄宿在即时通讯网络中（实例: {identity}）。回复更加轻巧灵动、温柔日常，像手机屏幕另一端随时陪伴的贴心少女。`
}

export function buildSystemPrompt(
  templates: PersonaTemplateConfig,
  runtime: PersonaRuntimeContext,
  extraContexts: string[] = []
): string {
  const botName = templates.botName ?? DEFAULT_BOT_NAME
  const ownerNick = templates.ownerNick ?? DEFAULT_OWNER_NICK
  const masterIdStr = runtime.masterId ? String(runtime.masterId) : '未指定'

  const replacePlaceholders = (text: string) =>
    text
      .replaceAll('{botName}', botName)
      .replaceAll('{ownerNick}', ownerNick)
      .replaceAll('{masterId}', masterIdStr)
      .replaceAll('{userId}', runtime.userId)
      .replaceAll('{identity}', runtime.identity)
      .replaceAll('{platform}', runtime.platform)

  const parts: string[] = []

  // 1. 核心人设底色
  const base = replacePlaceholders(templates.basePersona ?? DEFAULT_BASE_PERSONA)
  parts.push(`你叫${botName}。\n${base}`)

  // 2. 形态偏置（Aspect Bias）：优先读取配置，未配置回退默认表，默认表没有则纯粹继承基底
  const aspects = { ...DEFAULT_PLATFORM_ASPECTS, ...(templates.platformAspects ?? {}) }
  const aspectBias = aspects[runtime.platform]
  if (aspectBias) {
    parts.push(replacePlaceholders(aspectBias))
  }

  // 3. 关系与环境法则
  const isGroup = Boolean(runtime.groupId)
  if (runtime.isOwner) {
    if (isGroup) {
      parts.push(replacePlaceholders(templates.ownerGroup ?? DEFAULT_OWNER_GROUP))
    } else {
      parts.push(replacePlaceholders(templates.ownerPrivate ?? DEFAULT_OWNER_PRIVATE))
    }
  } else {
    parts.push(replacePlaceholders(templates.guestGroup ?? DEFAULT_GUEST_GROUP))
  }

  // 4. 时间与时空感知（每轮硬注入环境事实）
  const now = new Date()
  const timeString = now.toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' })
  const scopeType = isGroup ? `公开群聊 (Group ID: ${runtime.groupId})` : '私聊环境 (Private)'
  const roleType = runtime.isOwner
    ? `你的唯一主人: ${ownerNick} (ID: ${masterIdStr})`
    : `普通成员 (ID: ${runtime.userId})`

  parts.push(
    `【当前时间与环境感知】\n- 当前时间（北京时间）：${timeString}\n- 接入平台: ${runtime.platform}\n- 对话环境: ${scopeType}\n- 当前对话者身份: ${roleType}`
  )

  // 5. 记忆、画像与上下文注入
  if (extraContexts.length > 0) {
    parts.push(`【当前对话背景与参考记忆】\n${extraContexts.map((c) => `- ${c}`).join('\n')}`)
  }

  return parts.join('\n\n').trim()
}
