export type Route = (url: string, init: RequestInit) => Response | Promise<Response> | undefined

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

export function sse(lines: Array<string | { event?: string; data: unknown }>, status = 200) {
  const text = lines
    .map((l) => (typeof l === 'string' ? `data: ${l}\n\n` : `${l.event ? `event: ${l.event}\n` : ''}data: ${JSON.stringify(l.data)}\n\n`))
    .join('')
  const bytes = new TextEncoder().encode(text)
  // Quebra em pedaços pequenos para exercitar o parser de SSE.
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7))
      controller.close()
    },
  })
  return new Response(stream, { status, headers: { 'Content-Type': 'text/event-stream' } })
}

export function mockFetch(routes: Route[]) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const impl = (async (input: any, init: RequestInit = {}) => {
    const url = String(input)
    calls.push({ url, init })
    for (const route of routes) {
      const res = await route(url, init)
      if (res) return res
    }
    return json({ error: { message: `sem rota para ${url}` } }, 599)
  }) as typeof fetch
  return { fetch: impl, calls }
}

export const jwt = (payload: object) =>
  `h.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.s`

export async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const item of it) out.push(item)
  return out
}
