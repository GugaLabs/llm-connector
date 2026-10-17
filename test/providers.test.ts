import { afterEach, describe, expect, it, vi } from 'vitest'
import { createLLM, createMemoryStorage, LLMError } from '../src/index.js'
import { collect, json, jwt, mockFetch, sse } from './helpers.js'

const messages = [{ role: 'user' as const, content: 'hi' }]
const storedKey = (apiKey: string) => JSON.stringify({ apiKey, connectedAt: 'x' })

afterEach(() => {
  vi.restoreAllMocks()
})

describe('anthropic', () => {
  it('validates the key, lists models and streams', async () => {
    const { fetch, calls } = mockFetch([
      (url, init) => {
        const key = (init.headers as Record<string, string>)['x-api-key']
        if (url.includes('/v1/models')) return key === 'sk-ant-good-key-1234' ? json({ data: [{ id: 'claude-x', display_name: 'Claude X' }] }) : json({ error: { message: 'bad' } }, 401)
      },
      (url) => url.endsWith('/v1/messages')
        ? sse([
            { event: 'message_start', data: { type: 'message_start', message: { usage: { input_tokens: 5 } } } },
            { event: 'content_block_delta', data: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } } },
            { event: 'content_block_delta', data: { type: 'content_block_delta', delta: { type: 'text_delta', text: ' world' } } },
            { event: 'message_delta', data: { type: 'message_delta', usage: { output_tokens: 3 } } },
          ])
        : undefined,
    ])
    const llm = createLLM({ storage: createMemoryStorage(), fetch })

    await expect(llm.anthropic.setApiKey('sk-ant-bad-key-0000')).rejects.toMatchObject({ code: 'invalid_credentials' })
    expect((await llm.anthropic.status()).connected).toBe(false)
    await expect(collect(llm.stream('anthropic', { messages }))).rejects.toMatchObject({ code: 'not_connected' })

    const status = await llm.anthropic.setApiKey('sk-ant-good-key-1234')
    expect(status.connected).toBe(true)
    expect(status.label).not.toContain('good-key')
    expect((await llm.listModels('anthropic')).models[0]).toMatchObject({ id: 'claude-x', label: 'Claude X' })

    const deltas: string[] = []
    const text = await llm.complete('anthropic', { messages, system: 'be brief' }, (d) => deltas.push(d))
    expect(text).toBe('Hello world')
    expect(deltas).toEqual(['Hello', ' world'])
    const sent = JSON.parse(String(calls.at(-1)!.init.body))
    expect(sent).toMatchObject({ model: 'claude-x', system: 'be brief', stream: true })
    expect(sent.max_tokens).toBeGreaterThan(0)

    const events = await collect(llm.stream('anthropic', { messages }))
    expect(events.at(-1)).toMatchObject({ type: 'done', usage: { inputTokens: 5, outputTokens: 3 } })

    await llm.anthropic.disconnect()
    expect((await llm.anthropic.status()).connected).toBe(false)
  })

  it('maps 429 and network failures', async () => {
    const storage = createMemoryStorage({ anthropic: storedKey('sk-ant-xxxxxxxx') })
    const rate = createLLM({ storage, fetch: mockFetch([(u) => (u.endsWith('/v1/models?limit=100') ? json({}, 500) : u.endsWith('/v1/messages') ? json({ error: { message: 'x' } }, 429) : undefined)]).fetch })
    await expect(collect(rate.stream('anthropic', { model: 'm', messages }))).rejects.toMatchObject({ code: 'rate_limited' })
    const down = createLLM({ storage, fetch: (async () => { throw new TypeError('fail') }) as typeof fetch })
    await expect(collect(down.stream('anthropic', { model: 'm', messages }))).rejects.toMatchObject({ code: 'network' })
  })

  it('cancels through AbortSignal', async () => {
    const storage = createMemoryStorage({ anthropic: storedKey('sk-ant-xxxxxxxx') })
    const ctrl = new AbortController()
    const fetch = ((_u: any, init: RequestInit) => new Promise((_res, rej) => {
      if (init.signal!.aborted) return rej(new Error('abort')) // like the real fetch
      init.signal!.addEventListener('abort', () => rej(new Error('abort')))
    })) as unknown as typeof globalThis.fetch
    const llm = createLLM({ storage, fetch })
    const p = collect(llm.stream('anthropic', { model: 'm', messages, signal: ctrl.signal }))
    ctrl.abort()
    await expect(p).rejects.toMatchObject({ code: 'aborted' })
  })

  it('maps in-stream overloaded errors to rate_limited and other errors to provider_error', async () => {
    const storage = createMemoryStorage({ anthropic: storedKey('sk-ant-xxxxxxxx') })
    const streamWith = (type: string) => createLLM({
      storage,
      fetch: mockFetch([(u) => u.endsWith('/v1/messages') ? sse([{ event: 'error', data: { type: 'error', error: { type, message: 'boom' } } }]) : undefined]).fetch,
    })
    await expect(collect(streamWith('overloaded_error').stream('anthropic', { model: 'm', messages }))).rejects.toMatchObject({ code: 'rate_limited', message: 'boom' })
    await expect(collect(streamWith('api_error').stream('anthropic', { model: 'm', messages }))).rejects.toMatchObject({ code: 'provider_error' })
  })

  it('rejects an empty conversation before calling the API', async () => {
    const { fetch, calls } = mockFetch([])
    const llm = createLLM({ storage: createMemoryStorage({ anthropic: storedKey('sk-ant-xxxxxxxx') }), fetch })
    await expect(collect(llm.stream('anthropic', { messages: [] }))).rejects.toMatchObject({ code: 'invalid_request' })
    expect(calls).toHaveLength(0)
  })

  it('caches the model list until forced, and surfaces a revoked key', async () => {
    let revoked = false
    const { fetch, calls } = mockFetch([(u) => u.includes('/v1/models') ? (revoked ? json({}, 401) : json({ data: [{ id: 'claude-x' }] })) : undefined])
    const llm = createLLM({ storage: createMemoryStorage({ anthropic: storedKey('sk-ant-xxxxxxxx') }), fetch })
    await llm.listModels('anthropic')
    await llm.listModels('anthropic')
    expect(calls).toHaveLength(1)
    revoked = true
    await expect(llm.listModels('anthropic', { force: true })).rejects.toMatchObject({ code: 'invalid_credentials' })
    expect(calls).toHaveLength(2)
  })

  it('stores a key without validation and refuses malformed keys', async () => {
    const { fetch, calls } = mockFetch([])
    const llm = createLLM({ storage: createMemoryStorage(), fetch })
    await expect(llm.anthropic.setApiKey('short', { validate: false })).rejects.toMatchObject({ code: 'invalid_request' })
    await expect(llm.anthropic.setApiKey('has a space in it', { validate: false })).rejects.toMatchObject({ code: 'invalid_request' })
    const status = await llm.anthropic.setApiKey('  sk-ant-trimmed-key-9999  ', { validate: false })
    expect(status).toMatchObject({ connected: true, label: 'sk-ant-…9999' })
    expect(calls).toHaveLength(0)
  })
})

describe('openai', () => {
  it('lists chat models only, streams with usage and supports baseUrl', async () => {
    const { fetch, calls } = mockFetch([
      (url) => url === 'https://gw.test/v1/models' ? json({ data: [{ id: 'gpt-5' }, { id: 'text-embedding-3' }, { id: 'o4-mini' }, { id: 'whisper-1' }] }) : undefined,
      (url) => url === 'https://gw.test/v1/chat/completions'
        ? sse([
            { data: { choices: [{ delta: { content: 'Hi' } }] } },
            { data: { choices: [{ delta: { content: '!' } }] } },
            { data: { choices: [], usage: { prompt_tokens: 4, completion_tokens: 2 } } },
            '[DONE]',
          ])
        : undefined,
    ])
    const llm = createLLM({ storage: createMemoryStorage(), fetch, openai: { baseUrl: 'https://gw.test/v1/' } })
    await llm.openai.setApiKey('sk-openai-1234567')
    const catalog = await llm.listModels('openai')
    expect(catalog.models.map((m) => m.id)).toEqual(['gpt-5', 'o4-mini'])
    expect(catalog.defaultModel).toBe('gpt-5')
    const events = await collect(llm.stream('openai', { messages, system: 'sys' }))
    expect(events.at(-1)).toEqual({ type: 'done', text: 'Hi!', usage: { inputTokens: 4, outputTokens: 2 } })
    const body = JSON.parse(String(calls.at(-1)!.init.body))
    expect(body.messages[0]).toEqual({ role: 'system', content: 'sys' })
    expect((calls.at(-1)!.init.headers as Record<string, string>).Authorization).toBe('Bearer sk-openai-1234567')
  })

  it('falls back to the default model when the list fails', async () => {
    const storage = createMemoryStorage({ openai: storedKey('sk-openai-1234567') })
    const llm = createLLM({ storage, fetch: mockFetch([() => json({}, 500)]).fetch })
    expect(await llm.listModels('openai')).toMatchObject({ source: 'fallback', defaultModel: 'gpt-5' })
  })

  it('sends maxTokens and temperature, and skips the model lookup when a model is given', async () => {
    const { fetch, calls } = mockFetch([(u) => u.endsWith('/chat/completions') ? sse(['[DONE]']) : undefined])
    const llm = createLLM({ storage: createMemoryStorage({ openai: storedKey('sk-openai-1234567') }), fetch })
    await collect(llm.stream('openai', { model: 'gpt-x', messages, maxTokens: 50, temperature: 0.2 }))
    expect(calls).toHaveLength(1)
    expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({ model: 'gpt-x', max_completion_tokens: 50, temperature: 0.2 })
  })

  it('throws on an error event inside the stream', async () => {
    const fetch = mockFetch([(u) => u.endsWith('/chat/completions') ? sse([{ data: { error: { message: 'quota' } } }]) : undefined]).fetch
    const llm = createLLM({ storage: createMemoryStorage({ openai: storedKey('sk-openai-1234567') }), fetch })
    await expect(collect(llm.stream('openai', { model: 'm', messages }))).rejects.toMatchObject({ code: 'provider_error', message: 'quota' })
  })

  it('reports a rejected key as invalid_credentials', async () => {
    const llm = createLLM({ storage: createMemoryStorage(), fetch: mockFetch([() => json({ error: { message: 'nope' } }, 401)]).fetch })
    await expect(llm.openai.setApiKey('sk-openai-1234567')).rejects.toMatchObject({ code: 'invalid_credentials', status: 401 })
  })
})

describe('codex', () => {
  const access = (extra: object = {}, exp = Math.floor(Date.now() / 1000) + 3600) =>
    jwt({ exp, 'https://api.openai.com/auth': { chatgpt_account_id: 'acc1', chatgpt_plan_type: 'plus' }, 'https://api.openai.com/profile': { email: 'a@b.com' }, ...extra })

  const fresh = (extra: object = {}) => JSON.stringify({ accessToken: access(), refreshToken: 'r', idToken: null, accountId: 'acc1', email: null, plan: null, residency: null, expiresAt: Date.now() + 3_600_000, connectedAt: 'x', ...extra })

  const loginRoutes = (counter = { polls: 0, refresh: 0 }) => [
    (url: string) => url.endsWith('/deviceauth/usercode') ? json({ device_auth_id: 'dev1', user_code: 'ABCD-1234', interval: '3' }) : undefined,
    (url: string) => url.endsWith('/deviceauth/token') ? (++counter.polls < 2 ? json({}, 403) : json({ authorization_code: 'code', code_verifier: 'ver' })) : undefined,
    (url: string, init: RequestInit) => {
      if (!url.endsWith('/oauth/token')) return
      const form = new URLSearchParams(String(init.body))
      if (form.get('grant_type') === 'refresh_token') { counter.refresh++; return json({ access_token: access(), refresh_token: 'r2' }) }
      return json({ access_token: access(), refresh_token: 'r1', id_token: jwt({ email: 'a@b.com' }) })
    },
  ]

  it('signs in with a device code in two steps and keeps tokens out of status', async () => {
    const storage = createMemoryStorage()
    const llm = createLLM({ storage, fetch: mockFetch(loginRoutes()).fetch })
    const flow = await llm.codex.startLogin()
    expect(flow.userCode).toBe('ABCD-1234')
    expect(await llm.codex.pollLogin(flow.flowId)).toMatchObject({ status: 'pending' })
    const done = await llm.codex.pollLogin(flow.flowId)
    expect(done).toMatchObject({ status: 'connected', email: 'a@b.com', plan: 'plus' })
    expect(JSON.stringify(await llm.codex.status())).not.toMatch(/token/i)
    await expect(llm.codex.pollLogin(flow.flowId)).rejects.toMatchObject({ code: 'flow_expired' })
  })

  it('maps device-code start failures', async () => {
    const start = (status: number) => createLLM({ storage: createMemoryStorage(), fetch: mockFetch([() => json({}, status)]).fetch }).codex.startLogin()
    await expect(start(404)).rejects.toMatchObject({ code: 'provider_error', status: 404 })
    await expect(start(429)).rejects.toMatchObject({ code: 'rate_limited' })
    await expect(start(500)).rejects.toMatchObject({ code: 'provider_error', status: 500 })
  })

  it('backs off when polling is rate limited and expires old flows', async () => {
    const llm = createLLM({
      storage: createMemoryStorage(),
      fetch: mockFetch([
        (u) => u.endsWith('/deviceauth/usercode') ? json({ device_auth_id: 'd', user_code: 'C', interval: '4' }) : undefined,
        (u) => u.endsWith('/deviceauth/token') ? json({}, 429) : undefined,
      ]).fetch,
    })
    const flow = await llm.codex.startLogin()
    expect(await llm.codex.pollLogin(flow.flowId)).toEqual({ status: 'pending', interval: 9 })
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now + 16 * 60 * 1000)
    await expect(llm.codex.pollLogin(flow.flowId)).rejects.toMatchObject({ code: 'flow_expired' })
  })

  it('login() reports the code and can be aborted', async () => {
    const llm = createLLM({ storage: createMemoryStorage(), fetch: mockFetch(loginRoutes()).fetch })
    const ctrl = new AbortController()
    const seen: string[] = []
    const pending = llm.codex.login({ signal: ctrl.signal, onCode: (f) => { seen.push(f.userCode); ctrl.abort() } })
    await expect(pending).rejects.toMatchObject({ code: 'aborted' })
    expect(seen).toEqual(['ABCD-1234'])
  })

  it('refreshes an expired token only once, even with concurrent calls', async () => {
    const counter = { polls: 5, refresh: 0 }
    const stored = { accessToken: access({}, 1), refreshToken: 'r1', idToken: null, accountId: 'acc1', email: 'a@b.com', plan: 'plus', residency: null, expiresAt: Date.now() - 1000, connectedAt: 'x' }
    const storage = createMemoryStorage({ codex: JSON.stringify(stored) })
    const llm = createLLM({ storage, fetch: mockFetch(loginRoutes(counter)).fetch })
    await Promise.all([llm.codex.test(), llm.codex.test(), llm.codex.test()])
    expect(counter.refresh).toBe(1)
    expect(JSON.parse((await storage.get('codex'))!).refreshToken).toBe('r2')
  })

  it('clears credentials and asks for a new sign-in when the session is revoked', async () => {
    const stored = { accessToken: 'a', refreshToken: 'r', idToken: null, accountId: null, email: null, plan: null, residency: null, expiresAt: Date.now() - 1000, connectedAt: 'x' }
    const storage = createMemoryStorage({ codex: JSON.stringify(stored) })
    const llm = createLLM({ storage, fetch: mockFetch([() => json({ error: 'invalid_grant' }, 400)]).fetch })
    await expect(llm.codex.test()).rejects.toMatchObject({ code: 'reauth_required' })
    expect((await llm.codex.status()).connected).toBe(false)
  })

  it('requires a connection before streaming', async () => {
    const llm = createLLM({ storage: createMemoryStorage(), fetch: mockFetch([]).fetch })
    await expect(collect(llm.stream('codex', { messages }))).rejects.toMatchObject({ code: 'not_connected' })
  })

  it('lists live models and streams in the Responses format', async () => {
    const { fetch, calls } = mockFetch([
      (url) => url.includes('/models') ? json({ models: [{ slug: 'gpt-5-codex', display_name: 'GPT-5 Codex' }, { slug: 'secret', visibility: 'hide' }] }) : undefined,
      (url) => url.endsWith('/responses')
        ? sse([
            { data: { type: 'response.output_text.delta', delta: 'Hi' } },
            { data: { type: 'response.output_text.delta', delta: ' Codex' } },
            { data: { type: 'response.completed', response: { usage: { input_tokens: 9, output_tokens: 4 } } } },
          ])
        : undefined,
    ])
    const llm = createLLM({ storage: createMemoryStorage({ codex: fresh() }), fetch })
    expect((await llm.listModels('codex')).models.map((m) => m.id)).toEqual(['gpt-5-codex'])
    const events = await collect(llm.stream('codex', { messages: [...messages, { role: 'assistant', content: 'hello' }, { role: 'user', content: 'and?' }], system: 'sys' }))
    expect(events.at(-1)).toEqual({ type: 'done', text: 'Hi Codex', usage: { inputTokens: 9, outputTokens: 4 } })
    const call = calls.find((c) => c.url.endsWith('/responses'))!
    const body = JSON.parse(String(call.init.body))
    expect(body.instructions).toBe('sys')
    expect(body.store).toBe(false)
    expect(body.input[1].content[0].type).toBe('output_text')
    expect((call.init.headers as Record<string, string>)['ChatGPT-Account-ID']).toBe('acc1')
  })

  it('falls back to the default model when the catalog fails', async () => {
    const llm = createLLM({ storage: createMemoryStorage({ codex: fresh() }), fetch: mockFetch([() => json({}, 500)]).fetch })
    expect(await llm.listModels('codex')).toMatchObject({ source: 'fallback', defaultModel: 'gpt-5-codex' })
  })

  it('maps 401 to reauth_required and response.failed to provider_error', async () => {
    const unauthorized = createLLM({ storage: createMemoryStorage({ codex: fresh() }), fetch: mockFetch([() => json({}, 401)]).fetch })
    await expect(collect(unauthorized.stream('codex', { messages }))).rejects.toMatchObject({ code: 'reauth_required' })
    const failing = createLLM({
      storage: createMemoryStorage({ codex: fresh() }),
      fetch: mockFetch([(u) => u.endsWith('/responses') ? sse([{ data: { type: 'response.failed', response: { error: { message: 'model overloaded' } } } }]) : undefined]).fetch,
    })
    await expect(collect(failing.stream('codex', { messages }))).rejects.toMatchObject({ code: 'provider_error', message: 'model overloaded' })
  })
})

describe('registry', () => {
  const extra = {
    id: 'cursor', name: 'Cursor', auth: 'api-key' as const,
    status: async () => ({ connected: true }), disconnect: async () => {},
    listModels: async () => ({ source: 'fallback' as const, defaultModel: 'c', models: [] }),
    async *stream() { yield { type: 'done' as const, text: 'ok' } },
  }

  it('statuses, unknown providers and extraProviders', async () => {
    const llm = createLLM({ storage: createMemoryStorage(), extraProviders: [extra] })
    expect(Object.keys(await llm.statuses()).sort()).toEqual(['anthropic', 'codex', 'cursor', 'openai'])
    expect(await llm.complete('cursor', { messages })).toBe('ok')
    expect(() => llm.provider('nope')).toThrow(LLMError)
    expect(() => llm.provider('nope')).toThrow(/Unknown provider/)
  })

  it('register() adds or replaces a provider at runtime', async () => {
    const llm = createLLM({ storage: createMemoryStorage() })
    llm.register(extra)
    expect(llm.providers.map((p) => p.id)).toContain('cursor')
    llm.register({ ...extra, async *stream() { yield { type: 'done' as const, text: 'v2' } } })
    expect(await llm.complete('cursor', { messages })).toBe('v2')
    expect(llm.providers.filter((p) => p.id === 'cursor')).toHaveLength(1)
  })

  it('statuses never expose stored secrets', async () => {
    const storage = createMemoryStorage({ anthropic: storedKey('sk-ant-very-secret-key-1234'), openai: storedKey('sk-openai-very-secret-5678') })
    const llm = createLLM({ storage })
    const dump = JSON.stringify(await llm.statuses())
    expect(dump).not.toContain('very-secret')
  })
})
