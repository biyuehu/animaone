# AnimaOne

基于 Kotori 框架的认知伴侣与高级智能体插件，驱动具有深度分层记忆、多名字别名唤醒、拟真人设及多工具调用闭环能力的交互体验。

---

## 核心特性

```mermaid
flowchart TD
    Msg["外部输入消息 (OneBot / CMD 等)"] --> GW["网关过滤层 (MessageGateway)"]

    subgraph Gateway["1. 网关过滤层 (gateway/filter.ts)"]
        GW -->|"白名单校验 & @Bot / botNames 多别名匹配 / 引用回复"| Direct["主动对话 (master_direct / group_direct)"]
        GW -->|"最近发言跟帖窗口 (followupWindow)"| Followup["群聊跟帖对话 (group_followup)"]
        GW -->|"长度>=6 且命中 groupActiveRate"| Casual["旁观插话 (group_casual)"]
        GW -->|"未命中"| Reject["被动旁听 / 阻断 (rejected)"]
    end

    Direct --> Core["2. 编排中枢 (index.tsx)"]
    Followup --> Core
    Casual --> Core

    subgraph MemoryLayer["3. 认知记忆体系 (memory/ & core/retrieval.ts)"]
        L0["Level 0: constants.ts & config<br/>核心法则与根本人设 (只读置顶注入 Prompt)"]
        L1[("Level 1: user_profiles<br/>用户画像与事实 (严格私密隔离，带权时序注入)")]
        L2[("Level 2: memory_nodes & memory_links<br/>宏观事件图谱 (10轮/1500字/空闲自动提炼，Graph RAG)")]
        SessionContext[("会话上下文: SlidingWindow & DB<br/>近期多轮对话流 (RAM + 引用秒级反查 + 30分钟空闲断层感知)")]
        BM25["core/retrieval.ts<br/>Unigram + Bigram + BM25 + 半衰期衰减"]
    end

    subgraph Persona["4. 人设与感知装配 (core/persona.ts)"]
        SysTime["时间感知 (东八区、诞生天数、当前时刻)"]
        Weather["主人私聊现实天气感知 (wttr.in 同步注入)"]
        Env["环境感知 (群聊/私聊、平台实例、群聊密集水群感知)"]
        Identity["身份分支 (masterPrivate / masterGroup / memberGroup)"]
        Prompt["System Prompt 组装<br/>(L0 底层人设 + L1 画像事实 + 梦境顿悟装配)"]

        SysTime --> Prompt
        Weather --> Prompt
        Env --> Prompt
        Identity --> Prompt
        L0 --> Prompt
        L1 --> Prompt
    end

    Core --> Persona
    Core --> SessionContext

    subgraph Ability["5. 能力与工具系统 (ability/)"]
        Tools["Function Declarations<br/>- search_master_omniscient_memories (主人全知记忆与跨平台原话检索)<br/>- search_channel_public_memories (群内公共记忆检索)<br/>- remember_master_fact (主人专属事实沉淀)<br/>- choose_silence (自主静默)<br/>- web_search_or_fetch / terminal / file / messaging"]
    end

    Prompt --> Gemini["6. 核心驱动层 (core/gemini.ts)"]
    SessionContext --> Gemini
    Tools <-->|"Tool Calls (最多 maxToolLoops 轮)"| Gemini
    BM25 <--> Tools
    L2 <--> Tools

    subgraph Output["7. 响应与后台沉淀"]
        Gemini -->|"__NO_REPLY__"| Drop["静默丢弃"]
        Gemini -->|"文本回复"| Split["分句拆条、拟人半括号与打字延迟 (core/split.ts)"]
        Gemini -->|"语音回复"| Voice["异步抢占加锁 TTS 合成 (core/tts.ts)"]
        Split --> Session["Session Quick 发送下发"]
        Voice --> Session
        Session -.->|"queueMicrotask (非阻塞异步)"| Record["后台记录与提炼 (memory.recordTurn)"]
    end
```

- **三级分层认知记忆系统（HierarchicalMemory）**
  - **Level 0（核心法则与根本人设）**：定义于 `constants.ts` 与插件配置中，作为智能体的底层铁律与人格基石，无条件只读常驻注入 System Prompt 最高执行区。
  - **Level 1（用户画像与长期事实）**：存储于 `user_profiles`。严格实行**物理隔离与零信任隐私原则**，主人在私密频道的生理、情感记录强制标记为 `private`，群聊中仅暴露公开技术人设与公开偏好，彻底杜绝隐私泄露。
  - **Level 2（宏观事件图谱与 Graph RAG）**：存储于 `memory_nodes` 与 `memory_links`。支持每 10 轮交互、1500 字累计超限或空闲超时自动提炼 Day 级核心摘要与概念标签，平时不占 Prompt，按需主动顺藤摸瓜检索。
  - **会话上下文（短期工作流与时间断层感知）**：由 RAM `SlidingWindowMemory` 与 SQLite `recent_messages` 驱动。保留最新 `maxTurns` 轮近期对话流，支持群内引用消息（`findQuotedMessage`）秒级检索。内置 **30 分钟群聊空闲断层系统提示**，自动切断过期话题，避免插话时翻旧账。
  - **夜间潜意识顿悟推演（Dream Reflection）**：凌晨 2~5 点在心跳中自动随机抽取记忆节点进行跨界联想推演，生成灵感并于下一次主人私聊时轻柔提起。

- **多别名触发与智能网关**
  - 支持 `botNames` 字符串数组配置多个触发别名（如 `['λ', '小拉姆达']`），首个元素作为默认名，网关自动匹配并清洗剥离所有别名。
  - 拥有主动交互（`master_direct` / `group_direct`）、群聊跟帖会话窗口（`group_followup`）、偶发主动插嘴（`group_casual`）与密集水群感知（`burstThreshold`）。
  - **防误艾特机制**：水群插话（`group_casual`）与顺风跟帖（`group_followup`）严格禁止添加 `@群友`，保持自然旁听者姿态，仅在被直接唤醒（`group_direct`）时按需回复目标。

- **纯 TS 检索引擎与知识图谱联想**
  - 中文无词典切词（Unigram 单字 + Bigram 双字滑窗）结合停用词表。
  - 标准 BM25 相关度评分结合 30 天指数半衰期时间衰减算法（`rankDocuments`）。
  - 基于概念关联边的有界 BFS 图遍历（`traverseGraph`），驱动模型展开多跳顺藤摸瓜联想。

- **拟真人设与全方位感知**
  - **时间与生命感知**：感知墙上钟时间（东八区）、自身诞生时刻与存活天数。
  - **主人现实天气感知**：配置 `city` 城市后，私聊环境自动在【基础感知】中无感注入 `wttr.in` 实时天气（温度、天气描述、湿度），具备 1 小时内存缓存防刷与 3 秒超时容错，严格隔离仅对主人可见。
  - **严格权限隔离**：使用框架统一 `master` 语义，严格区分主人私聊（`masterPrivate`）、主人在群（`masterGroup`）与普通群成员（`memberGroup`），严防认错人。
  - **拟真打字体验**：支持智能标点分句保护、拟人打字延迟（`enableHumanDelay`）与短句末尾随机半括号变体注入。

- **语音合成调度（TTS）**
  - **抢占加锁（Lock Ahead）**：在判定放行发语音的瞬间立即锁定时间戳，彻底消除数十秒外部推理期间的时序盲区。
  - **权限与语种收口**：非主人默认不开启语音能力提示，语法示例完全中性化，支持 `ttsSequential` 选择连续阻塞或独立非阻塞发送。

- **完备能力工具集（Ability）**
  - `search_master_omniscient_memories`：主人专用，全域搜索历史事件原话与图谱联想线索（可选 query：不传则获取跨平台实时原话与近期事件摘要）。
  - `search_channel_public_memories`：群友只读，检索当前频道的公开历史与图谱关联记忆。
  - `remember_master_fact`：主人专用，实时沉淀关键事实画像。
  - 宿主管理与日常工具：安全终端命令执行（`execute_terminal_command`）、文件读写（`file_read_or_write`）、网络搜索与网页抓取（`web_search_or_fetch`）、自主静默（`choose_silence`）及主动消息推送（`kotori_send_message`）。

---

## 指令说明

| 指令 | 权限要求 | 说明 |
| :--- | :--- | :--- |
| `/shut [duration]` | 管理员 | 物理静默当前会话指定秒数（默认 600 秒，传入 0 解除） |
| `/calm [duration]` | 管理员 | 让机器人冷静一个跟回周期，暂停当前会话的主动回复 |
| `/flush` | 管理员 | 清空当前会话的短期上下文记忆 |
| `/attitude [user]` | 普通成员 | 查看目标用户当前的坏感度态度等级 |
| `/setattitude <user> <level>` | 管理员 | 手动设置用户的坏感度态度等级（0~4，0为恢复正常） |
| `/dream` | 管理员 | 强制立即执行一次潜意识梦境顿悟推演 |
| `/tts <text> [lang]` | 管理员 | 强制测试调用外部 TTS 脚本并发送语音条 |

---

## 配置项说明

在 Kotori 配置文件中，可配置以下参数：

| 配置项 | 类型 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- |
| `apiKey` | `string` | **必填** | Google Gemini API Key |
| `modelName` | `string` | `'gemini-3.5-flash-lite'` | 调用的模型名称（建议 Flash 系列保证响应速度） |
| `proxy` | `string` | `undefined` | HTTP/SOCKS 代理地址（如 `http://127.0.0.1:7890`） |
| `whitelistedGroups` | `string[]` | `[]` | 允许对话或旁观插嘴的群号白名单（支持纯群号、platform:群号、identity:群号） |
| `allowedInstances` | `string[]` | `[]` | 允许接入响应的适配器实例 identity 列表（留空则不限制全部放行） |
| `city` | `string` | `undefined` | 主人常居城市（如 `"北京"`），用于主人私聊的基础天气感知 |
| `groupActiveRate` | `number` | `0.05` | 群聊未被叫到时的随机搭话概率（0.0 ~ 1.0） |
| `botNames` | `string[]` | `['λ']` | 机器人名称列表，第一个为默认名，数组所有名字均可唤醒 |
| `masterNick` | `string` | `'大哥哥'` | 对主人的默认基础称呼（优先遵从画像记忆约定） |
| `basePersona` | `string` | *(见常量)* | 基础底色人设设定 |
| `masterPrivate` | `string` | *(见常量)* | 主人私聊环境下的专属人设提示词 |
| `masterGroup` | `string` | *(见常量)* | 主人在群聊环境下的交互人设提示词 |
| `memberGroup` | `string` | *(见常量)* | 普通群成员在群聊环境下的交互人设提示词（防认错人） |
| `friendPrivate` | `string` | *(见常量)* | 好友在私聊环境下的交互人设提示词 |
| `allowFriendPrivate` | `boolean` | `true` | 是否允许普通好友私聊交互 |
| `identityAspects` | `Record<string, string>` | *(见常量)* | 各实例专属风格特质切面映射 |
| `enableHumanDelay` | `boolean` | `true` | 是否启用自然呼吸感的轻量分句与打字发送延迟 |
| `splitThreshold` | `number` | `120` | 长回复整体发送不拆条的字符长度阈值 |
| `trailingBracketRate` | `number` | `0.08` | 短句末尾随机添加拟人半括号变体的概率 |
| `trailingBracketVariants` | `string[]` | `['（', '）', '（（', '（（（', '（）']` | 短句末尾追加的半括号变体候选列表 |
| `followupWindow` | `number` | `45` | 机器人发言后群友跟帖会话窗口秒数（免随机判定直接放行） |
| `burstThreshold` | `number` | `8` | 判定群聊密集水群触发回复的消息条数阈值（1分钟内） |
| `maxTurns` | `number` | `20` | 短期对话滑动窗口最大保留轮数 |
| `summaryInterval` | `number` | `10` | 自动触发长期记忆归档与提炼的交互轮次间隔 |
| `summaryCharLimit` | `number` | `1500` | 群聊累计字符数超限自动提前触发归档总结的字数阈值 |
| `idleCompactTimeout` | `number` | `300` | 群聊无活动自动触发记忆压缩的空闲秒数 |
| `activeMemoryCapacity` | `number` | `15` | 组装上下文时最多召回的用户画像事实条数 |
| `enableDreamReflection` | `boolean` | `true` | 是否开启凌晨闲暇做梦灵感推演 |
| `dreamCooldown` | `number` | `900` | 主动调用做梦工具的冷却时间（秒，默认15分钟） |
| `maxToolLoops` | `number` | `10` | 单次交互中允许大模型连续调用工具的最大循环跳数 |
| `ttsCommand` | `string` | `undefined` | 外部 TTS 脚本可执行命令（如 `python path/to/tts.py`），留空关闭语音合成 |
| `ttsCooldown` | `number` | `45` | 群聊中发送语音条的冷却秒数 |
| `ttsMaxChars` | `number` | `60` | 允许转为语音条的单句最大字符数阈值 |
| `ttsSequential` | `boolean` | `false` | 是否连续阻塞等待 TTS 语音合成完毕再发送后续文本（默认 false 并行） |

---

## 开发与构建

```bash
bun fix
pnpm run build
```
