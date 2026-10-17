import { randomUUID } from 'node:crypto'
import { DEFAULT_USER_AGENT, errorFromResponse, parseJsonSafe, readJson, send, sseEvents, type FetchLike, type ProviderOptions } from '../http.js'
import type { CredentialStorage } from '../storage/types.js'
import { LLMError, type ConnectionStatus, type ModelCatalog, type ModelInfo, type Provider, type StreamEvent, type StreamRequest } from '../types.js'

/*
 * Sign-in with a ChatGPT/Codex subscription (OAuth device code), the same flow as
 * the Codex CLI. No API key: usage counts against the user's ChatGPT plan.
 */
const ISSUER = 'https://auth.openai.com'
const DEFAULT_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const DEFAULT_BASE_URL = 'https://chatgpt.com/backend-api/codex'
const DEFAULT_MODEL = 'gpt-5-codex'
const VERIFICATION_URI = `${ISSUER}/codex/device`
const DEVICE_REDIRECT_URI = `${ISSUER}/deviceauth/callback`
const REFRESH_SKEW_MS = 120_000
const LOGIN_TIMEOUT_MS = 15 * 60 * 1000
const MODELS_TTL_MS = 10 * 60 * 1000
const STORAGE_KEY = 'codex'

export interface CodexOptions extends ProviderOptions {
  clientId?: string
  defaultModel?: string
  /** Version reported to the Codex model catalog. */
  clientVersion?: string
}

interface StoredCodex {
  accessToken: string
  refreshToken: string
  idToken: string | null
  accountId: string | null
  email: string | null
  plan: string | null
  residency: string | null
  expiresAt: number
  connectedAt: string
}

export interface LoginFlow {
  flowId: string
  userCode: string
  verificationUri: string
  /** Seconds between polls. */
  interval: number
  /** Seconds until the code expires. */
  expiresIn: number
}

export type LoginPoll = { status: 'pending'; interval: number } | ({ status: 'connected' } & ConnectionStatus)

interface Flow {
  deviceAuthId: string
  userCode: string
  interval: number
  expiresAt: number
}

function decodeJwt(token: string): Record<string, any> {
  try {
    return JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'))
  } catch {
    return {}
  }
}

function describeTokens(tokens: { access_token: string; id_token?: string }) {
  const access = decodeJwt(tokens.access_token)
  const id = tokens.id_token ? decodeJwt(tokens.id_token) : {}
  const auth = access['https://api.openai.com/auth'] ?? id['https://api.openai.com/auth'] ?? {}
  const profile = access['https://api.openai.com/profile'] ?? {}
  return {
    accountId: typeof auth.chatgpt_account_id === 'string' ? auth.chatgpt_account_id : null,
    plan: typeof auth.chatgpt_plan_type === 'string' ? auth.chatgpt_plan_type : null,
    email: (id.email ?? profile.email ?? null) as string | null,
    expiresAt: typeof access.exp === 'number' ? access.exp * 1000 : Date.now() + 3_600_000,
    residency: (auth.chatgpt_data_residency ?? auth.chatgpt_compute_residency ?? null) as string | null,
  }
}

const toPublic = (c: StoredCodex): ConnectionStatus => ({
  connected: true,
  label: c.email ?? c.plan ?? 'ChatGPT',
  email: c.email,
  plan: c.plan,
  connectedAt: c.connectedAt,
  expiresAt: new Date(c.expiresAt).toISOString(),
})

/** Codex through a ChatGPT subscription (device-code sign-in in the browser). */
export class CodexProvider implements Provider {
  readonly id = 'codex'
  readonly name = 'Codex (ChatGPT subscription)'
  readonly auth = 'oauth-device' as const

  private readonly storage: CredentialStorage
  private readonly fetchImpl: FetchLike
  private readonly userAgent: string
  private readonly baseUrl: string
  private readonly clientId: string
  private readonly defaultModel: string
  private readonly clientVersion: string
  private readonly flows = new Map<string, Flow>()
  private refreshing: Promise<StoredCodex> | null = null
  private modelsCache: { accountId: string | null; at: number; value: ModelCatalog } | null = null

  constructor(options: CodexOptions) {
    this.storage = options.storage
    this.fetchImpl = options.fetch ?? fetch
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
    this.clientId = options.clientId ?? DEFAULT_CLIENT_ID
    this.defaultModel = options.defaultModel ?? DEFAULT_MODEL
    this.clientVersion = options.clientVersion ?? '1.0.0'
  }

  // ---- storage ------------------------------------------------------------

  private async read(): Promise<StoredCodex | null> {
    const raw = await this.storage.get(STORAGE_KEY)
    if (!raw) return null
    const value = parseJsonSafe(raw) as StoredCodex | null
    return value && typeof value.accessToken === 'string' && typeof value.refreshToken === 'string' ? value : null
  }

  private toStored(tokens: any, previous?: StoredCodex | null): StoredCodex {
    const refreshToken = tokens?.refresh_token ?? previous?.refreshToken
    if (!tokens?.access_token || !refreshToken) throw new LLMError('OpenAI returned an incomplete sign-in response.', 'provider_error')
    const details = describeTokens(tokens)
    return {
      accessToken: tokens.access_token,
      refreshToken,
      idToken: tokens.id_token ?? previous?.idToken ?? null,
      accountId: details.accountId ?? previous?.accountId ?? null,
      email: details.email ?? previous?.email ?? null,
      plan: details.plan ?? previous?.plan ?? null,
      residency: details.residency ?? previous?.residency ?? null,
      expiresAt: details.expiresAt,
      connectedAt: previous?.connectedAt ?? new Date().toISOString(),
    }
  }

  private async post(url: string, body: Record<string, string>, form = false) {
    const response = await send(
      this.fetchImpl,
      url,
      {
        method: 'POST',
        timeout: 15_000,
        headers: { 'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json', Accept: 'application/json', 'User-Agent': this.userAgent },
        body: form ? new URLSearchParams(body).toString() : JSON.stringify(body),
      },
      'Could not reach OpenAI. Check your connection and try again.',
    )
    return { status: response.status, ok: response.ok, data: (await readJson(response)) as any }
  }

  // ---- sign-in (device code) ----------------------------------------------

  /** Step 1: request a code. Show `userCode` to the user and open `verificationUri`. */
  async startLogin(): Promise<LoginFlow> {
    this.flows.clear()
    const { status, data } = await this.post(`${ISSUER}/api/accounts/deviceauth/usercode`, { client_id: this.clientId })
    if (status === 404) throw new LLMError('Device-code sign-in is not enabled for this account or organization.', 'provider_error', status)
    if (status === 429) throw new LLMError('Too many attempts. Wait a moment and try again.', 'rate_limited', status)
    const userCode = data?.user_code ?? data?.usercode
    if (status !== 200 || !data?.device_auth_id || !userCode) throw new LLMError(`Could not start sign-in (status ${status}).`, 'provider_error', status)
    const flowId = randomUUID()
    const interval = Math.max(3, Number.parseInt(data.interval, 10) || 5)
    this.flows.set(flowId, { deviceAuthId: data.device_auth_id, userCode, interval, expiresAt: Date.now() + LOGIN_TIMEOUT_MS })
    return { flowId, userCode, verificationUri: VERIFICATION_URI, interval, expiresIn: LOGIN_TIMEOUT_MS / 1000 }
  }

  /** Step 2: poll once. Repeat every `interval` seconds until `connected`. */
  async pollLogin(flowId: string): Promise<LoginPoll> {
    const flow = this.flows.get(flowId)
    if (!flow) throw new LLMError('This sign-in expired or was cancelled. Start again.', 'flow_expired')
    if (Date.now() > flow.expiresAt) {
      this.flows.delete(flowId)
      throw new LLMError('The code expired. Start again.', 'flow_expired')
    }
    const poll = await this.post(`${ISSUER}/api/accounts/deviceauth/token`, { device_auth_id: flow.deviceAuthId, user_code: flow.userCode })
    if (poll.status === 403 || poll.status === 404) return { status: 'pending', interval: flow.interval }
    if (poll.status === 429) return { status: 'pending', interval: flow.interval + 5 }
    if (poll.status !== 200 || !poll.data?.authorization_code || !poll.data?.code_verifier) {
      this.flows.delete(flowId)
      throw new LLMError(`Authorization failed (status ${poll.status}).`, 'provider_error', poll.status)
    }
    const exchange = await this.post(
      `${ISSUER}/oauth/token`,
      { grant_type: 'authorization_code', code: poll.data.authorization_code, redirect_uri: DEVICE_REDIRECT_URI, client_id: this.clientId, code_verifier: poll.data.code_verifier },
      true,
    )
    this.flows.delete(flowId)
    if (!exchange.ok) throw new LLMError(`Could not complete sign-in (status ${exchange.status}).`, 'provider_error', exchange.status)
    const stored = this.toStored(exchange.data)
    await this.storage.set(STORAGE_KEY, JSON.stringify(stored))
    this.modelsCache = null
    return { status: 'connected', ...toPublic(stored) }
  }

  cancelLogin(flowId: string): void {
    this.flows.delete(flowId)
  }

  /**
   * Shortcut for both steps: calls `onCode` with the code (so the UI can show it
   * or open the browser) and waits for authorization.
   */
  async login(options: { onCode?: (flow: LoginFlow) => void | Promise<void>; signal?: AbortSignal } = {}): Promise<ConnectionStatus> {
    const flow = await this.startLogin()
    await options.onCode?.(flow)
    let interval = flow.interval
    try {
      for (;;) {
        await new Promise<void>((resolve, reject) => {
          const abort = () => { clearTimeout(timer); reject(new LLMError('Sign-in cancelled.', 'aborted')) }
          const timer = setTimeout(resolve, interval * 1000)
          if (options.signal?.aborted) return abort()
          options.signal?.addEventListener('abort', abort, { once: true })
        })
        const result = await this.pollLogin(flow.flowId)
        if (result.status === 'connected') {
          const { status: _status, ...connection } = result
          return connection
        }
        interval = result.interval
      }
    } finally {
      this.cancelLogin(flow.flowId)
    }
  }

  // ---- session -------------------------------------------------------------

  async status(): Promise<ConnectionStatus> {
    const stored = await this.read()
    return stored ? toPublic(stored) : { connected: false }
  }

  async disconnect(): Promise<void> {
    this.modelsCache = null
    await this.storage.delete(STORAGE_KEY)
  }

  /** Checks the session, refreshing it if needed. */
  async test(): Promise<ConnectionStatus> {
    return toPublic(await this.freshCredentials())
  }

  private async refresh(credentials: StoredCodex): Promise<StoredCodex> {
    const result = await this.post(`${ISSUER}/oauth/token`, { grant_type: 'refresh_token', refresh_token: credentials.refreshToken, client_id: this.clientId }, true)
    if (result.status === 429) throw new LLMError('OpenAI is temporarily rate limiting token refresh. Try again shortly.', 'rate_limited', 429)
    if (!result.ok) {
      const code = result.data?.error?.code ?? result.data?.error
      if ([400, 401, 403].includes(result.status) || code === 'invalid_grant') {
        await this.storage.delete(STORAGE_KEY)
        throw new LLMError('Your ChatGPT session expired. Sign in again.', 'reauth_required', result.status)
      }
      throw new LLMError(`Could not refresh the session (status ${result.status}).`, 'provider_error', result.status)
    }
    const next = this.toStored(result.data, credentials)
    await this.storage.set(STORAGE_KEY, JSON.stringify(next))
    return next
  }

  private async freshCredentials(): Promise<StoredCodex> {
    const credentials = await this.read()
    if (!credentials) throw new LLMError('Connect your ChatGPT/Codex subscription first.', 'not_connected')
    if (credentials.expiresAt - Date.now() > REFRESH_SKEW_MS) return credentials
    // Refresh tokens rotate: never refresh twice at the same time.
    this.refreshing ??= this.refresh(credentials).finally(() => { this.refreshing = null })
    return this.refreshing
  }

  private authHeaders(c: StoredCodex): Record<string, string> {
    const headers: Record<string, string> = { Authorization: `Bearer ${c.accessToken}`, originator: 'llm-connector', 'User-Agent': this.userAgent }
    if (c.accountId) headers['ChatGPT-Account-ID'] = c.accountId
    if (c.residency) headers['x-openai-internal-codex-residency'] = c.residency
    return headers
  }

  // ---- models --------------------------------------------------------------

  async listModels({ force = false }: { force?: boolean } = {}): Promise<ModelCatalog> {
    const credentials = await this.freshCredentials()
    if (!force && this.modelsCache && this.modelsCache.accountId === credentials.accountId && Date.now() - this.modelsCache.at < MODELS_TTL_MS) {
      return this.modelsCache.value
    }
    let value: ModelCatalog = { source: 'fallback', defaultModel: this.defaultModel, models: [{ id: this.defaultModel, label: this.defaultModel }] }
    try {
      const response = await send(this.fetchImpl, `${this.baseUrl}/models?client_version=${encodeURIComponent(this.clientVersion)}`, { headers: { ...this.authHeaders(credentials), Accept: 'application/json' }, timeout: 15_000 }, 'network')
      if (response.status === 401) throw new LLMError('Codex rejected the session. Sign in again.', 'reauth_required', 401)
      if (response.ok) {
        const models = parseModels(await readJson(response))
        if (models.length > 0) value = { source: 'live', defaultModel: models.some((m) => m.id === this.defaultModel) ? this.defaultModel : models[0]!.id, models }
      }
    } catch (error) {
      if (error instanceof LLMError && error.code === 'reauth_required') throw error
    }
    this.modelsCache = { accountId: credentials.accountId, at: Date.now(), value }
    return value
  }

  // ---- inference -----------------------------------------------------------

  async *stream(request: StreamRequest): AsyncGenerator<StreamEvent> {
    if (!request.messages?.length) throw new LLMError('No messages to send.', 'invalid_request')
    const credentials = await this.freshCredentials()
    const response = await send(
      this.fetchImpl,
      `${this.baseUrl}/responses`,
      {
        method: 'POST',
        headers: { ...this.authHeaders(credentials), 'Content-Type': 'application/json', Accept: 'text/event-stream', 'OpenAI-Beta': 'responses=experimental' },
        body: JSON.stringify({
          model: request.model || this.defaultModel,
          instructions: request.system || 'You are a helpful assistant.',
          input: request.messages.map((m) =>
            m.role === 'assistant'
              ? { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: m.content }] }
              : { type: 'message', role: 'user', content: [{ type: 'input_text', text: m.content }] },
          ),
          tools: [],
          tool_choice: 'auto',
          parallel_tool_calls: false,
          store: false,
          stream: true,
        }),
        signal: request.signal,
        timeout: 300_000,
      },
      'Could not reach Codex.',
    )
    if (response.status === 401) throw new LLMError('Codex rejected the session. Sign in again.', 'reauth_required', 401)
    if (!response.ok) throw await errorFromResponse(response, 'Codex')

    let text = ''
    for await (const sse of sseEvents(response.body)) {
      const event = parseJsonSafe(sse.data)
      if (!event) continue
      if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') {
        text += event.delta
        yield { type: 'delta', text: event.delta }
      } else if (event.type === 'response.failed' || event.type === 'error') {
        throw new LLMError(event.response?.error?.message ?? event.message ?? 'Codex failed to respond.', 'provider_error')
      } else if (event.type === 'response.completed') {
        const u = event.response?.usage
        yield { type: 'done', text, usage: u ? { inputTokens: u.input_tokens, outputTokens: u.output_tokens } : undefined }
        return
      }
    }
    yield { type: 'done', text }
  }
}

function parseModels(data: unknown): ModelInfo[] {
  const record = data as { models?: unknown; data?: unknown } | null
  const list = Array.isArray(record?.models) ? record.models : Array.isArray(record?.data) ? record.data : []
  const seen = new Set<string>()
  return (list as any[])
    .filter((item) => item && !['hide', 'hidden'].includes(String(item.visibility ?? '').toLowerCase()) && item.supported_in_api !== false)
    .map((item) => ({
      id: String(item.slug ?? item.id ?? ''),
      label: String(item.display_name ?? item.title ?? item.slug ?? item.id ?? ''),
      description: typeof item.description === 'string' ? item.description.slice(0, 200) : null,
    }))
    .filter((model) => model.id && !seen.has(model.id) && seen.add(model.id))
}
