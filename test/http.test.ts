import { describe, expect, it } from 'vitest'
import { errorFromResponse, send, sseEvents } from '../src/http.js'
import { LLMError } from '../src/index.js'
import { collect, json } from './helpers.js'

const body = (text: string) => new Response(text).body

describe('sseEvents', () => {
  it('parses event names, multi-line data and CRLF line endings', async () => {
    const events = await collect(sseEvents(body('event: ping\r\ndata: a\r\ndata: b\r\n\r\n: comment\n\ndata: c\n\n')))
    expect(events).toEqual([
      { event: 'ping', data: 'a\nb' },
      { event: null, data: 'c' },
    ])
  })

  it('flushes a trailing event without a final blank line', async () => {
    expect(await collect(sseEvents(body('data: first\n\ndata: last')))).toEqual([
      { event: null, data: 'first' },
      { event: null, data: 'last' },
    ])
  })

  it('handles a null body and multi-byte characters split across chunks', async () => {
    expect(await collect(sseEvents(null))).toEqual([])
    const bytes = new TextEncoder().encode('data: olá 👋\n\n')
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const b of bytes) controller.enqueue(Uint8Array.of(b))
        controller.close()
      },
    })
    expect(await collect(sseEvents(stream))).toEqual([{ event: null, data: 'olá 👋' }])
  })
})

describe('errorFromResponse', () => {
  it.each([
    [401, 'invalid_credentials'],
    [403, 'invalid_credentials'],
    [429, 'rate_limited'],
    [400, 'invalid_request'],
    [404, 'invalid_request'],
    [422, 'invalid_request'],
    [500, 'provider_error'],
    [503, 'provider_error'],
  ] as const)('maps HTTP %i to %s', async (status, code) => {
    const error = await errorFromResponse(json({}, status), 'Acme')
    expect(error).toBeInstanceOf(LLMError)
    expect(error).toMatchObject({ code, status })
  })

  it('includes the provider detail for request and server errors', async () => {
    expect((await errorFromResponse(json({ error: { message: 'model not found' } }, 404), 'Acme')).message).toBe('Acme: model not found')
    expect((await errorFromResponse(json({ error: 'upstream down' }, 502), 'Acme')).message).toBe('Acme: upstream down')
    expect((await errorFromResponse(json({ message: 'flat' }, 500), 'Acme')).message).toBe('Acme: flat')
    expect((await errorFromResponse(new Response('not json', { status: 500 }), 'Acme')).message).toBe('Acme returned an error (status 500).')
  })
})

describe('send', () => {
  it('turns a timeout into a network error', async () => {
    const hang = ((_u: any, init: RequestInit) => new Promise((_res, rej) => {
      init.signal!.addEventListener('abort', () => rej(new Error('aborted')))
    })) as unknown as typeof fetch
    await expect(send(hang, 'https://x.test', { timeout: 20 }, 'offline')).rejects.toMatchObject({ code: 'network', message: 'The request timed out.' })
  })

  it('uses the given message for other network failures', async () => {
    const fail = (async () => { throw new TypeError('ECONNREFUSED') }) as typeof fetch
    await expect(send(fail, 'https://x.test', {}, 'Could not reach Acme.')).rejects.toMatchObject({ code: 'network', message: 'Could not reach Acme.' })
  })
})
