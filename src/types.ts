export type Role = 'user' | 'assistant'

export interface ChatMessage {
  role: Role
  content: string
}

/** Provider identifier. Built-in ones are 'codex', 'anthropic' and 'openai'. */
export type ProviderId = string

export interface ModelInfo {
  id: string
  label: string
  description?: string | null
}

export interface ModelCatalog {
  /** 'live' = fetched from the provider; 'fallback' = lookup failed, so the default model is used. */
  source: 'live' | 'fallback'
  defaultModel: string
  models: ModelInfo[]
}

export interface ConnectionStatus {
  connected: boolean
  /** Short text to show in a UI (account e-mail, masked key...). */
  label?: string | null
  email?: string | null
  plan?: string | null
  connectedAt?: string
  expiresAt?: string
}

export interface StreamRequest {
  model?: string
  messages: ChatMessage[]
  system?: string
  maxTokens?: number
  temperature?: number
  /** Lets the caller cancel the request (e.g. a "Stop" button). */
  signal?: AbortSignal
}

export interface Usage {
  inputTokens?: number
  outputTokens?: number
}

export type StreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'done'; text: string; usage?: Usage }

export interface UsageWindow {
  /** Stable id: 'primary'/'secondary' (Codex), 'requests'/'tokens' (API keys), or prefixed for named limits. */
  id: string
  /** Short display label: '5h', 'weekly', 'requests', 'tokens'... */
  label: string
  /** How much of the limit is used, 0-100. */
  usedPercent: number
  /** Absolute numbers, when the provider reports them (API-key rate limits). */
  limit?: number
  remaining?: number
  /** Window length, when known. Needed for `pacing()`. */
  windowSeconds?: number
  /** ISO date when the window resets. */
  resetsAt?: string
}

export interface UsageSnapshot {
  provider: ProviderId
  /** 'live' = queried from a usage endpoint; 'headers' = read from the last API response. */
  source: 'live' | 'headers'
  fetchedAt: string
  plan?: string | null
  /** True when any window is exhausted. */
  limitReached?: boolean
  windows: UsageWindow[]
  credits?: { balance: string | null; hasCredits: boolean; unlimited: boolean }
}

export type AuthKind = 'oauth-device' | 'api-key'

/** Contract every provider implements; also the extension point (e.g. Cursor). */
export interface Provider {
  readonly id: ProviderId
  readonly name: string
  readonly auth: AuthKind
  status(): Promise<ConnectionStatus>
  disconnect(): Promise<void>
  listModels(options?: { force?: boolean }): Promise<ModelCatalog>
  stream(request: StreamRequest): AsyncIterable<StreamEvent>
  /** Current usage limits, or null when nothing is known yet. Optional for custom providers. */
  usage?(): Promise<UsageSnapshot | null>
}

export type LLMErrorCode =
  | 'not_connected'
  | 'reauth_required'
  | 'invalid_credentials'
  | 'rate_limited'
  | 'network'
  | 'invalid_request'
  | 'provider_error'
  | 'flow_expired'
  | 'storage'
  | 'aborted'

export class LLMError extends Error {
  readonly code: LLMErrorCode
  readonly status?: number
  constructor(message: string, code: LLMErrorCode = 'provider_error', status?: number) {
    super(message)
    this.name = 'LLMError'
    this.code = code
    this.status = status
  }
}
