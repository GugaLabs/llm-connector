import { describe, expect, it } from 'vitest'
import { createLLM, createMemoryStorage, pacing, parseCodexUsage, parseOpenAIRateLimits, windowLabel } from '../src/index.js'
import { parseDuration } from '../src/usage.js'
import { collect, json, jwt, mockFetch, sse } from './helpers.js'

const NOW = Date.UTC(2026, 9, 17, 12, 0, 0)
const nowSeconds = NOW / 1000
const messages = [{ role: 'user' as const, content: 'hi' }]

// Shape captured from chatgpt.com/backend-api/wham/usage (documented by ai-usagebar).
const codexPayload = {
  plan_type: 'plus',
  rate_limit: {
    allowed: true,
    limit_reached: false,
    primary_window: { used_percent: 42, limit_window_seconds: 18000, reset_at: nowSeconds + 3600 },
    secondary_window: { used_percent: '7.5', limit_window_seconds: 604800, reset_after_seconds: 86400 },
  },
  code_review_rate_limit: { primary_window: { used_percent: 0, limit_window_seconds: 604800, reset_at: nowSeconds + 1000 } },
  additional_rate_limits: null,
  credits: { balance: '12.50', has_credits: true, unlimited: false },
}

const withHeaders = (response: Response, headers: Record<string, string>) => {
  for (const [k, v] of Object.entries(headers)) response.headers.set(k, v)
  return response
}

describe('parseCodexUsage', () => {
  it('maps windows, plan and credits', () => {
    const snapshot = parseCodexUsage(codexPayload, NOW)
    expect(snapshot).toMatchObject({ provider: 'codex', source: 'live', plan: 'plus', limitReached: false, credits: { balance: '12.50', hasCredits: true, unlimited: false } })
    expect(snapshot.windows).toEqual([
      { id: 'primary', label: '5h', usedPercent: 42, windowSeconds: 18000, resetsAt: new Date(NOW + 3_600_000).toISOString() },
      { id: 'secondary', label: 'weekly', usedPercent: 7.5, windowSeconds: 604800, resetsAt: new Date(NOW + 86_400_000).toISOString() },
      { id: 'code_review:primary', label: 'code review weekly', usedPercent: 0, windowSeconds: 604800, resetsAt: new Date(NOW + 1_000_000).toISOString() },
    ])
  })

  it('includes named limits and flags exhausted windows', () => {
    const snapshot = parseCodexUsage({
      rate_limit: { primary_window: { used_percent: 100, limit_window_seconds: 18000 } },
      additional_rate_limits: [{ limit_name: 'gpt-5-pro', rate_limit: { primary_window: { used_percent: 30, limit_window_seconds: 86400 } } }],
    }, NOW)
    expect(snapshot.limitReached).toBe(true)
    expect(snapshot.plan).toBeNull()
    expect(snapshot.windows.map((w) => [w.id, w.label])).toEqual([['primary', '5h'], ['gpt-5-pro:primary', 'gpt-5-pro 1d']])
  })

  it('ignores malformed windows instead of inventing numbers', () => {
    const snapshot = parseCodexUsage({ rate_limit: { primary_window: { used_percent: 'n/a' }, secondary_window: null } }, NOW)
    expect(snapshot.windows).toEqual([])
    expect(parseCodexUsage(null, NOW).windows).toEqual([])
  })
})

describe('codex.usage()', () => {
  const stored = JSON.stringify({ accessToken: jwt({ exp: nowSeconds * 2 }), refreshToken: 'r', idToken: null, accountId: 'acc1', email: null, plan: null, residency: null, expiresAt: Date.now() + 3_600_000, connectedAt: 'x' })

  it('queries the usage endpoint with the stored session', async () => {
    const { fetch, calls } = mockFetch([(u) => (u === 'https://chatgpt.com/backend-api/wham/usage' ? json(codexPayload) : undefined)])
    const llm = createLLM({ storage: createMemoryStorage({ codex: stored }), fetch })
    const snapshot = await llm.usage('codex')
    expect(snapshot?.windows.map((w) => w.label)).toEqual(['5h', 'weekly', 'code review weekly'])
    const headers = calls[0]!.init.headers as Record<string, string>
    expect(headers.Authorization).toMatch(/^Bearer /)
    expect(headers['ChatGPT-Account-ID']).toBe('acc1')
  })

  it('honours usageUrl and maps errors', async () => {
    const custom = createLLM({ storage: createMemoryStorage({ codex: stored }), fetch: mockFetch([(u) => (u === 'https://proxy.test/usage' ? json(codexPayload) : undefined)]).fetch, codex: { usageUrl: 'https://proxy.test/usage' } })
    expect((await custom.codex.usage()).plan).toBe('plus')
    const revoked = createLLM({ storage: createMemoryStorage({ codex: stored }), fetch: mockFetch([() => json({}, 401)]).fetch })
    await expect(revoked.codex.usage()).rejects.toMatchObject({ code: 'reauth_required' })
    const offline = createLLM({ storage: createMemoryStorage(), fetch: mockFetch([]).fetch })
    await expect(offline.codex.usage()).rejects.toMatchObject({ code: 'not_connected' })
  })
})

describe('API-key rate limits', () => {
  const anthropicHeaders = {
    'anthropic-ratelimit-requests-limit': '50',
    'anthropic-ratelimit-requests-remaining': '49',
    'anthropic-ratelimit-requests-reset': '2026-10-17T12:01:00Z',
    'anthropic-ratelimit-tokens-limit': '40000',
    'anthropic-ratelimit-tokens-remaining': '30000',
    'anthropic-ratelimit-tokens-reset': '2026-10-17T12:00:30Z',
  }

  it('anthropic: null before any request, then the limits from the last response', async () => {
    const llm = createLLM({
      storage: createMemoryStorage({ anthropic: JSON.stringify({ apiKey: 'sk-ant-xxxxxxxx', connectedAt: 'x' }) }),
      fetch: mockFetch([(u) => (u.endsWith('/v1/messages') ? withHeaders(sse([{ data: { type: 'message_stop' } }]), anthropicHeaders) : undefined)]).fetch,
    })
    expect(await llm.usage('anthropic')).toBeNull()
    await collect(llm.stream('anthropic', { model: 'm', messages }))
    const snapshot = await llm.usage('anthropic')
    expect(snapshot).toMatchObject({ provider: 'anthropic', source: 'headers', limitReached: false })
    expect(snapshot!.windows).toEqual([
      { id: 'requests', label: 'requests', usedPercent: 2, limit: 50, remaining: 49, resetsAt: '2026-10-17T12:01:00.000Z' },
      { id: 'tokens', label: 'tokens', usedPercent: 25, limit: 40000, remaining: 30000, resetsAt: '2026-10-17T12:00:30.000Z' },
    ])
    await llm.anthropic.disconnect()
    expect(await llm.usage('anthropic')).toBeNull()
  })

  it('anthropic: a 429 still records the exhausted limit', async () => {
    const llm = createLLM({
      storage: createMemoryStorage({ anthropic: JSON.stringify({ apiKey: 'sk-ant-xxxxxxxx', connectedAt: 'x' }) }),
      fetch: mockFetch([() => withHeaders(json({ error: { message: 'slow down' } }, 429), { ...anthropicHeaders, 'anthropic-ratelimit-requests-remaining': '0' })]).fetch,
    })
    await expect(collect(llm.stream('anthropic', { model: 'm', messages }))).rejects.toMatchObject({ code: 'rate_limited' })
    expect(await llm.usage('anthropic')).toMatchObject({ limitReached: true })
  })

  it('openai: parses x-ratelimit headers and relative resets', async () => {
    const llm = createLLM({
      storage: createMemoryStorage({ openai: JSON.stringify({ apiKey: 'sk-openai-1234567', connectedAt: 'x' }) }),
      fetch: mockFetch([(u) => (u.endsWith('/chat/completions')
        ? withHeaders(sse(['[DONE]']), {
            'x-ratelimit-limit-requests': '500',
            'x-ratelimit-remaining-requests': '499',
            'x-ratelimit-reset-requests': '120ms',
            'x-ratelimit-limit-tokens': '30000',
            'x-ratelimit-remaining-tokens': '27000',
            'x-ratelimit-reset-tokens': '6m0s',
          })
        : undefined)]).fetch,
    })
    await collect(llm.stream('openai', { model: 'm', messages }))
    const snapshot = await llm.usage('openai')
    expect(snapshot!.windows.map((w) => [w.id, w.usedPercent, w.remaining])).toEqual([['requests', 0.2, 499], ['tokens', 10, 27000]])
    const tokensReset = Date.parse(snapshot!.windows[1]!.resetsAt!) - Date.parse(snapshot!.fetchedAt)
    expect(tokensReset).toBe(360_000)
  })

  it('returns null when the headers are missing or incomplete', () => {
    expect(parseOpenAIRateLimits(new Headers())).toBeNull()
    expect(parseOpenAIRateLimits(new Headers({ 'x-ratelimit-limit-requests': '10' }))).toBeNull()
  })
})

describe('llm.usages()', () => {
  it('collects every connected provider and turns failures into null', async () => {
    const custom = {
      id: 'custom', name: 'Custom', auth: 'api-key' as const,
      status: async () => ({ connected: true }), disconnect: async () => {},
      listModels: async () => ({ source: 'fallback' as const, defaultModel: 'c', models: [] }),
      async *stream() { yield { type: 'done' as const, text: '' } },
    }
    const broken = { ...custom, id: 'broken', usage: async () => { throw new Error('boom') } }
    const llm = createLLM({ storage: createMemoryStorage(), fetch: mockFetch([]).fetch, extraProviders: [custom, broken] })
    expect(await llm.usages()).toEqual({ codex: null, anthropic: null, openai: null, custom: null, broken: null })
  })
})

describe('helpers', () => {
  it('windowLabel', () => {
    expect([18000, 604800, 86400, 2592000, 60, 90, 0].map(windowLabel)).toEqual(['5h', 'weekly', '1d', '30d', '1m', '90s', 'window'])
  })

  it('parseDuration', () => {
    expect(parseDuration('20ms')).toBe(20)
    expect(parseDuration('1s')).toBe(1000)
    expect(parseDuration('6m0s')).toBe(360_000)
    expect(parseDuration('1h2m3.5s')).toBe(3_723_500)
    expect(parseDuration('soon')).toBeUndefined()
  })

  it('pacing compares usage with elapsed time', () => {
    // 5h window with 1h left → 80% elapsed.
    const window = { id: 'primary', label: '5h', usedPercent: 50, windowSeconds: 18000, resetsAt: new Date(NOW + 3_600_000).toISOString() }
    expect(pacing(window, { now: NOW })).toEqual({ elapsedPercent: 80, delta: -30, pace: 'under' })
    expect(pacing({ ...window, usedPercent: 82 }, { now: NOW })).toMatchObject({ pace: 'on_track' })
    expect(pacing({ ...window, usedPercent: 95 }, { now: NOW })).toMatchObject({ delta: 15, pace: 'ahead' })
    expect(pacing({ ...window, usedPercent: 95 }, { now: NOW, tolerance: 20 })).toMatchObject({ pace: 'on_track' })
    expect(pacing({ id: 'requests', label: 'requests', usedPercent: 10 })).toBeNull()
  })
})
