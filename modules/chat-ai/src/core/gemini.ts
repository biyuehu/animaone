import type { Content, GenerateContentResponse, Part } from '@google/genai'
import { GoogleGenAI, HarmBlockThreshold, HarmCategory } from '@google/genai'
import type { Context } from 'kotori-bot'
import { ProxyAgent, fetch as undiciFetch } from 'undici'
import type { AbilityContext, AbilityManager } from '../ability'

export interface GeminiClientConfig {
  readonly apiKey: string
  readonly modelName: string
  readonly proxy?: string
  readonly logger?: Context['logger']
}

export class GeminiClient {
  private readonly ai: GoogleGenAI
  private readonly modelName: string
  private readonly logger?: Context['logger']

  constructor(config: GeminiClientConfig) {
    this.modelName = config.modelName
    this.logger = config.logger

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
    maxLoops = 5,
    excludeSilence = false
  ): Promise<string> {
    const isOwner = abilityCtx?.isOwner ?? false
    const tools = abilityManager ? abilityManager.getGeminiFunctionDeclarations(isOwner, excludeSilence) : []

    const mergedHistory: Content[] = []
    for (const h of history) {
      const last = mergedHistory[mergedHistory.length - 1]
      if (last && last.role === h.role && last.parts) {
        last.parts.push({ text: h.content })
      } else {
        mergedHistory.push({ role: h.role, parts: [{ text: h.content }] })
      }
    }

    const lastMerged = mergedHistory[mergedHistory.length - 1]
    const contents: Content[] =
      lastMerged && lastMerged.role === 'user' && lastMerged.parts
        ? [...mergedHistory.slice(0, -1), { role: 'user', parts: [...lastMerged.parts, { text: newMessage }] }]
        : [...mergedHistory, { role: 'user', parts: [{ text: newMessage }] }]

    let loops = 0
    while (loops < maxLoops) {
      loops++
      let response: GenerateContentResponse | null = null
      let retryCount = 0
      const loopStartTime = Date.now()
      this.logger?.debug(
        `Requesting <cyan>${this.modelName}</cyan> (loop <yellow>${loops}</yellow>, tools: <magenta>${tools.length}</magenta>, prompt: <yellow>${systemPrompt.length}</yellow> chars, input: <yellow>${newMessage.length}</yellow> chars)`
      )

      while (retryCount < 2) {
        try {
          response = await this.ai.models.generateContent({
            model: this.modelName,
            contents,
            config: {
              systemInstruction: systemPrompt,
              temperature: 0.7,
              safetySettings: [
                { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
                { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
                { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
                { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
                { category: HarmCategory.HARM_CATEGORY_CIVIC_INTEGRITY, threshold: HarmBlockThreshold.BLOCK_NONE }
              ],
              ...(tools.length > 0 ? { tools: [{ functionDeclarations: tools }] } : {})
            }
          })
          break
        } catch (fetchErr) {
          retryCount++
          this.logger?.warn(
            `API request attempt <yellow>${retryCount}</yellow> failed: <red>${fetchErr instanceof Error ? fetchErr.message : String(fetchErr)}</red>`
          )
          if (retryCount >= 2) throw fetchErr
          await new Promise((r) => setTimeout(r, 1000))
        }
      }

      const loopDuration = Date.now() - loopStartTime
      if (!response) {
        this.logger?.warn(
          `Loop <yellow>${loops}</yellow>: Model returned empty response (<yellow>${loopDuration}ms</yellow>)`
        )
        return ''
      }

      const functionCalls = response.functionCalls
      if (!functionCalls?.length || !abilityManager || !abilityCtx) {
        const candidate = response.candidates?.[0]
        const textParts = candidate?.content?.parts?.filter((p) => typeof p.text === 'string') ?? []
        const textResult =
          textParts
            .map((p) => p.text)
            .join('')
            .trim() ||
          (response.text?.trim() ?? '')
        if (!textResult) {
          const rawData = {
            candidates: response.candidates,
            promptFeedback: response.promptFeedback,
            usageMetadata: response.usageMetadata
          }
          this.logger?.warn(
            `Loop <yellow>${loops}</yellow>: Model returned 0 text chars (<yellow>${loopDuration}ms</yellow>, data: <red>${JSON.stringify(rawData)}</red>)`
          )

          if (response.promptFeedback?.blockReason === 'PROHIBITED_CONTENT') {
            this.logger?.error(
              `PROHIBITED_CONTENT triggered! Dumping request contents:\n` +
                `--- [System Prompt] ---\n${systemPrompt}\n` +
                `--- [Contents (History + Input)] ---\n${JSON.stringify(contents, null, 2)}`
            )
          }
        } else {
          this.logger?.info(
            `Text generated in loop <yellow>${loops}</yellow> (<yellow>${loopDuration}ms</yellow>), response: <green>${textResult.length}</green> chars`
          )
        }
        return textResult
      }

      const callNames = functionCalls.map((c) => `<cyan>${c.name}</cyan>`).join(', ')
      this.logger?.info(
        `Loop <yellow>${loops}</yellow>: Function call triggered [${callNames}] (<yellow>${loopDuration}ms</yellow>)`
      )

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
        const toolStartTime = Date.now()
        try {
          const toolResult = await abilityManager.executeTool(callName, call.args, abilityCtx)
          const toolDuration = Date.now() - toolStartTime
          this.logger?.info(`Tool <cyan>${callName}</cyan> completed in <yellow>${toolDuration}ms</yellow>`)
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
          const toolDuration = Date.now() - toolStartTime
          this.logger?.error(
            `Tool <cyan>${callName}</cyan> failed in <yellow>${toolDuration}ms</yellow>: <red>${err instanceof Error ? err.message : String(err)}</red>`
          )
          functionResponseParts.push({
            functionResponse: { name: callName, response: { error: err instanceof Error ? err.message : String(err) } }
          })
        }
      }

      if (hasSilence) {
        this.logger?.info('<dim>Choose silence activated, suppressing response</dim>')
        return '__NO_REPLY__'
      }

      contents.push({ role: 'user', parts: functionResponseParts })
    }

    this.logger?.warn(`Exceeded max tool loops (<yellow>${maxLoops}</yellow>)`)
    return ''
  }
}
