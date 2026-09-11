import { createOpenAICompatProvider } from '../openai-compat.js'

/**
 * DeepSeek 官方 preset。2026-09-11 实测：GET /models 假 key 401
 * （authentication_error），标准 OpenAI 目录，验 key 即拿目录。
 */
export default createOpenAICompatProvider({
  id: 'deepseek',
  displayName: 'DeepSeek 官方',
  baseURL: 'https://api.deepseek.com/v1',
})
