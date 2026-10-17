import { describe, expect, it } from 'vitest'
import { createLLM, createMemoryStorage, LLMError } from '../src/index.js'
import { collect, json, jwt, mockFetch, sse } from './helpers.js'

const messages = [{ role: 'user' as const, content: 'oi' }]

describe('anthropic', () => {
  it('valida a chave, lista modelos e faz streaming', async () => {
    const { fetch, calls } = mockFetch([
      (url, init) => {
        const key = (init.headers as Record<string, string>)['x-api-key']
        if (url.includes('/v1/models')) return key === 'sk-ant-good-key-1234' ? json({ data: [{ id: 'claude-x', display_name: 'Claude X' }] }) : json({ error: { message: 'bad' } }, 401)
      },
      (url) => url.endsWith('/v1/messages')
        ? sse([
            { event: 'message_start', data: { type: 'message_start', message: { usage: { input_tokens: 5 } } } },
            { event: 'content_block_delta', data: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Olá' } } },
            { event: 'content_block_delta', data: { type: 'content_block_delta', delta: { type: 'text_delta', text: ' mundo' } } },
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
    const text = await llm.complete('anthropic', { messages, system: 'seja breve' }, (d) => deltas.push(d))
    expect(text).toBe('Olá mundo')
    expect(deltas).toEqual(['Olá', ' mundo'])
    const sent = JSON.parse(String(calls.at(-1)!.init.body))
    expect(sent).toMatchObject({ model: 'claude-x', system: 'seja breve', stream: true })
    expect(sent.max_tokens).toBeGreaterThan(0)

    const events = await collect(llm.stream('anthropic', { messages }))
    expect(events.at(-1)).toMatchObject({ type: 'done', usage: { inputTokens: 5, outputTokens: 3 } })

    await llm.anthropic.disconnect()
    expect((await llm.anthropic.status()).connected).toBe(false)
  })

  it('traduz 429 e erros de rede', async () => {
    const storage = createMemoryStorage({ anthropic: JSON.stringify({ apiKey: 'sk-ant-xxxxxxxx', connectedAt: 'x' }) })
    const rate = createLLM({ storage, fetch: mockFetch([(u) => (u.endsWith('/v1/models?limit=100') ? json({}, 500) : u.endsWith('/v1/messages') ? json({ error: { message: 'x' } }, 429) : undefined)]).fetch })
    await expect(collect(rate.stream('anthropic', { model: 'm', messages }))).rejects.toMatchObject({ code: 'rate_limited' })
    const down = createLLM({ storage, fetch: (async () => { throw new TypeError('fail') }) as typeof fetch })
    await expect(collect(down.stream('anthropic', { model: 'm', messages }))).rejects.toMatchObject({ code: 'network' })
  })

  it('cancela via AbortSignal', async () => {
    const storage = createMemoryStorage({ anthropic: JSON.stringify({ apiKey: 'sk-ant-xxxxxxxx', connectedAt: 'x' }) })
    const ctrl = new AbortController()
    const fetch = ((_u: any, init: RequestInit) => new Promise((_res, rej) => {
      if (init.signal!.aborted) return rej(new Error('abort')) // como o fetch real
      init.signal!.addEventListener('abort', () => rej(new Error('abort')))
    })) as unknown as typeof globalThis.fetch
    const llm = createLLM({ storage, fetch })
    const p = collect(llm.stream('anthropic', { model: 'm', messages, signal: ctrl.signal }))
    ctrl.abort()
    await expect(p).rejects.toMatchObject({ code: 'aborted' })
  })
})

describe('openai', () => {
  it('lista só modelos de chat, faz streaming com usage e suporta baseUrl', async () => {
    const { fetch, calls } = mockFetch([
      (url) => url === 'https://gw.test/v1/models' ? json({ data: [{ id: 'gpt-5' }, { id: 'text-embedding-3' }, { id: 'o4-mini' }, { id: 'whisper-1' }] }) : undefined,
      (url) => url === 'https://gw.test/v1/chat/completions'
        ? sse([
            { data: { choices: [{ delta: { content: 'Oi' } }] } },
            { data: { choices: [{ delta: { content: '!' } }] } },
            { data: { choices: [], usage: { prompt_tokens: 4, completion_tokens: 2 } } },
            '[DONE]',
          ])
        : undefined,
    ])
    const llm = createLLM({ storage: createMemoryStorage(), fetch, openai: { baseUrl: 'https://gw.test/v1' } })
    await llm.openai.setApiKey('sk-openai-1234567')
    const catalog = await llm.listModels('openai')
    expect(catalog.models.map((m) => m.id)).toEqual(['gpt-5', 'o4-mini'])
    expect(catalog.defaultModel).toBe('gpt-5')
    const events = await collect(llm.stream('openai', { messages, system: 'sys' }))
    expect(events.at(-1)).toEqual({ type: 'done', text: 'Oi!', usage: { inputTokens: 4, outputTokens: 2 } })
    const body = JSON.parse(String(calls.at(-1)!.init.body))
    expect(body.messages[0]).toEqual({ role: 'system', content: 'sys' })
    expect((calls.at(-1)!.init.headers as Record<string, string>).Authorization).toBe('Bearer sk-openai-1234567')
  })

  it('cai no modelo padrão quando a lista falha', async () => {
    const storage = createMemoryStorage({ openai: JSON.stringify({ apiKey: 'sk-openai-1234567', connectedAt: 'x' }) })
    const llm = createLLM({ storage, fetch: mockFetch([() => json({}, 500)]).fetch })
    expect(await llm.listModels('openai')).toMatchObject({ source: 'fallback', defaultModel: 'gpt-5' })
  })
})

describe('codex', () => {
  const access = (extra: object = {}, exp = Math.floor(Date.now() / 1000) + 3600) =>
    jwt({ exp, 'https://api.openai.com/auth': { chatgpt_account_id: 'acc1', chatgpt_plan_type: 'plus' }, 'https://api.openai.com/profile': { email: 'a@b.com' }, ...extra })

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

  it('login por código em dois passos e status público sem tokens', async () => {
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

  it('renova token vencido uma única vez mesmo com chamadas simultâneas', async () => {
    const counter = { polls: 5, refresh: 0 }
    const stored = { accessToken: access({}, 1), refreshToken: 'r1', idToken: null, accountId: 'acc1', email: 'a@b.com', plan: 'plus', residency: null, expiresAt: Date.now() - 1000, connectedAt: 'x' }
    const storage = createMemoryStorage({ codex: JSON.stringify(stored) })
    const llm = createLLM({ storage, fetch: mockFetch(loginRoutes(counter)).fetch })
    await Promise.all([llm.codex.test(), llm.codex.test(), llm.codex.test()])
    expect(counter.refresh).toBe(1)
    expect(JSON.parse((await storage.get('codex'))!).refreshToken).toBe('r2')
  })

  it('sessão revogada limpa credenciais e pede novo login', async () => {
    const stored = { accessToken: 'a', refreshToken: 'r', idToken: null, accountId: null, email: null, plan: null, residency: null, expiresAt: Date.now() - 1000, connectedAt: 'x' }
    const storage = createMemoryStorage({ codex: JSON.stringify(stored) })
    const llm = createLLM({ storage, fetch: mockFetch([() => json({ error: 'invalid_grant' }, 400)]).fetch })
    await expect(llm.codex.test()).rejects.toMatchObject({ code: 'reauth_required' })
    expect((await llm.codex.status()).connected).toBe(false)
  })

  it('lista modelos ao vivo e faz streaming no formato Responses', async () => {
    const stored = { accessToken: access(), refreshToken: 'r', idToken: null, accountId: 'acc1', email: null, plan: null, residency: null, expiresAt: Date.now() + 3_600_000, connectedAt: 'x' }
    const { fetch, calls } = mockFetch([
      (url) => url.includes('/models') ? json({ models: [{ slug: 'gpt-5-codex', display_name: 'GPT-5 Codex' }, { slug: 'secreto', visibility: 'hide' }] }) : undefined,
      (url) => url.endsWith('/responses')
        ? sse([
            { data: { type: 'response.output_text.delta', delta: 'Oi' } },
            { data: { type: 'response.output_text.delta', delta: ' Codex' } },
            { data: { type: 'response.completed', response: { usage: { input_tokens: 9, output_tokens: 4 } } } },
          ])
        : undefined,
    ])
    const llm = createLLM({ storage: createMemoryStorage({ codex: JSON.stringify(stored) }), fetch })
    expect((await llm.listModels('codex')).models.map((m) => m.id)).toEqual(['gpt-5-codex'])
    const events = await collect(llm.stream('codex', { messages: [...messages, { role: 'assistant', content: 'ola' }, { role: 'user', content: 'e aí' }], system: 'sys' }))
    expect(events.at(-1)).toEqual({ type: 'done', text: 'Oi Codex', usage: { inputTokens: 9, outputTokens: 4 } })
    const call = calls.find((c) => c.url.endsWith('/responses'))!
    const body = JSON.parse(String(call.init.body))
    expect(body.instructions).toBe('sys')
    expect(body.input[1].content[0].type).toBe('output_text')
    expect((call.init.headers as Record<string, string>)['ChatGPT-Account-ID']).toBe('acc1')
  })
})

describe('registro', () => {
  it('statuses, provedor desconhecido e extraProviders', async () => {
    const extra = {
      id: 'cursor', name: 'Cursor', auth: 'api-key' as const,
      status: async () => ({ connected: true }), disconnect: async () => {},
      listModels: async () => ({ source: 'fallback' as const, defaultModel: 'c', models: [] }),
      async *stream() { yield { type: 'done' as const, text: 'ok' } },
    }
    const llm = createLLM({ storage: createMemoryStorage(), extraProviders: [extra] })
    expect(Object.keys(await llm.statuses()).sort()).toEqual(['anthropic', 'codex', 'cursor', 'openai'])
    expect(await llm.complete('cursor', { messages })).toBe('ok')
    expect(() => llm.provider('nope')).toThrow(LLMError)
  })
})
