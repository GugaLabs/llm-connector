import { errorFromResponse, parseJsonSafe, readJson, send, sseEvents, type ProviderOptions } from '../http.js'
import { LLMError, type ConnectionStatus, type ModelCatalog, type ModelInfo, type Provider, type StreamEvent, type StreamRequest, type Usage } from '../types.js'
import { ApiKeyProviderBase } from './api-key.js'

const FALLBACK_MODEL = 'gpt-5'
const MODELS_TTL_MS = 10 * 60 * 1000
const CHAT_MODEL = /^(gpt-|o\d|chatgpt-)/
const NOT_CHAT = /(embedding|tts|whisper|audio|image|realtime|transcribe|moderation|search|dall-e|codex)/

export interface OpenAIOptions extends ProviderOptions {
  fallbackModel?: string
}

/**
 * OpenAI via API (chave). Também serve para endpoints compatíveis com a API da
 * OpenAI: passe `baseUrl` (ex.: um gateway ou servidor local).
 */
export class OpenAIProvider extends ApiKeyProviderBase implements Provider {
  readonly id = 'openai'
  readonly name = 'OpenAI API'
  readonly auth = 'api-key' as const
  private readonly fallbackModel: string
  private modelsCache: { at: number; value: ModelCatalog } | null = null

  constructor(options: OpenAIOptions) {
    super(options, 'https://api.openai.com/v1', 'openai')
    this.fallbackModel = options.fallbackModel ?? FALLBACK_MODEL
  }

  private headers(apiKey: string): Record<string, string> {
    return { Authorization: `Bearer ${apiKey}`, 'User-Agent': this.userAgent }
  }

  async setApiKey(apiKey: string, { validate = true }: { validate?: boolean } = {}): Promise<ConnectionStatus> {
    const trimmed = apiKey.trim()
    if (validate) {
      const response = await send(this.fetchImpl, `${this.baseUrl}/models`, { headers: this.headers(trimmed), timeout: 15_000 }, 'Não foi possível conectar à OpenAI. Verifique sua internet.')
      if (!response.ok) {
        const error = await errorFromResponse(response, 'A OpenAI')
        throw error.code === 'invalid_credentials' ? new LLMError('A OpenAI recusou esta chave de API.', 'invalid_credentials', error.status) : error
      }
    }
    this.modelsCache = null
    return this.saveKey(trimmed)
  }

  async disconnect(): Promise<void> {
    this.modelsCache = null
    await super.disconnect()
  }

  async listModels({ force = false }: { force?: boolean } = {}): Promise<ModelCatalog> {
    const apiKey = await this.requireKey()
    if (!force && this.modelsCache && Date.now() - this.modelsCache.at < MODELS_TTL_MS) return this.modelsCache.value
    let value: ModelCatalog = { source: 'fallback', defaultModel: this.fallbackModel, models: [{ id: this.fallbackModel, label: this.fallbackModel }] }
    try {
      const response = await send(this.fetchImpl, `${this.baseUrl}/models`, { headers: this.headers(apiKey), timeout: 15_000 }, 'rede')
      if (response.status === 401 || response.status === 403) throw new LLMError('A OpenAI recusou a chave de API.', 'invalid_credentials', response.status)
      if (response.ok) {
        const data = (await readJson(response)) as { data?: Array<{ id?: string }> } | null
        const models: ModelInfo[] = (data?.data ?? [])
          .map((item) => item.id)
          .filter((id): id is string => typeof id === 'string' && CHAT_MODEL.test(id) && !NOT_CHAT.test(id))
          .sort()
          .map((id) => ({ id, label: id }))
        if (models.length > 0) {
          value = { source: 'live', defaultModel: models.some((m) => m.id === this.fallbackModel) ? this.fallbackModel : models[0]!.id, models }
        }
      }
    } catch (error) {
      if (error instanceof LLMError && error.code === 'invalid_credentials') throw error
    }
    this.modelsCache = { at: Date.now(), value }
    return value
  }

  async *stream(request: StreamRequest): AsyncGenerator<StreamEvent> {
    if (!request.messages?.length) throw new LLMError('Nenhuma mensagem para enviar.', 'invalid_request')
    const apiKey = await this.requireKey()
    const model = request.model || (await this.listModels()).defaultModel
    const messages = [
      ...(request.system ? [{ role: 'system', content: request.system }] : []),
      ...request.messages.map((m) => ({ role: m.role, content: m.content })),
    ]
    const body: Record<string, unknown> = { model, messages, stream: true, stream_options: { include_usage: true } }
    if (request.maxTokens !== undefined) body.max_completion_tokens = request.maxTokens
    if (request.temperature !== undefined) body.temperature = request.temperature

    const response = await send(
      this.fetchImpl,
      `${this.baseUrl}/chat/completions`,
      { method: 'POST', headers: { ...this.headers(apiKey), 'Content-Type': 'application/json', Accept: 'text/event-stream' }, body: JSON.stringify(body), signal: request.signal, timeout: 300_000 },
      'Não foi possível conectar à OpenAI.',
    )
    if (!response.ok) throw await errorFromResponse(response, 'A OpenAI')

    let text = ''
    let usage: Usage | undefined
    for await (const sse of sseEvents(response.body)) {
      if (sse.data === '[DONE]') break
      const event = parseJsonSafe(sse.data)
      if (!event) continue
      if (event.error) throw new LLMError(event.error.message ?? 'A OpenAI não conseguiu responder.', 'provider_error')
      const delta = event.choices?.[0]?.delta?.content
      if (typeof delta === 'string' && delta) {
        text += delta
        yield { type: 'delta', text: delta }
      }
      if (event.usage) usage = { inputTokens: event.usage.prompt_tokens, outputTokens: event.usage.completion_tokens }
    }
    yield { type: 'done', text, usage }
  }
}
