import { LLMError, type LLMErrorCode } from './types.js'

export type FetchLike = typeof fetch

export interface ProviderOptions {
  /** Onde guardar tokens/chaves. Obrigatório. */
  storage: import('./storage/types.js').CredentialStorage
  /** Troca o `fetch` (testes, proxies). Padrão: o global. */
  fetch?: FetchLike
  /** Identificação enviada no User-Agent. */
  userAgent?: string
  /** Muda a URL base do provedor (gateways, endpoints compatíveis). */
  baseUrl?: string
}

export const DEFAULT_USER_AGENT = 'llm-connector/0.1'

/** fetch com timeout e erro de rede traduzido para LLMError. */
export async function send(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit & { timeout?: number },
  networkMessage: string,
): Promise<Response> {
  const { timeout = 30_000, signal, ...rest } = init
  const timeoutSignal = AbortSignal.timeout(timeout)
  try {
    return await fetchImpl(url, { ...rest, signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal })
  } catch (error) {
    if (signal?.aborted) throw new LLMError('Requisição cancelada.', 'aborted')
    if (timeoutSignal.aborted) throw new LLMError('A requisição demorou demais e foi interrompida.', 'network')
    void error
    throw new LLMError(networkMessage, 'network')
  }
}

export async function readJson(response: Response): Promise<unknown> {
  const text = await response.text()
  try {
    return text ? JSON.parse(text) : null
  } catch {
    return null
  }
}

function pickMessage(data: unknown): string | null {
  const record = data as { error?: unknown; message?: unknown } | null
  const error = record?.error
  if (typeof error === 'string') return error
  if (error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string') {
    return (error as { message: string }).message
  }
  return typeof record?.message === 'string' ? record.message : null
}

/** Converte uma resposta HTTP de erro em LLMError com código estável. */
export async function errorFromResponse(response: Response, providerName: string): Promise<LLMError> {
  const detail = pickMessage(await readJson(response))
  const status = response.status
  let code: LLMErrorCode = 'provider_error'
  let message = `${providerName} retornou um erro (status ${status}).`
  if (status === 401 || status === 403) {
    code = 'invalid_credentials'
    message = `${providerName} recusou as credenciais.`
  } else if (status === 429) {
    code = 'rate_limited'
    message = `Limite de uso do ${providerName} atingido. Tente mais tarde.`
  } else if (status === 400 || status === 404 || status === 422) {
    code = 'invalid_request'
    message = detail ? `${providerName}: ${detail}` : message
  } else if (detail) {
    message = `${providerName}: ${detail}`
  }
  return new LLMError(message, code, status)
}

export interface SseEvent {
  event: string | null
  data: string
}

/** Lê um corpo `text/event-stream` e emite um evento por bloco. */
export async function* sseEvents(body: ReadableStream<Uint8Array> | null): AsyncGenerator<SseEvent> {
  if (!body) return
  const decoder = new TextDecoder()
  let buffer = ''
  let event: string | null = null
  let data: string[] = []

  const flush = (): SseEvent | null => {
    if (data.length === 0) {
      event = null
      return null
    }
    const out = { event, data: data.join('\n') }
    event = null
    data = []
    return out
  }

  const reader = body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (line === '') {
          const out = flush()
          if (out) yield out
        } else if (line.startsWith('data:')) {
          data.push(line.slice(5).replace(/^ /, ''))
        } else if (line.startsWith('event:')) {
          event = line.slice(6).trim()
        }
      }
    }
    buffer += decoder.decode()
    if (buffer.startsWith('data:')) data.push(buffer.slice(5).replace(/^ /, ''))
    const out = flush()
    if (out) yield out
  } finally {
    reader.releaseLock()
  }
}

export function parseJsonSafe(text: string): Record<string, any> | null {
  try {
    const value = JSON.parse(text)
    return value && typeof value === 'object' ? value : null
  } catch {
    return null
  }
}
