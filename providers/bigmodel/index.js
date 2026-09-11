import { createOpenAICompatProvider } from '../openai-compat.js'

/**
 * 智谱 BigModel preset。OpenAI 兼容端点 = /api/paas/v4；
 * 2026-09-11 实测：GET /models 假 key 401（令牌已过期或验证不正确）。
 */
export default createOpenAICompatProvider({
  id: 'bigmodel',
  displayName: '智谱 BigModel',
  baseURL: 'https://open.bigmodel.cn/api/paas/v4',
})
