export interface AbilityContext {
  readonly userId: string
  readonly groupId?: string
  readonly platform: string
  readonly identity: string
  readonly isOwner: boolean
}

export interface AbilityToolDefinition<Args = Record<string, unknown>, Result = unknown> {
  readonly parameters?: Record<string, unknown>
  readonly ownerOnly?: boolean
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
        console.error(`[Ability] ${ability.name} provideContext failed:`, err instanceof Error ? err.message : err)
      }
    }
    return list
  }

  public getGeminiFunctionDeclarations(isOwner: boolean, excludeSilence = false): Record<string, unknown>[] {
    const declarations: Record<string, unknown>[] = []
    for (const ability of this.abilities.values()) {
      if (ability.toolDefinition) {
        if (ability.toolDefinition.ownerOnly && !isOwner) continue
        if (excludeSilence && ability.name === 'choose_silence') continue
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
    return ability.toolDefinition.execute(args, ctx)
  }
}
