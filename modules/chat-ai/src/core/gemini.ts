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
    abilityCtx?: AbilityContext
  ): Promise<string> {
    const isOwner = abilityCtx?.isOwner ?? false
    const tools = abilityManager ? abilityManager.getGeminiFunctionDeclarations(isOwner) : []
    const contents: any[] = [
      ...history.map((h) => ({ role: h.role, parts: [{ text: h.content }] })),
      { role: 'user', parts: [{ text: newMessage }] }
    ]

    const MAX_TOOL_LOOPS = 5
    let loops = 0

    while (loops < MAX_TOOL_LOOPS) {
      loops++
      const response = await this.ai.models.generateContent({
        model: this.modelName,
        contents,
        config: {
          systemInstruction: systemPrompt,
          temperature: 0.7,
          ...(tools.length > 0 ? { tools: [{ functionDeclarations: tools }] } : {})
        }
      })

      const functionCalls = response.functionCalls
      // 如果没有工具调用，说明模型生成了最终回复文本
      if (!functionCalls?.length || !abilityManager || !abilityCtx) {
        // 安全提取文本部件，避免在带有非文本 parts 时触发官方 SDK 的 console.warn
        const candidate = response.candidates?.[0]
        const textParts = candidate?.content?.parts?.filter((p: any) => typeof p.text === 'string') ?? []
        if (textParts.length > 0) {
          return textParts
            .map((p: any) => p.text)
            .join('')
            .trim()
        }
        return response.text?.trim() || '……'
      }

      // 执行当前这轮的所有工具调用
      const modelContent = response.candidates?.[0]?.content
      // 保留完整的 modelContent（包含 thoughtSignature 校验签名），避免 400 thought_signature 错误
      const modelTurn = modelContent ?? {
        role: 'model',
        parts: functionCalls.map((call) => ({ functionCall: call }))
      }
      contents.push(modelTurn)

      let hasSilence = false
      const functionResponseParts: any[] = []

      for (const call of functionCalls) {
        const callName = call.name ?? ''
        try {
          const toolResult = await abilityManager.executeTool(callName, call.args, abilityCtx)
          if (
            callName === 'choose_silence' ||
            (typeof toolResult === 'object' && toolResult !== null && (toolResult as any).silent)
          ) {
            hasSilence = true
            break
          }
          functionResponseParts.push({
            functionResponse: { name: callName, response: { result: toolResult } }
          })
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          functionResponseParts.push({
            functionResponse: { name: callName, response: { error: msg } }
          })
        }
      }

      // 如果模型主动选择了保持沉默
      if (hasSilence) {
        return '__NO_REPLY__'
      }

      // 回填所有工具执行结果，准备进入下一轮生成
      contents.push({
        role: 'user',
        parts: functionResponseParts
      })
    }

    // 循环超过上限时的兜底回复，不再使用固定死板的“嗯，已经帮你处理好了～”
    return '好啦，已经替你确认并整理好了。'
  }
}
