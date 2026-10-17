import { DEFAULT_USER_AGENT, type FetchLike, type ProviderOptions } from '../http.js'
import type { CredentialStorage } from '../storage/types.js'
import { LLMError, type ConnectionStatus, type UsageSnapshot } from '../types.js'

export interface StoredApiKey {
  apiKey: string
  connectedAt: string
}

export const maskKey = (key: string) => (key.length > 12 ? `${key.slice(0, 7)}…${key.slice(-4)}` : '••••')

/** Shared base for API-key providers. */
export abstract class ApiKeyProviderBase {
  protected readonly storage: CredentialStorage
  protected readonly fetchImpl: FetchLike
  protected readonly userAgent: string
  protected readonly baseUrl: string
  private lastUsage: UsageSnapshot | null = null

  constructor(options: ProviderOptions, defaultBaseUrl: string, private readonly storageKey: string) {
    this.storage = options.storage
    this.fetchImpl = options.fetch ?? fetch
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT
    this.baseUrl = (options.baseUrl ?? defaultBaseUrl).replace(/\/+$/, '')
  }

  protected async readKey(): Promise<StoredApiKey | null> {
    const raw = await this.storage.get(this.storageKey)
    if (!raw) return null
    try {
      const value = JSON.parse(raw) as StoredApiKey
      return typeof value.apiKey === 'string' && value.apiKey ? value : null
    } catch {
      return null
    }
  }

  protected async requireKey(): Promise<string> {
    const stored = await this.readKey()
    if (!stored) throw new LLMError('Set an API key for this provider first.', 'not_connected')
    return stored.apiKey
  }

  protected async saveKey(apiKey: string): Promise<ConnectionStatus> {
    const trimmed = apiKey.trim()
    if (trimmed.length < 8 || /\s/.test(trimmed)) throw new LLMError('The API key looks invalid.', 'invalid_request')
    const stored: StoredApiKey = { apiKey: trimmed, connectedAt: new Date().toISOString() }
    await this.storage.set(this.storageKey, JSON.stringify(stored))
    return { connected: true, label: maskKey(trimmed), connectedAt: stored.connectedAt }
  }

  async status(): Promise<ConnectionStatus> {
    const stored = await this.readKey()
    return stored ? { connected: true, label: maskKey(stored.apiKey), connectedAt: stored.connectedAt } : { connected: false }
  }

  async disconnect(): Promise<void> {
    this.lastUsage = null
    await this.storage.delete(this.storageKey)
  }

  /** Reads this provider's rate-limit headers from a response. */
  protected abstract parseRateLimits(headers: Headers): UsageSnapshot | null

  /** Keeps the rate limits a response reported, if any. */
  protected recordRateLimits(response: Response): void {
    this.lastUsage = this.parseRateLimits(response.headers) ?? this.lastUsage
  }

  /**
   * Rate limits from the most recent API response (these APIs have no usage
   * endpoint for regular keys). Null until a request has been made.
   */
  async usage(): Promise<UsageSnapshot | null> {
    return this.lastUsage
  }
}
