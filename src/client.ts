import type { FetchLike } from './http.js'
import { AnthropicProvider, type AnthropicOptions } from './providers/anthropic.js'
import { CodexProvider, type CodexOptions } from './providers/codex.js'
import { OpenAIProvider, type OpenAIOptions } from './providers/openai.js'
import type { CredentialStorage } from './storage/types.js'
import { LLMError, type ConnectionStatus, type ModelCatalog, type Provider, type ProviderId, type StreamEvent, type StreamRequest } from './types.js'

export interface CreateLLMOptions {
  /** Onde guardar tokens/chaves (veja `createSafeStorageStorage`, `createEncryptedFileStorage`). */
  storage: CredentialStorage
  fetch?: FetchLike
  userAgent?: string
  /** Ajustes por provedor (URL base, modelo padrão, client id...). */
  codex?: Omit<CodexOptions, 'storage'>
  anthropic?: Omit<AnthropicOptions, 'storage'>
  openai?: Omit<OpenAIOptions, 'storage'>
  /** Provedores extras (ex.: um conector do Cursor) que seguem a interface `Provider`. */
  extraProviders?: Provider[]
}

export interface LLM {
  readonly codex: CodexProvider
  readonly anthropic: AnthropicProvider
  readonly openai: OpenAIProvider
  /** Todos os provedores registrados. */
  readonly providers: Provider[]
  provider(id: ProviderId): Provider
  register(provider: Provider): void
  /** Estado de conexão de todos os provedores, por id. */
  statuses(): Promise<Record<ProviderId, ConnectionStatus>>
  listModels(id: ProviderId, options?: { force?: boolean }): Promise<ModelCatalog>
  /** Streaming: `for await (const ev of llm.stream('codex', {...}))`. */
  stream(id: ProviderId, request: StreamRequest): AsyncGenerator<StreamEvent>
  /** Resposta completa em texto. `onDelta` recebe cada pedaço. */
  complete(id: ProviderId, request: StreamRequest, onDelta?: (text: string) => void): Promise<string>
}

export function createLLM(options: CreateLLMOptions): LLM {
  const shared = { storage: options.storage, fetch: options.fetch, userAgent: options.userAgent }
  const codex = new CodexProvider({ ...shared, ...options.codex })
  const anthropic = new AnthropicProvider({ ...shared, ...options.anthropic })
  const openai = new OpenAIProvider({ ...shared, ...options.openai })
  const registry = new Map<ProviderId, Provider>()
  for (const p of [codex, anthropic, openai, ...(options.extraProviders ?? [])]) registry.set(p.id, p)

  const get = (id: ProviderId): Provider => {
    const found = registry.get(id)
    if (!found) throw new LLMError(`Provedor desconhecido: ${id}`, 'invalid_request')
    return found
  }

  return {
    codex,
    anthropic,
    openai,
    get providers() {
      return [...registry.values()]
    },
    provider: get,
    register(provider) {
      registry.set(provider.id, provider)
    },
    async statuses() {
      const entries = await Promise.all([...registry.values()].map(async (p) => [p.id, await p.status()] as const))
      return Object.fromEntries(entries)
    },
    listModels: (id, opts) => get(id).listModels(opts),
    stream: (id, request) => get(id).stream(request) as AsyncGenerator<StreamEvent>,
    async complete(id, request, onDelta) {
      let text = ''
      for await (const event of get(id).stream(request)) {
        if (event.type === 'delta') {
          text += event.text
          onDelta?.(event.text)
        } else {
          text = event.text
        }
      }
      return text
    },
  }
}
