import type { Logger } from 'kotori-bot'

export interface AbilityContext {
  readonly userId: string
  readonly groupId?: string
  readonly platform: string
  readonly identity: string
  readonly isMaster: boolean
}

export interface AbilityToolDefinition<Args = Record<string, unknown>, Result = unknown> {
  readonly parameters?: Record<string, unknown>
  readonly masterOnly?: boolean
  readonly execute: (args: Args, ctx: AbilityContext) => Promise<Result>
}

// biome-ignore lint/suspicious/noExplicitAny: Required for heterogeneous ability storage with different typed Args
export interface Ability<Args = any, Result = unknown> {
  readonly name: string
  readonly description: string
  readonly provideContext?: (ctx: AbilityContext) => Promise<string | null>
  readonly toolDefinition?: AbilityToolDefinition<Args, Result>
}

export class AbilityManager {
  private readonly abilities: Map<string, Ability> = new Map()

  public constructor(private readonly logger: Logger) {}

  public register(ability: Ability): void {
    this.abilities.set(ability.name, ability)
  }

  public getAbilities(): Ability[] {
    return Array.from(this.abilities.values())
  }

  public async aggregateContext(ctx: AbilityContext): Promise<string[]> {
    const list: string[] = []
    for (const ability of this.abilities.values()) {
      if (!ability.provideContext) continue
      try {
        const result = await ability.provideContext(ctx)
        if (result) list.push(result)
      } catch (err) {
        this.logger
          .label('Ability')
          .error(`${ability.name} provideContext failed:`, err instanceof Error ? err.message : err)
      }
    }
    return list
  }

  public getGeminiFunctionDeclarations(_isMaster: boolean): Record<string, unknown>[] {
    const declarations: Record<string, unknown>[] = []
    for (const ability of this.abilities.values()) {
      if (ability.toolDefinition) {
        declarations.push({
          name: ability.name,
          description: ability.description,
          parameters: ability.toolDefinition.parameters ?? { type: 'OBJECT', properties: {} }
        })
      }
    }
    return declarations
  }

  public async executeTool(name: string, args: unknown, ctx: AbilityContext): Promise<unknown> {
    const ability = this.abilities.get(name)
    if (!ability?.toolDefinition) throw new Error(`Tool ${name} not found`)

    if (ability.toolDefinition.masterOnly && !ctx.isMaster) {
      this.logger?.warn(`Permission denied: non-master user (${ctx.userId}) attempted to call tool [${name}]`)
      return {
        success: false,
        error: 'PERMISSION_DENIED',
        message: `操作失败：当前对话者无权调用此工具。此工具仅限主人可用。`
      }
    }

    return ability.toolDefinition.execute(args, ctx)
  }
}
