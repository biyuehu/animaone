import 'dotenv/config'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { stdin as input, stdout as output } from 'node:process'
import * as readline from 'node:readline/promises'
import { GoogleGenAI } from '@google/genai'

// 代理配置：优先读取环境变量 HTTPS_PROXY / HTTP_PROXY，默认为 http://localhost:7897
const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || 'http://localhost:7897'

const apiKey = process.env.GEMINI_API_KEY

if (!apiKey) {
  console.error('❌ 错误: 未找到 GEMINI_API_KEY 环境变量，请在 .env 文件中配置。')
  process.exit(1)
}

// 通过 Bun 原生 fetch 支持代理
const customFetch = (url: any, init: any) =>
  fetch(url, {
    ...init,
    ...(proxyUrl ? { proxy: proxyUrl } : {})
  })

const ai = new GoogleGenAI({
  apiKey,
  httpOptions: {
    fetch: customFetch as any
  }
})

const modelName = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite'

// 读取角色设定：优先环境变量 SYSTEM_INSTRUCTION，其次 system_prompt.txt 文件，最后默认设定
function getSystemInstruction(): string {
  if (process.env.SYSTEM_INSTRUCTION?.trim()) {
    return process.env.SYSTEM_INSTRUCTION.trim()
  }

  const promptFilePath = path.resolve(process.cwd(), 'system_prompt.txt')
  if (fs.existsSync(promptFilePath)) {
    const fileContent = fs.readFileSync(promptFilePath, 'utf-8').trim()
    if (fileContent) {
      return fileContent
    }
  }

  return '你是一个友好且专业的 AI 助手。'
}

async function main() {
  const systemInstruction = getSystemInstruction()

  console.log('==========================================')
  console.log('🤖 Gemini CLI 原型 (Bun + TypeScript)')
  console.log(`📌 当前模型: ${modelName}`)
  console.log(`🌐 代理地址: ${proxyUrl || '未配置 (直连)'}`)
  console.log(`🎭 角色设定: ${systemInstruction.split('\n')[0].slice(0, 30)}...`)
  console.log("💡 输入消息即可对话，输入 '/prompt' 查看完整人设，输入 'exit' 退出")
  console.log('==========================================\n')

  const chat = ai.chats.create({
    model: modelName,
    config: {
      systemInstruction: systemInstruction
    }
  })

  const rl = readline.createInterface({ input, output })

  try {
    while (true) {
      let userInput: string
      try {
        userInput = await rl.question('\n\x1b[32m你:\x1b[0m ')
      } catch {
        break
      }

      const trimmed = userInput.trim()
      if (!trimmed) continue

      if (trimmed.toLowerCase() === 'exit' || trimmed.toLowerCase() === 'quit') {
        console.log('\n👋 退出会话，再见！')
        break
      }

      if (trimmed === '/prompt') {
        console.log(`\n\x1b[33m[当前人设/角色设定]:\x1b[0m\n${systemInstruction}\n`)
        continue
      }

      process.stdout.write('\n\x1b[36mGemini:\x1b[0m ')
      try {
        const stream = await chat.sendMessageStream({
          message: trimmed
        })

        for await (const chunk of stream) {
          process.stdout.write(chunk.text || '')
        }
        process.stdout.write('\n')
      } catch (err: any) {
        console.error('\n❌ 请求发生错误:', err?.message || err)
      }
    }
  } finally {
    rl.close()
  }
}

main()
