import type { ProviderId, UsageSnapshot, UsageWindow } from './types.js'

/*
 * Usage limits. The Codex mapping follows the work done in ai-usagebar
 * (https://github.com/akitaonrails/ai-usagebar, MIT), which documents the
 * ChatGPT usage endpoint and the pacing idea used below.
 */

/** Human label for a window length: 18000 → '5h', 604800 → 'weekly'. */
export function windowLabel(seconds: number | undefined): string {
  if (!seconds || seconds <= 0) return 'window'
  if (seconds === 604_800) return 'weekly'
  if (seconds % 86_400 === 0) return `${seconds / 86_400}d`
  if (seconds % 3_600 === 0) return `${seconds / 3_600}h`
  if (seconds % 60 === 0) return `${seconds / 60}m`
  return `${seconds}s`
}

export type Pace = 'ahead' | 'on_track' | 'under'

export interface Pacing {
  /** How much of the window has elapsed, 0-100. */
  elapsedPercent: number
  /** usedPercent - elapsedPercent, in points. Positive = burning faster than the clock. */
  delta: number
  /** 'ahead' = on course to hit the limit before the reset. */
  pace: Pace
}

/**
 * Compares usage with elapsed time in the window. Returns null when the window
 * has no length or reset time (e.g. API-key rate limits without a reset).
 */
export function pacing(window: UsageWindow, options: { now?: number; tolerance?: number } = {}): Pacing | null {
  if (!window.windowSeconds || !window.resetsAt) return null
  const now = options.now ?? Date.now()
  const tolerance = options.tolerance ?? 5
  const remainingMs = Math.max(0, Date.parse(window.resetsAt) - now)
  const elapsedPercent = clampPercent(100 - (remainingMs / (window.windowSeconds * 1000)) * 100)
  const delta = Math.round((window.usedPercent - elapsedPercent) * 10) / 10
  const pace: Pace = delta > tolerance ? 'ahead' : delta < -tolerance ? 'under' : 'on_track'
  return { elapsedPercent, delta, pace }
}

const clampPercent = (value: number) => Math.min(100, Math.max(0, Math.round(value * 10) / 10))

const toNumber = (value: unknown): number | undefined => {
  const n = typeof value === 'string' ? Number.parseFloat(value) : value
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined
}

// ---- Codex (ChatGPT subscription) -------------------------------------------

interface CodexWindow { used_percent?: unknown; limit_window_seconds?: unknown; reset_at?: unknown; reset_after_seconds?: unknown }
interface CodexRateLimit { limit_reached?: unknown; primary_window?: CodexWindow | null; secondary_window?: CodexWindow | null }

function codexWindow(raw: CodexWindow | null | undefined, id: string, now: number, prefix = ''): UsageWindow | null {
  const used = toNumber(raw?.used_percent)
  if (!raw || used === undefined) return null
  const windowSeconds = toNumber(raw.limit_window_seconds)
  const resetAt = toNumber(raw.reset_at)
  const resetAfter = toNumber(raw.reset_after_seconds)
  const resetsAt = resetAt !== undefined ? new Date(resetAt * 1000) : resetAfter !== undefined ? new Date(now + resetAfter * 1000) : undefined
  return {
    id,
    label: `${prefix}${windowLabel(windowSeconds)}`,
    usedPercent: clampPercent(used),
    windowSeconds,
    resetsAt: resetsAt?.toISOString(),
  }
}

function codexWindows(limit: CodexRateLimit | null | undefined, idPrefix: string, labelPrefix: string, now: number): UsageWindow[] {
  return [
    codexWindow(limit?.primary_window, `${idPrefix}primary`, now, labelPrefix),
    codexWindow(limit?.secondary_window, `${idPrefix}secondary`, now, labelPrefix),
  ].filter((w): w is UsageWindow => w !== null)
}

/** Maps `GET chatgpt.com/backend-api/wham/usage` into a UsageSnapshot. */
export function parseCodexUsage(data: unknown, now = Date.now()): UsageSnapshot {
  const body = (data ?? {}) as {
    plan_type?: unknown
    rate_limit?: CodexRateLimit | null
    code_review_rate_limit?: CodexRateLimit | null
    additional_rate_limits?: Array<{ limit_name?: unknown; metered_feature?: unknown; rate_limit?: CodexRateLimit | null }> | null
    credits?: { balance?: unknown; has_credits?: unknown; unlimited?: unknown } | null
  }
  const windows = [
    ...codexWindows(body.rate_limit, '', '', now),
    ...codexWindows(body.code_review_rate_limit, 'code_review:', 'code review ', now),
    ...(body.additional_rate_limits ?? []).flatMap((extra) => {
      const name = String(extra.limit_name ?? extra.metered_feature ?? 'extra')
      return codexWindows(extra.rate_limit, `${name}:`, `${name} `, now)
    }),
  ]
  const credits = body.credits
    ? {
        balance: body.credits.balance === undefined || body.credits.balance === null ? null : String(body.credits.balance),
        hasCredits: body.credits.has_credits === true,
        unlimited: body.credits.unlimited === true,
      }
    : undefined
  return {
    provider: 'codex',
    source: 'live',
    fetchedAt: new Date(now).toISOString(),
    plan: typeof body.plan_type === 'string' ? body.plan_type : null,
    limitReached: body.rate_limit?.limit_reached === true || windows.some((w) => w.usedPercent >= 100),
    windows,
    credits,
  }
}

// ---- API-key rate limits (response headers) ---------------------------------

/** Parses OpenAI reset durations such as '20ms', '1s', '6m0s', '1h2m3.5s' into milliseconds. */
export function parseDuration(value: string): number | undefined {
  const parts = [...value.matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)]
  if (parts.length === 0 || parts.map((p) => p[0]).join('') !== value.trim()) return undefined
  const unit = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 } as const
  return parts.reduce((total, [, n, u]) => total + Number(n) * unit[u as keyof typeof unit], 0)
}

function headerWindow(id: string, label: string, limit?: number, remaining?: number, resetsAt?: Date): UsageWindow | null {
  if (limit === undefined || remaining === undefined || limit <= 0) return null
  return {
    id,
    label,
    usedPercent: clampPercent(((limit - remaining) / limit) * 100),
    limit,
    remaining,
    resetsAt: resetsAt && !Number.isNaN(resetsAt.getTime()) ? resetsAt.toISOString() : undefined,
  }
}

function snapshotFromHeaders(provider: ProviderId, windows: Array<UsageWindow | null>, now: number): UsageSnapshot | null {
  const present = windows.filter((w): w is UsageWindow => w !== null)
  if (present.length === 0) return null
  return { provider, source: 'headers', fetchedAt: new Date(now).toISOString(), windows: present, limitReached: present.some((w) => w.remaining === 0) }
}

/** Reads `anthropic-ratelimit-*` headers (requests, tokens, input/output tokens). */
export function parseAnthropicRateLimits(headers: Headers, now = Date.now()): UsageSnapshot | null {
  const read = (kind: string, label: string) =>
    headerWindow(
      kind,
      label,
      toNumber(headers.get(`anthropic-ratelimit-${kind}-limit`)),
      toNumber(headers.get(`anthropic-ratelimit-${kind}-remaining`)),
      headers.get(`anthropic-ratelimit-${kind}-reset`) ? new Date(headers.get(`anthropic-ratelimit-${kind}-reset`)!) : undefined,
    )
  return snapshotFromHeaders('anthropic', [read('requests', 'requests'), read('tokens', 'tokens'), read('input-tokens', 'input tokens'), read('output-tokens', 'output tokens')], now)
}

/** Reads `x-ratelimit-*` headers (requests and tokens) sent by OpenAI-compatible APIs. */
export function parseOpenAIRateLimits(headers: Headers, now = Date.now(), provider: ProviderId = 'openai'): UsageSnapshot | null {
  const read = (kind: string) => {
    const reset = headers.get(`x-ratelimit-reset-${kind}`)
    const ms = reset ? parseDuration(reset) : undefined
    return headerWindow(kind, kind, toNumber(headers.get(`x-ratelimit-limit-${kind}`)), toNumber(headers.get(`x-ratelimit-remaining-${kind}`)), ms === undefined ? undefined : new Date(now + ms))
  }
  return snapshotFromHeaders(provider, [read('requests'), read('tokens')], now)
}
