export type Role = 'user' | 'assistant'

export interface ChatMessage {
  role: Role
  content: string
}

/** Identificador do provedor. Os embutidos são 'codex', 'anthropic' e 'openai'. */
export type ProviderId = string

export interface ModelInfo {
  id: string
  label: string
  description?: string | null
}

export interface ModelCatalog {
  /** 'live' = veio do provedor; 'fallback' = consulta falhou e usamos o modelo padrão. */
  source: 'live' | 'fallback'
  defaultModel: string
  models: ModelInfo[]
}

export interface ConnectionStatus {
  connected: boolean
  /** Texto curto para exibir na UI (e-mail da conta, chave mascarada...). */
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
  /** Permite interromper (botão "Parar"). */
  signal?: AbortSignal
}

export interface Usage {
  inputTokens?: number
  outputTokens?: number
}

export type StreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'done'; text: string; usage?: Usage }

export type AuthKind = 'oauth-device' | 'api-key'

/** Contrato que todo provedor cumpre; é também o ponto de extensão (ex.: Cursor). */
export interface Provider {
  readonly id: ProviderId
  readonly name: string
  readonly auth: AuthKind
  status(): Promise<ConnectionStatus>
  disconnect(): Promise<void>
  listModels(options?: { force?: boolean }): Promise<ModelCatalog>
  stream(request: StreamRequest): AsyncIterable<StreamEvent>
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
