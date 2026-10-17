import type { FetchLike } from './http.js'
import { AnthropicProvider, type AnthropicOptions } from './providers/anthropic.js'
import { CodexProvider, type CodexOptions } from './providers/codex.js'
import { OpenAIProvider, type OpenAIOptions } from './providers/openai.js'
import type { CredentialStorage } from './storage/types.js'
import { LLMError, type ConnectionStatus, type ModelCatalog, type Provider, type ProviderId, type StreamEvent, type StreamRequest, type UsageSnapshot } from './types.js'

export interface CreateLLMOptions {
  /** Where tokens/keys are stored (see `createSafeStorageStorage`, `createEncryptedFileStorage`). */
  storage: CredentialStorage
  fetch?: FetchLike
  userAgent?: string
  /** Per-provider settings (base URL, default model, client id...). */
  codex?: Omit<CodexOptions, 'storage'>
  anthropic?: Omit<AnthropicOptions, 'storage'>
  openai?: Omit<OpenAIOptions, 'storage'>
  /** Extra providers (e.g. a Cursor connector) implementing the `Provider` interface. */
  extraProviders?: Provider[]
}

export interface LLM {
  readonly codex: CodexProvider
  readonly anthropic: AnthropicProvider
  readonly openai: OpenAIProvider
  /** All registered providers. */
  readonly providers: Provider[]
  provider(id: ProviderId): Provider
  register(provider: Provider): void
  /** Connection status of every provider, keyed by id. */
  statuses(): Promise<Record<ProviderId, ConnectionStatus>>
  listModels(id: ProviderId, options?: { force?: boolean }): Promise<ModelCatalog>
  /** Usage limits for one provider; null when unknown or unsupported. */
  usage(id: ProviderId): Promise<UsageSnapshot | null>
  /** Usage limits of every connected provider, by id. Failures map to null. */
  usages(): Promise<Record<ProviderId, UsageSnapshot | null>>
  /** Streaming: `for await (const ev of llm.stream('codex', {...}))`. */
  stream(id: ProviderId, request: StreamRequest): AsyncGenerator<StreamEvent>
  /** Full text response. `onDelta` receives each chunk. */
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
    if (!found) throw new LLMError(`Unknown provider: ${id}`, 'invalid_request')
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
    async usage(id) {
      const provider = get(id)
      return provider.usage ? provider.usage() : null
    },
    async usages() {
      const entries = await Promise.all(
        [...registry.values()].map(async (p) => {
          if (!p.usage || !(await p.status()).connected) return [p.id, null] as const
          return [p.id, await p.usage().catch(() => null)] as const
        }),
      )
      return Object.fromEntries(entries)
    },
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
