import { GoogleGenAI } from '@google/genai'
import type { AbilityContext, AbilityManager } from '../ability'

export interface GeminiClientConfig {
  readonly apiKey: string
  readonly modelName?: string
}

export class GeminiClient {
  private readonly ai: GoogleGenAI
  private readonly modelName: string

  constructor(config: GeminiClientConfig) {
    this.ai = new GoogleGenAI({ apiKey: config.apiKey })
    this.modelName = config.modelName ?? 'gemini-2.5-flash'
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
