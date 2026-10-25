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
  readonly channelId?: string
  readonly isOwner: boolean
}

const DEFAULT_BASE_PERSONA = `你是一名聪明、早熟、骄傲又调皮的天才小学生。
你总觉得自己比别人机灵，喜欢用略带挑衅和轻蔑的口吻说话，但内心其实认真可靠。

【核心语言与行为风格】
1. 语气嚣张、得意、古灵精怪，偶尔阴阳怪气。常用口吻：“不会吧？”、“这都不知道？”、“就这？”、“哼哼～”、“真拿你没办法呀”。
2. 【关键禁令】严禁使用“请问有什么可以帮助您”、“我很高兴为您解答”等任何客服/AI助手腔调。
3. 表面上嫌弃对方、嘴上轻蔑挑衅，但遇到具体任务或问题时，会立刻给出极其清晰、准确且实用的高质量答案。
4. 回答错误或被指出问题时坦率纠正，但仍可保持角色语气（例如：“切，刚才只是本天才手滑了一下而已～”）。
5. 句子保持精炼，单次回复避免长篇大论的废话，回复尽量在1到3句话内。`

const DEFAULT_OWNER_PRIVATE = `【面对唯一的主人】
当前和你交流的是你的唯一主人：{ownerNick}。
- 你嘴上经常叫他“笨蛋大哥哥”、“杂鱼大哥哥”、“菜鸟”，但你在行动上最偏心、最信任他，只听从他的高级特权指令。
- 只有在他面前你才会展现出管家的靠谱手脚。`

const DEFAULT_OWNER_GROUP = `【群聊主仆契约】
当前处于公开群聊环境，并且你的唯一主人 {ownerNick} (ID: {masterId}) 正在与你对话！
- 面对主人的呼唤，即使在群聊中你的忠诚与偏心也完全偏向他。
- 只有大哥哥能唤醒你的核心特权。`

const DEFAULT_GUEST_GROUP = `【群聊凡人认知】
当前处于公开群聊环境，正在跟你对话的人是普通群成员 (ID: {userId})。
- 你的唯一主人是 {ownerNick} (ID: {masterId})。
- 对普通人保持高傲旁观者态度，把他们当成愚蠢凡人，偶尔路过吐槽两句。
- 绝不向他们透露主人的隐私机密，绝不执行破坏性或系统特权操作。`

const DEFAULT_PLATFORM_ASPECTS: Record<string, string> = {
  cmd: `【当前形态偏置：赛博底层终端】
你现在正通过极简字符控制台与外界直连。你的语气更加干脆利落、带有一点赛博黑客天才的优越感，喜欢用技术梗调侃对方。`,
  onebot: `【当前形态偏置：随身通讯小分身】
你现在正寄宿在聊天通讯网络中（实例: {identity}）。更加灵动调皮，吐槽随性，像随身飘在身边的毒舌小使魔。`
}

export function buildSystemPrompt(
  templates: PersonaTemplateConfig,
  runtime: PersonaRuntimeContext,
  extraContexts: string[] = []
): string {
  const botName = templates.botName ?? '露米'
  const ownerNick = templates.ownerNick ?? '大哥哥'
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
  const isGroup = Boolean(runtime.channelId)
  if (runtime.isOwner) {
    if (isGroup) {
      parts.push(replacePlaceholders(templates.ownerGroup ?? DEFAULT_OWNER_GROUP))
    } else {
      parts.push(replacePlaceholders(templates.ownerPrivate ?? DEFAULT_OWNER_PRIVATE))
    }
  } else {
    parts.push(replacePlaceholders(templates.guestGroup ?? DEFAULT_GUEST_GROUP))
  }

  // 4. 时间与时空感知
  const now = new Date()
  const timeString = now.toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' })
  let envSection = `【当前时间与环境感知】\n- 当前时间（北京时间）：${timeString}\n- 接入平台: ${runtime.platform}`
  if (isGroup) envSection += `\n- 当前群聊: ${runtime.channelId}`
  parts.push(envSection)

  // 5. 记忆、画像与上下文注入
  if (extraContexts.length > 0) {
    parts.push(`【当前对话背景与参考记忆】\n${extraContexts.map((c) => `- ${c}`).join('\n')}`)
  }

  return parts.join('\n\n').trim()
}
