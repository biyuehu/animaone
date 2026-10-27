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
        L0[("Level 0: user_profiles<br/>主人长期事实与画像 (置顶注入 Prompt)")]
        L1[("Level 1: SlidingWindow & DB<br/>近期对话滑窗 (内存 + 引用秒级反查)")]
        L2[("Level 2: memory_nodes & memory_links<br/>长期事件图谱 (10轮/1500字/空闲自动提炼，Graph RAG)")]
        BM25["core/retrieval.ts<br/>Unigram + Bigram + BM25 + 半衰期衰减"]
    end

    subgraph Persona["4. 人设与感知装配 (core/persona.ts)"]
        SysTime["时间感知 (东八区、诞生天数、当前时刻)"]
        Env["环境感知 (群聊/私聊、平台实例、群聊密集水群感知)"]
        Identity["身份分支 (masterPrivate / masterGroup / guestGroup)"]
        Prompt["System Prompt 组装<br/>(L0 核心事实与梦境顿悟装配)"]

        SysTime --> Prompt
        Env --> Prompt
        Identity --> Prompt
        L0 --> Prompt
    end

    Core --> Persona
    Core --> L1

    subgraph Ability["5. 能力与工具系统 (ability/)"]
        Tools["Function Declarations<br/>- recall_master_omniscient_memories (主人全域检索 + 图谱联想)<br/>- recall_channel_public_memories (群内公共记忆检索)<br/>- recall_cross_platform_chat (跨平台原话调取)<br/>- remember_master_fact (主人专属事实沉淀)<br/>- choose_silence (自主静默)<br/>- web_search_or_fetch / terminal / file / messaging"]
    end

    Prompt --> Gemini["6. 核心驱动层 (core/gemini.ts)"]
    L1 --> Gemini
    Tools <-->|"Tool Calls (最多 maxToolLoops 轮)"| Gemini
    BM25 <--> Tools
    L2 <--> Tools

    subgraph Output["7. 响应与后台沉淀"]
        Gemini -->|"__NO_REPLY__"| Drop["静默丢弃"]
        Gemini -->|"文本回复"| Split["分句拆条、拟人半括号与打字延迟 (core/split.ts)"]
        Split --> Session["Session Quick 发送下发"]
        Session -.->|"queueMicrotask (非阻塞异步)"| Record["后台记录与提炼 (memory.recordTurn)"]
    end
```

- **三级分层认知记忆系统（HierarchicalMemory）**
  - **Level 0（核心画像与长期事实）**：存储于 `user_profiles`，无条件注入 Prompt 最高执行区。自动沉淀主人的长期身份、技术偏好、生活习惯，支持带权重的时序更新。
  - **Level 1（活跃对话工作区）**：由 RAM `SlidingWindowMemory` 与 SQLite 双轨驱动，保留最新 `maxTurns` 轮对话，支持群内引用消息（`findQuotedMessage`）的秒级检索，并支持白名单群 0 Token 被动旁听。
  - **Level 2（宏观事件图谱与 Graph RAG）**：存储于 `memory_nodes` 与 `memory_links`。支持每 10 轮交互、1500 字累计超限或空闲超时自动提炼 Day 级核心摘要与概念标签。
  - **夜间潜意识顿悟推演（Dream Reflection）**：凌晨 2~5 点在心跳中自动随机抽取记忆节点进行跨界联想推演，生成灵感并于下一次主人私聊时轻柔提起。

- **多别名触发与智能网关**
  - 支持 `botNames` 字符串数组配置多个触发别名（如 `['λ', '小拉姆达']`），首个元素作为默认名，网关自动匹配并清洗剥离所有别名。
  - 拥有主动交互（`master_direct` / `group_direct`）、群聊跟帖会话窗口（`group_followup`）、偶发主动插嘴（`group_casual`）与密集水群感知（`burstThreshold`）。

- **纯 TS 检索引擎与知识图谱联想**
  - 中文无词典切词（Unigram 单字 + Bigram 双字滑窗）结合停用词表。
  - 标准 BM25 相关度评分结合 30 天指数半衰期时间衰减算法（`rankDocuments`）。
  - 基于概念关联边的有界 BFS 图遍历（`traverseGraph`），驱动模型展开多跳顺藤摸瓜联想。

- **拟真人设与全方位感知**
  - **时间与生命感知**：感知墙上钟时间（东八区）、自身诞生时刻与存活天数。
  - **严格权限隔离**：使用框架统一 `master` 语义，严格区分主人私聊（`masterPrivate`）、主人在群（`masterGroup`）与普通群友（`guestGroup`），严防认错人与隐私泄漏。
  - **拟真打字体验**：支持智能标点分句保护、拟人打字延迟（`enableHumanDelay`）与短句末尾随机半括号变体注入。

- **完备能力工具集（Ability）**
  - `recall_master_omniscient_memories`：主人专用，全域搜索历史事件原话与图谱联想线索。
  - `recall_channel_public_memories`：群友只读，检索当前频道的公开历史与图谱关联记忆。
  - `remember_master_fact`：主人专用，实时沉淀关键事实画像。
  - `recall_cross_platform_chat`：跨平台调取指定会话最新原话。
  - 宿主管理与日常工具：安全终端命令执行（`execute_terminal_command`）、文件读写（`file_read_or_write`）、网络搜索与网页抓取（`web_search_or_fetch`）、群聊静音控制（`set_group_ban`）及主动消息推送（`send_kotori_message`）。

---

## 模块架构

```
modules/chat-ai/src/
├── ability/             # 智能体扩展工具（能力定义、系统状态、网络、终端、文件、消息推送）
│   ├── index.ts         # AbilityManager 管理器与上下文聚合
│   ├── system.ts        # 系统状态监控能力
│   └── tools.ts         # 核心记忆检索、跨平台召回、命令执行等工具集
├── core/                # 基础核与算法层
│   ├── constants.ts     # 默认人设模版与基础配置常量
│   ├── gemini.ts        # Gemini API 通讯、重试与多轮 Function Calling 循环
│   ├── persona.ts       # 动态 System Prompt 组装与感知注入
│   ├── retrieval.ts     # 纯 TS 中文分词、BM25 评分与时间半衰期衰减
│   └── split.ts         # 智能标点分句保护与打字延迟计算
├── gateway/             # 消息网关层
│   └── filter.ts        # 消息准入、白名单校验、多别名剥离与场景判断
├── memory/              # 记忆与存储层
│   ├── context.ts       # 记忆格式化器与 Prompt 渲染
│   ├── index.ts         # HierarchicalMemoryService 记忆服务中枢
│   ├── scope.ts         # 会话作用域 ADT（私聊 / 群聊）与解析器
│   ├── sliding-window.ts# 内存滑动窗口队列与 ChatMessage 构造
│   ├── store.ts         # SQLite 数据库底层（底表初始化、平滑迁移、BFS图遍历）
│   └── summarizer.ts    # 基于大模型的长记忆提炼压缩与画像提取（接入独立 Label Logger）
└── index.tsx            # 插件入口点、Kotori 中间件与生命周期挂载
```

---

## 配置项说明

在 Kotori 配置文件中，可配置以下参数：

| 配置项 | 类型 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- |
| `apiKey` | `string` | **必填** | Google Gemini API Key |
| `modelName` | `string` | `'gemini-3.5-flash-lite'` | 调用的模型名称（建议 Flash 系列保证响应速度） |
| `proxy` | `string` | `undefined` | HTTP/SOCKS 代理地址（如 `http://127.0.0.1:7890`） |
| `whitelistedGroups` | `string[]` | `[]` | 允许对话或旁观插嘴的群号白名单 |
| `allowedPlatforms` | `string[]` | `['cmd', 'onebot']` | 允许接入响应的适配器平台列表 |
| `groupActiveRate` | `number` | `0.05` | 群聊未被叫到时的随机搭话概率（0.0 ~ 1.0） |
| `botNames` | `string[]` | `['λ']` | 机器人名称列表，第一个为默认名，数组所有名字均可唤醒 |
| `masterNick` | `string` | `'大哥哥'` | 对主人的默认基础称呼（优先遵从画像记忆约定） |
| `basePersona` | `string` | *(见常量)* | 基础底色人设设定 |
| `masterPrivate` | `string` | *(见常量)* | 主人私聊环境下的专属人设提示词 |
| `masterGroup` | `string` | *(见常量)* | 主人在群聊环境下的交互人设提示词 |
| `guestGroup` | `string` | *(见常量)* | 普通群友在群聊环境下的交互人设提示词（防认错人） |
| `platformAspects` | `Record<string, string>` | *(见常量)* | 各平台专属风格特质映射 |
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
| `maxToolLoops` | `number` | `10` | 单次交互中允许大模型连续调用工具的最大循环跳数 |

---

## 开发与构建

```bash
# 代码格式化与 Biome 检查
npx @biomejs/biome check --write modules/chat-ai/src

# 编译与构建插件
pnpm run build
```
