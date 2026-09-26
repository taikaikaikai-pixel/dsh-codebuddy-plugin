import { createOpenAICompatProvider } from '../openai-compat.js'

/**
 * Moonshot AI（Kimi）preset。2026-09-11 实测：GET /models 假 key 401
 * （invalid_authentication_error），标准 OpenAI 目录。
 */
export default createOpenAICompatProvider({
  id: 'moonshot',
  displayName: 'Moonshot AI',
  baseURL: 'https://api.moonshot.cn/v1',
})
