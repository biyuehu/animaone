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
    const contents = [
      ...history.map((h) => ({ role: h.role, parts: [{ text: h.content }] })),
      { role: 'user', parts: [{ text: newMessage }] }
    ]

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
    if (!functionCalls?.length || !abilityManager || !abilityCtx) return response.text ?? '……'

    const call = functionCalls[0]
    const callName = call.name ?? ''
    try {
      const toolResult = await abilityManager.executeTool(callName, call.args, abilityCtx)

      // 如果 AI 主动选择了沉默工具，直接返回静默标记
      if (
        callName === 'choose_silence' ||
        (typeof toolResult === 'object' && toolResult !== null && (toolResult as any).silent)
      ) {
        return '__NO_REPLY__'
      }

      const followUpResponse = await this.ai.models.generateContent({
        model: this.modelName,
        contents: [
          ...contents,
          { role: 'model', parts: [{ functionCall: call }] },
          {
            role: 'user',
            parts: [{ functionResponse: { name: callName, response: { result: toolResult } } }]
          }
        ],
        config: { systemInstruction: systemPrompt, temperature: 0.7 }
      })
      return followUpResponse.text ?? '哼，搞定了，但我不想多说～'
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return `切，调用 ${callName} 翻车了，报错信息是：${msg}。笨蛋大哥哥快去修修你的系统啦！`
    }
  }
}
