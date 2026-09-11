import { createOpenAICompatProvider } from '../openai-compat.js'

/**
 * OpenRouter preset。2026-09-11 实测：GET /models 是公开目录——任意 key
 * （甚至无 key）都 200 返回全量 437 条，验不了 key 也不宜全量进选择器
 * → staticCatalog：chat 探针验 key（标准 401 方言），清单吃内置精选表。
 * 清单 = 当日目录实况里各厂商旗舰；探针用首项。刷新模型重跑同一逻辑，
 * 目录漂移靠版本更新内置表（错误项聊天时显性暴露，裁判 E-P7）。
 */
export default createOpenAICompatProvider({
  id: 'openrouter',
  displayName: 'OpenRouter',
  baseURL: 'https://openrouter.ai/api/v1',
  staticCatalog: true,
  fallbackModels: [
    'openai/gpt-5.2',
    'anthropic/claude-opus-4.8',
    'anthropic/claude-sonnet-4.6',
    'google/gemini-3.1-pro-preview',
    'deepseek/deepseek-v3.2',
    'moonshotai/kimi-k2.6',
    'z-ai/glm-5.3',
    'qwen/qwen3-max',
    'minimax/minimax-m2.7',
    'x-ai/grok-4.6',
  ],
})
