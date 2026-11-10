import {
  type Api,
  type ArgsOrigin,
  type Command,
  CommandError,
  type Context,
  type Message,
  MessageList,
  type MessageQuick,
  MessageSingle,
  type OptsOrigin,
  type SendMessageResponse,
  type SessionMsg,
  Symbols,
  UserAccess
} from 'kotori-bot'
import type { Ability, AbilityContext, AbilityManager } from './index'

const COMMAND_BLACKLIST: ReadonlySet<string> = new Set(['shut', 'stop', 'restart', 'reload'])

export function serializeMessage(message: Message): string {
  if (typeof message === 'string') return message
  if (message instanceof MessageList || message instanceof MessageSingle) return message.toString(false)
  return String(message)
}

export class OutputCollector {
  public readonly buffers: string[] = []
  public settled: boolean = false
  public actionFinished: boolean = false
  public timer: NodeJS.Timeout | null = null
  public deadlineTimer: NodeJS.Timeout | null = null
  public onSettleResolve: ((outputs: string[]) => void) | null = null
  public readonly debounceMs: number
  public readonly maxTimeoutMs: number

  public constructor(debounceMs: number, maxTimeoutMs: number) {
    this.debounceMs = debounceMs
    this.maxTimeoutMs = maxTimeoutMs
  }

  public isSettled(): boolean {
    return this.settled
  }

  public push(message: Message): void {
    const text: string = serializeMessage(message).trim()
    if (text.length > 0) this.buffers.push(text)
    if (this.settled) return
    if (this.actionFinished) this.refreshDebounceTimer()
  }

  public refreshDebounceTimer(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => this.settle(), this.debounceMs)
  }

  public settle(): void {
    if (this.settled) return
    this.settled = true
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.deadlineTimer) {
      clearTimeout(this.deadlineTimer)
      this.deadlineTimer = null
    }
    if (this.onSettleResolve) {
      this.onSettleResolve(this.buffers)
      this.onSettleResolve = null
    }
  }

  public waitForSettlement(executionPromise: Promise<void>): Promise<string[]> {
    return new Promise<string[]>((resolve) => {
      this.onSettleResolve = resolve
      this.deadlineTimer = setTimeout(() => this.settle(), this.maxTimeoutMs)
      executionPromise
        .then(() => {
          this.actionFinished = true
          this.refreshDebounceTimer()
        })
        .catch((err: unknown) => {
          this.actionFinished = true
          this.buffers.push(`[Execution Error] ${err instanceof Error ? err.message : String(err)}`)
          this.settle()
        })
    })
  }
}

export function createShadowSession(
  originalSession: SessionMsg,
  commandName: string,
  collector: OutputCollector
): SessionMsg {
  const shadow: SessionMsg = Object.create(originalSession) as SessionMsg
  shadow.message = `/${commandName}`
  Object.defineProperty(shadow, 'api', {
    value: new Proxy(originalSession.api, {
      get(target: Api, prop: string | symbol, receiver: unknown): unknown {
        if (prop === 'sendGroupMsg') {
          return async (message: Message, groupId: string, meta?: object): Promise<SendMessageResponse> => {
            if (!collector.isSettled()) {
              collector.push(message)
              return { messageId: 'shadow-captured-id', time: Date.now() }
            }
            return target.sendGroupMsg(message, groupId, meta)
          }
        }
        if (prop === 'sendPrivateMsg') {
          return async (message: Message, userId: string, meta?: object): Promise<SendMessageResponse> => {
            if (!collector.isSettled()) {
              collector.push(message)
              return { messageId: 'shadow-captured-id', time: Date.now() }
            }
            return target.sendPrivateMsg(message, userId, meta)
          }
        }
        if (prop === 'sendChannelMsg') {
          return async (
            message: Message,
            guildId: string,
            channelId: string,
            meta?: object
          ): Promise<SendMessageResponse> => {
            if (!collector.isSettled()) {
              collector.push(message)
              return { messageId: 'shadow-captured-id', time: Date.now() }
            }
            return target.sendChannelMsg(message, guildId, channelId, meta)
          }
        }
        return Reflect.get(target, prop, receiver)
      }
    }),
    configurable: true,
    writable: true
  })
  shadow.send = async (message: Message): Promise<SendMessageResponse> => {
    if (!collector.isSettled()) {
      collector.push(message)
      return { messageId: 'shadow-captured-id', time: Date.now() }
    }
    return originalSession.send(message)
  }
  return shadow
}

interface GroupSenderRoleCarrier {
  readonly role: 'admin' | 'member' | 'owner'
}

function checkUserAccess(cmdAccess: UserAccess, ctx: AbilityContext, session: SessionMsg | undefined): boolean {
  if (ctx.isMaster) return true
  const sender: unknown = session ? session.sender : undefined
  const roleCarrier: GroupSenderRoleCarrier | undefined =
    typeof sender === 'object' && sender !== null && 'role' in sender ? (sender as GroupSenderRoleCarrier) : undefined
  const userAccess: UserAccess =
    roleCarrier && (roleCarrier.role === 'owner' || roleCarrier.role === 'admin')
      ? UserAccess.MANGER
      : UserAccess.MEMBER
  return userAccess >= cmdAccess
}

function formatCommandArg(arg: Command['meta']['args'][number]): string {
  const inner: string = `${arg.rest ? '...' : ''}${arg.name}${arg.type !== 'string' ? `:${arg.type}` : ''}${
    arg.default !== undefined ? `=${String(arg.default)}` : ''
  }`
  return arg.optional || arg.default !== undefined ? `[${inner}]` : `<${inner}>`
}

function formatCommandOption(opt: Command['meta']['options'][number]): string {
  const flag: string = `-${opt.name}, --${opt.realname}${opt.type === 'boolean' ? '' : ` <${opt.type}>`}`
  return opt.description ? `${flag} (${opt.description})` : flag
}

export function createKotoriSearchCommandsAbility(kotoriCtx: Context): Ability {
  return {
    name: 'kotori_search_commands',
    description:
      'Search available internal Kotori command signatures and manual specifications. Call when encountering specific functional intents (e.g., weather, dice, sign-in, management) but lacking syntax details.',
    toolDefinition: {
      parameters: {
        type: 'OBJECT',
        properties: {
          query: {
            type: 'STRING',
            description: 'Search keyword (e.g., "weather", "roll", "sign"); leave empty for general summary.'
          }
        }
      },
      execute: async (args: Record<string, unknown>, abilityCtx: AbilityContext) => {
        const commands: Set<Command> | undefined = kotoriCtx[Symbols.command]
        if (!commands || commands.size === 0)
          return { success: false, message: 'No executable commands registered in current context.' }
        const rawQuery: string =
          typeof args.query === 'string' && args.query.trim().length > 0 ? args.query.trim().toLowerCase() : ''
        const matchedList: string[] = []
        for (const cmd of commands) {
          if (!cmd.meta.action || cmd.meta.hide || COMMAND_BLACKLIST.has(cmd.meta.root.toLowerCase())) continue
          if (!checkUserAccess(cmd.meta.access, abilityCtx, abilityCtx.session)) continue
          if (cmd.meta.scope !== 'all' && cmd.meta.scope !== undefined && abilityCtx.session) {
            if (cmd.meta.scope !== abilityCtx.session.type) continue
          }
          const root: string = cmd.meta.root.toLowerCase()
          const desc: string = cmd.meta.description ? cmd.meta.description.toLowerCase() : ''
          const help: string = cmd.meta.help ? cmd.meta.help.toLowerCase() : ''
          const isMatched: boolean =
            rawQuery.length === 0 ||
            root.includes(rawQuery) ||
            rawQuery.includes(root) ||
            desc.includes(rawQuery) ||
            help.includes(rawQuery) ||
            cmd.meta.args.some((a) => a.name.toLowerCase().includes(rawQuery)) ||
            cmd.meta.options.some((o) => o.realname.toLowerCase().includes(rawQuery))
          if (!isMatched) continue
          const lines: string[] = [`Command: /${cmd.meta.root} ${cmd.meta.args.map(formatCommandArg).join(' ')}`.trim()]
          if (cmd.meta.description) lines.push(`  Description: ${cmd.meta.description}`)
          if (cmd.meta.options.length > 0)
            lines.push(`  Options: ${cmd.meta.options.map(formatCommandOption).join('; ')}`)
          if (cmd.meta.help) lines.push(`  Help: ${cmd.meta.help.trim()}`)
          matchedList.push(lines.join('\n'))
        }
        if (matchedList.length === 0) return { success: false, message: `No matched commands for query "${rawQuery}".` }
        return { success: true, total: matchedList.length, commands: matchedList.join('\n\n') }
      }
    }
  }
}

export function createKotoriCallCommandAbility(kotoriCtx: Context): Ability {
  return {
    name: 'kotori_call_command',
    description:
      'Execute a target internal Kotori command with structured arguments or raw parameters in memory shadow session.',
    toolDefinition: {
      parameters: {
        type: 'OBJECT',
        properties: {
          command: { type: 'STRING', description: 'Command root identifier (e.g. "weather", "roll")' },
          args: { type: 'OBJECT', description: 'Positional arguments mapped by parameter name' },
          options: { type: 'OBJECT', description: 'Options key-value pairs matching option realname' },
          raw: { type: 'STRING', description: 'Optional raw parameter string to bypass structured arguments' }
        },
        required: ['command']
      },
      execute: async (input: Record<string, unknown>, abilityCtx: AbilityContext) => {
        if (typeof input.command !== 'string' || input.command.trim().length === 0)
          return { success: false, error: 'INVALID_COMMAND', message: 'Target command name must be provided.' }
        const session: SessionMsg | undefined = abilityCtx.session
        if (!session) return { success: false, error: 'NO_SESSION_CONTEXT', message: 'Missing active session context.' }
        const targetRoot: string = input.command.trim().replace(/^\//, '').toLowerCase()
        if (COMMAND_BLACKLIST.has(targetRoot))
          return { success: false, error: 'FORBIDDEN', message: `Command [${targetRoot}] is forbidden.` }
        const commands: Set<Command> | undefined = kotoriCtx[Symbols.command]
        if (!commands || commands.size === 0)
          return { success: false, error: 'NO_COMMANDS', message: 'No registered commands available.' }
        let targetCmd: Command | undefined
        for (const cmd of commands) {
          if (cmd.meta.root.toLowerCase() === targetRoot) {
            targetCmd = cmd
            break
          }
        }
        if (!targetCmd)
          return { success: false, error: 'COMMAND_NOT_FOUND', message: `Command [${targetRoot}] not found.` }
        if (!targetCmd.meta.action)
          return { success: false, error: 'COMMAND_NOT_FOUND', message: `Command [${targetRoot}] not executable.` }
        if (
          targetCmd.meta.scope !== 'all' &&
          targetCmd.meta.scope !== undefined &&
          targetCmd.meta.scope !== session.type
        )
          return {
            success: false,
            error: 'SCOPE_MISMATCH',
            message: `Scope mismatch for command [${targetCmd.meta.root}].`
          }
        if (!checkUserAccess(targetCmd.meta.access, abilityCtx, session))
          return {
            success: false,
            error: 'PERMISSION_DENIED',
            message: `Permission denied for command [${targetCmd.meta.root}].`
          }
        const rawArgsInput: Record<string, unknown> =
          typeof input.args === 'object' && input.args !== null ? (input.args as Record<string, unknown>) : {}
        const rawOptsInput: Record<string, unknown> =
          typeof input.options === 'object' && input.options !== null ? (input.options as Record<string, unknown>) : {}
        const argsArray: ArgsOrigin = []
        for (const argMeta of targetCmd.meta.args) {
          if (
            argMeta.name in rawArgsInput &&
            rawArgsInput[argMeta.name] !== undefined &&
            rawArgsInput[argMeta.name] !== null
          ) {
            const val: unknown = rawArgsInput[argMeta.name]
            if (argMeta.rest && Array.isArray(val)) {
              for (const item of val) {
                argsArray.push(
                  argMeta.type === 'number' ? Number(item) : argMeta.type === 'boolean' ? Boolean(item) : String(item)
                )
              }
            } else {
              argsArray.push(
                argMeta.type === 'number' ? Number(val) : argMeta.type === 'boolean' ? Boolean(val) : String(val)
              )
            }
          } else if (argMeta.default !== undefined) {
            argsArray.push(argMeta.default)
          }
        }
        const optionsObj: OptsOrigin = {}
        for (const optMeta of targetCmd.meta.options) {
          if (
            optMeta.realname in rawOptsInput &&
            rawOptsInput[optMeta.realname] !== undefined &&
            rawOptsInput[optMeta.realname] !== null
          ) {
            const val: unknown = rawOptsInput[optMeta.realname]
            optionsObj[optMeta.realname] =
              optMeta.type === 'number' ? Number(val) : optMeta.type === 'boolean' ? Boolean(val) : String(val)
          }
        }
        const collector: OutputCollector = new OutputCollector(350, 4000)
        const shadowSession: SessionMsg = createShadowSession(session, targetCmd.meta.root, collector)
        const rawLine: string =
          typeof input.raw === 'string' && input.raw.trim().length > 0
            ? `${targetCmd.meta.root} ${input.raw.trim()}`
            : `${targetCmd.meta.root} ${argsArray.join(' ')}`.trim()
        let isCancelled: boolean = false
        kotoriCtx.emit('before_command', {
          command: targetCmd,
          result: { args: argsArray, options: optionsObj },
          raw: rawLine,
          session: shadowSession,
          cancel: () => {
            isCancelled = true
          }
        })
        if (isCancelled)
          return { success: false, error: 'CANCELLED', message: 'Command cancelled by before_command listener.' }
        try {
          const actionPromise: Promise<void> = (async () => {
            if (!targetCmd) return
            if (!targetCmd.meta.action) return
            const executed: MessageQuick = await targetCmd.meta.action(
              { args: argsArray, options: optionsObj },
              shadowSession
            )
            if (executed !== undefined) await shadowSession.quick(executed)
          })()
          const outputs: string[] = await collector.waitForSettlement(actionPromise)
          kotoriCtx.emit('command', {
            command: targetCmd,
            result: outputs.join('\n'),
            raw: rawLine,
            session: shadowSession
          })
          const finalOutput: string = outputs.join('\n').trim()
          return {
            success: true,
            command: targetCmd.meta.root,
            output: finalOutput.length > 0 ? finalOutput : 'Command executed without output.'
          }
        } catch (execError: unknown) {
          kotoriCtx.emit('command', {
            command: targetCmd,
            result:
              execError instanceof CommandError ? execError : new CommandError({ type: 'error', error: execError }),
            raw: rawLine,
            session: shadowSession
          })
          return {
            success: false,
            error: 'EXECUTION_FAILED',
            message: `Command execution failed: ${execError instanceof Error ? execError.message : String(execError)}`
          }
        }
      }
    }
  }
}

export function registerKotoriCommandAbilities(kotoriCtx: Context, abilityManager: AbilityManager): void {
  abilityManager.register(createKotoriSearchCommandsAbility(kotoriCtx))
  abilityManager.register(createKotoriCallCommandAbility(kotoriCtx))
}
