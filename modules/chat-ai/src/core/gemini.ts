import type { Content, GenerateContentResponse, Part } from '@google/genai'
import { GoogleGenAI } from '@google/genai'
import { ProxyAgent, fetch as undiciFetch } from 'undici'
import type { AbilityContext, AbilityManager } from '../ability'

export interface GeminiClientConfig {
  readonly apiKey: string
  readonly modelName?: string
  readonly proxy?: string
}

export class GeminiClient {
  private readonly ai: GoogleGenAI
  private readonly modelName: string

  constructor(config: GeminiClientConfig) {
    this.modelName = config.modelName ?? 'gemini-3.5-flash-lite'

    let fetchFn: typeof fetch | undefined
    if (config.proxy) {
      const proxyUrl = config.proxy.startsWith('http') ? config.proxy : `http://${config.proxy}`
      const agent = new ProxyAgent(proxyUrl)
      // biome-ignore lint/suspicious/noExplicitAny: fetch override requires matching interface
      fetchFn = ((url: any, init: any) => undiciFetch(url, { ...init, dispatcher: agent })) as any
    }

    this.ai = new GoogleGenAI({
      apiKey: config.apiKey,
      ...(fetchFn ? { httpOptions: { fetch: fetchFn } } : {})
    })
  }

  public async chat(
    systemPrompt: string,
    history: { role: 'user' | 'model'; content: string }[],
    newMessage: string,
    abilityManager?: AbilityManager,
    abilityCtx?: AbilityContext,
    maxLoops = 5
  ): Promise<string> {
    const isOwner = abilityCtx?.isOwner ?? false
    const tools = abilityManager ? abilityManager.getGeminiFunctionDeclarations(isOwner) : []
    const contents: Content[] = [
      ...history.map((h) => ({ role: h.role, parts: [{ text: h.content }] })),
      { role: 'user', parts: [{ text: newMessage }] }
    ]

    let loops = 0
    while (loops < maxLoops) {
      loops++
      let response: GenerateContentResponse | null = null
      let retryCount = 0
      while (retryCount < 2) {
        try {
          response = await this.ai.models.generateContent({
            model: this.modelName,
            contents,
            config: {
              systemInstruction: systemPrompt,
              temperature: 0.7,
              ...(tools.length > 0 ? { tools: [{ functionDeclarations: tools }] } : {})
            }
          })
          break
        } catch (fetchErr) {
          retryCount++
          if (retryCount >= 2) throw fetchErr
          await new Promise((r) => setTimeout(r, 1000))
        }
      }

      if (!response) return ''

      const functionCalls = response.functionCalls
      if (!functionCalls?.length || !abilityManager || !abilityCtx) {
        const textParts = response.candidates?.[0]?.content?.parts?.filter((p) => typeof p.text === 'string') ?? []
        const combined = textParts
          .map((p) => p.text)
          .join('')
          .trim()
        if (combined) return combined
        return response.text?.trim() ?? ''
      }

      contents.push(
        response.candidates?.[0]?.content ?? {
          role: 'model',
          parts: functionCalls.map((call) => ({ functionCall: call }))
        }
      )

      let hasSilence = false
      const functionResponseParts: Part[] = []

      for (const call of functionCalls) {
        const callName = call.name ?? ''
        try {
          const toolResult = await abilityManager.executeTool(callName, call.args, abilityCtx)
          if (
            callName === 'choose_silence' ||
            (typeof toolResult === 'object' && toolResult !== null && 'silent' in toolResult && toolResult.silent)
          ) {
            hasSilence = true
            break
          }
          functionResponseParts.push({
            functionResponse: { name: callName, response: { result: toolResult } }
          })
        } catch (err) {
          functionResponseParts.push({
            functionResponse: { name: callName, response: { error: err instanceof Error ? err.message : String(err) } }
          })
        }
      }

      if (hasSilence) return '__NO_REPLY__'

      contents.push({ role: 'user', parts: functionResponseParts })
    }

    return ''
  }
}
