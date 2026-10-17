import { errorFromResponse, parseJsonSafe, readJson, send, sseEvents, type ProviderOptions } from '../http.js'
import { LLMError, type ConnectionStatus, type ModelCatalog, type ModelInfo, type Provider, type StreamEvent, type StreamRequest, type Usage, type UsageSnapshot } from '../types.js'
import { parseAnthropicRateLimits } from '../usage.js'
import { ApiKeyProviderBase } from './api-key.js'

const API_VERSION = '2023-06-01'
const FALLBACK_MODEL = 'claude-sonnet-4-5'
const MODELS_TTL_MS = 10 * 60 * 1000

export interface AnthropicOptions extends ProviderOptions {
  /** Model used when the model list cannot be fetched. */
  fallbackModel?: string
  /** Default `max_tokens` (the Anthropic API requires it). */
  defaultMaxTokens?: number
}

/** Claude through the Anthropic API (API key). */
export class AnthropicProvider extends ApiKeyProviderBase implements Provider {
  readonly id = 'anthropic'
  readonly name = 'Claude API'
  readonly auth = 'api-key' as const
  private readonly fallbackModel: string
  private readonly defaultMaxTokens: number
  private modelsCache: { at: number; value: ModelCatalog } | null = null

  constructor(options: AnthropicOptions) {
    super(options, 'https://api.anthropic.com', 'anthropic')
    this.fallbackModel = options.fallbackModel ?? FALLBACK_MODEL
    this.defaultMaxTokens = options.defaultMaxTokens ?? 4096
  }

  protected parseRateLimits(headers: Headers): UsageSnapshot | null {
    return parseAnthropicRateLimits(headers)
  }

  private headers(apiKey: string): Record<string, string> {
    return { 'x-api-key': apiKey, 'anthropic-version': API_VERSION, 'User-Agent': this.userAgent }
  }

  /** Validates the key with a cheap request and stores it if valid. */
  async setApiKey(apiKey: string, { validate = true }: { validate?: boolean } = {}): Promise<ConnectionStatus> {
    const trimmed = apiKey.trim()
    if (validate) {
      const response = await send(this.fetchImpl, `${this.baseUrl}/v1/models?limit=1`, { headers: this.headers(trimmed), timeout: 15_000 }, 'Could not reach Anthropic. Check your connection.')
      if (!response.ok) {
        const error = await errorFromResponse(response, 'Anthropic')
        throw error.code === 'invalid_credentials' ? new LLMError('Anthropic rejected this API key.', 'invalid_credentials', error.status) : error
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
      const response = await send(this.fetchImpl, `${this.baseUrl}/v1/models?limit=100`, { headers: this.headers(apiKey), timeout: 15_000 }, 'network')
      if (response.status === 401 || response.status === 403) throw new LLMError('Anthropic rejected the API key.', 'invalid_credentials', response.status)
      if (response.ok) {
        const data = (await readJson(response)) as { data?: Array<{ id?: string; display_name?: string }> } | null
        const models: ModelInfo[] = (data?.data ?? [])
          .filter((item) => typeof item.id === 'string' && item.id)
          .map((item) => ({ id: item.id as string, label: item.display_name ?? (item.id as string) }))
        if (models.length > 0) value = { source: 'live', defaultModel: models[0]!.id, models }
      }
    } catch (error) {
      if (error instanceof LLMError && error.code === 'invalid_credentials') throw error
    }
    this.modelsCache = { at: Date.now(), value }
    return value
  }

  async *stream(request: StreamRequest): AsyncGenerator<StreamEvent> {
    if (!request.messages?.length) throw new LLMError('No messages to send.', 'invalid_request')
    const apiKey = await this.requireKey()
    const model = request.model || (await this.listModels()).defaultModel
    const body: Record<string, unknown> = {
      model,
      max_tokens: request.maxTokens ?? this.defaultMaxTokens,
      messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
      stream: true,
    }
    if (request.system) body.system = request.system
    if (request.temperature !== undefined) body.temperature = request.temperature

    const response = await send(
      this.fetchImpl,
      `${this.baseUrl}/v1/messages`,
      { method: 'POST', headers: { ...this.headers(apiKey), 'Content-Type': 'application/json', Accept: 'text/event-stream' }, body: JSON.stringify(body), signal: request.signal, timeout: 300_000 },
      'Could not reach Anthropic.',
    )
    this.recordRateLimits(response)
    if (!response.ok) throw await errorFromResponse(response, 'Anthropic')

    let text = ''
    const usage: Usage = {}
    for await (const sse of sseEvents(response.body)) {
      const event = parseJsonSafe(sse.data)
      if (!event) continue
      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta' && typeof event.delta.text === 'string') {
        text += event.delta.text
        yield { type: 'delta', text: event.delta.text }
      } else if (event.type === 'message_start') {
        usage.inputTokens = event.message?.usage?.input_tokens
        usage.outputTokens = event.message?.usage?.output_tokens
      } else if (event.type === 'message_delta' && event.usage) {
        usage.outputTokens = event.usage.output_tokens ?? usage.outputTokens
      } else if (event.type === 'error') {
        const kind = event.error?.type
        throw new LLMError(event.error?.message ?? 'Anthropic failed to respond.', kind === 'rate_limit_error' || kind === 'overloaded_error' ? 'rate_limited' : 'provider_error')
      }
    }
    yield { type: 'done', text, usage }
  }
}
