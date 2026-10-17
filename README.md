# llm-connector

**English** · [Português (Brasil)](README.pt-BR.md) · [Español](README.es.md)

[![CI](https://github.com/GugaLabs/llm-connector/actions/workflows/ci.yml/badge.svg)](https://github.com/GugaLabs/llm-connector/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/llm-connector/beta)](https://www.npmjs.com/package/llm-connector)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

> **Early release (beta, `0.0.1-beta`).** The API may change without notice before `1.0`.
> **Codex** is the reference provider for now: it is the only one validated in a real app.
> **Claude API and OpenAI API are implemented but have only been tested against mocked responses.** They still need testing against the real APIs. Help is very welcome: see [CONTRIBUTING](CONTRIBUTING.md).

Ready-made LLM connectors behind a single API. Install the library, choose where
credentials are stored, and call `login`, `listModels` and `stream`. You don't have to
rewrite OAuth, token refresh, streaming parsers or model catalogs in every project.

| Provider | Id | Authentication | Status |
| --- | --- | --- | --- |
| Codex (ChatGPT subscription) | `codex` | Device-code sign-in in the browser (OAuth); usage counts against the ChatGPT plan | Reference (validated in a real app) |
| Claude API | `anthropic` | API key | Experimental (mocked tests only) |
| OpenAI API | `openai` | API key (accepts `baseUrl` for compatible endpoints) | Experimental (mocked tests only) |

You can add other providers (e.g. Cursor) by implementing the `Provider` interface
and passing them in `extraProviders` or `llm.register(...)`.

Requirements: Node 20+ (uses the native `fetch`). No runtime dependencies.

## Installation

```bash
npm install llm-connector@beta
```

## Quick start

```ts
import { createLLM, createEncryptedFileStorage } from 'llm-connector'

const llm = createLLM({
  storage: createEncryptedFileStorage({ dir: './.llm', secret: process.env.LLM_SECRET }),
})

// 1) Connect
await llm.anthropic.setApiKey('sk-ant-...')          // validates the key, then stores it
await llm.codex.login({                               // ChatGPT subscription
  onCode: ({ userCode, verificationUri }) => console.log(`Open ${verificationUri} and enter ${userCode}`),
})

// 2) Check status and models
console.log(await llm.statuses())                     // { codex: { connected, ... }, anthropic: {...}, openai: {...} }
const { models, defaultModel } = await llm.listModels('codex')

// 3) Chat (streaming)
for await (const ev of llm.stream('codex', { messages: [{ role: 'user', content: 'Hi!' }] })) {
  if (ev.type === 'delta') process.stdout.write(ev.text)
}

// ...or just the final text
const text = await llm.complete('anthropic', { system: 'Be brief.', messages: [{ role: 'user', content: 'Explain SSE.' }] })
```

## Where credentials live (`storage`)

The library never picks a storage location for you. Choose an implementation, or write
your own with `get/set/delete`:

- `createSafeStorageStorage({ safeStorage, dir })`: for **Electron**. Uses Keychain, DPAPI or libsecret. Recommended for desktop apps.
- `createEncryptedFileStorage({ dir, secret? })`: for Node. Stores AES-256-GCM `.enc` files (mode 0600). Without a `secret`, it creates a key at `dir/.key`.
- `createMemoryStorage()`: for tests and short-lived sessions.

In Electron (main process):

```ts
import { app, safeStorage } from 'electron'
import { createLLM, createSafeStorageStorage } from 'llm-connector'

const llm = createLLM({
  storage: createSafeStorageStorage({ safeStorage, dir: path.join(app.getPath('userData'), 'llm') }),
})
```

Tokens and keys **never** appear in `status()`, which only returns e-mail, plan,
a masked key and dates. In Electron apps, keep the library in the main process and
expose only status and text to the renderer, never credentials.

## Two-step Codex sign-in (for UIs)

```ts
const flow = await llm.codex.startLogin()        // { flowId, userCode, verificationUri, interval }
// show userCode and open verificationUri; then, every flow.interval seconds:
const r = await llm.codex.pollLogin(flow.flowId) // { status: 'pending', interval } | { status: 'connected', email, plan, ... }
llm.codex.cancelLogin(flow.flowId)               // if the user closes the dialog
```

Tokens refresh automatically, one refresh at a time, because the refresh token rotates.
If the session is revoked, the library deletes the credentials and throws `reauth_required`.

## API

- `createLLM({ storage, fetch?, userAgent?, codex?, anthropic?, openai?, extraProviders? })`
- `llm.statuses()` · `llm.listModels(id, { force? })` · `llm.stream(id, req)` · `llm.complete(id, req, onDelta?)`
- `llm.provider(id)` · `llm.register(provider)` · `llm.providers`
- `req`: `{ model?, messages, system?, maxTokens?, temperature?, signal? }`. `signal` lets you cancel, e.g. from a "Stop" button.
- Events: `{ type: 'delta', text }` while streaming, then `{ type: 'done', text, usage? }`.
- Per provider: `llm.anthropic.setApiKey`, `llm.openai.setApiKey`, `llm.codex.login/startLogin/pollLogin/test`, and `disconnect()` on all of them.

### Errors

Everything throws `LLMError` with a stable `code`: `not_connected`, `reauth_required`,
`invalid_credentials`, `rate_limited`, `network`, `invalid_request`,
`provider_error`, `flow_expired`, `storage`, `aborted`. Branch on `code`. Messages
are in English and may change between versions.

```ts
import { LLMError } from 'llm-connector'

try {
  await llm.complete('codex', { messages })
} catch (error) {
  if (error instanceof LLMError && error.code === 'reauth_required') showSignInButton()
  else throw error
}
```

## Development

```bash
npm install
npm test         # tests with a mocked fetch (no network)
npm run typecheck
npm run build
```

## Disclaimer

This is an independent project with **no affiliation** with OpenAI or Anthropic. The Codex sign-in follows the
Codex CLI flow, which is internal to OpenAI and may change or stop working at any time. Use it at your own risk
and follow each service's terms of use.

## Contributing

This project is open source (MIT) and just getting started. Open issues, test it with your accounts and send PRs.
Priorities are listed in [CONTRIBUTING.md](CONTRIBUTING.md).

## Known limitations

- Text chat only (no tool calling or images yet).
- The Codex sign-in uses the Codex CLI flow, which OpenAI may change. You can configure the `clientId` and base URL with `codex: { clientId, baseUrl }`.
- Claude API and OpenAI API have not been validated against the real APIs yet (tests use mocked responses). Run `examples/chat.ts` with your key and report the result.
