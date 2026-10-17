# llm-connector

[![CI](https://github.com/GugaLabs/llm-connector/actions/workflows/ci.yml/badge.svg)](https://github.com/GugaLabs/llm-connector/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/llm-connector/beta)](https://www.npmjs.com/package/llm-connector)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

> **Versão inicial (beta, `0.0.1-beta`).** A API pode mudar sem aviso antes da `1.0`.
> Por enquanto o **Codex** é o provedor de referência (é o único já validado num app real).
> **Claude API e OpenAI API estão implementadas, mas ainda só foram testadas com respostas simuladas** — precisam de testes contra as APIs reais. Ajuda é muito bem-vinda: veja o [CONTRIBUTING](CONTRIBUTING.md).

Conectores prontos para LLMs, numa API única. Você instala a lib, escolhe onde
guardar as credenciais e usa `login`, `listModels` e `stream` — sem reescrever
OAuth, renovação de token, parser de streaming ou catálogo de modelos em cada projeto.

| Provedor | Id | Autenticação | Estado |
| --- | --- | --- | --- |
| Codex (assinatura ChatGPT) | `codex` | Login por código no navegador (OAuth device code); usa o plano do ChatGPT | Referência (validado num app real) |
| Claude API | `anthropic` | Chave de API | Experimental (só testes simulados) |
| OpenAI API | `openai` | Chave de API (aceita `baseUrl` para endpoints compatíveis) | Experimental (só testes simulados) |

Outros provedores (ex.: Cursor) entram implementando a interface `Provider` e
passando em `extraProviders` ou `llm.register(...)`.

Requisitos: Node 20+ (usa `fetch` nativo). Zero dependências em runtime.

## Instalação

```bash
npm install llm-connector@beta
```

## Uso rápido

```ts
import { createLLM, createEncryptedFileStorage } from 'llm-connector'

const llm = createLLM({
  storage: createEncryptedFileStorage({ dir: './.llm', secret: process.env.LLM_SECRET }),
})

// 1) Conectar
await llm.anthropic.setApiKey('sk-ant-...')          // valida a chave e guarda
await llm.codex.login({                               // assinatura ChatGPT
  onCode: ({ userCode, verificationUri }) => console.log(`Abra ${verificationUri} e digite ${userCode}`),
})

// 2) Ver estado e modelos
console.log(await llm.statuses())                     // { codex: {connected,...}, anthropic: {...}, openai: {...} }
const { models, defaultModel } = await llm.listModels('codex')

// 3) Conversar (streaming)
for await (const ev of llm.stream('codex', { messages: [{ role: 'user', content: 'Oi!' }] })) {
  if (ev.type === 'delta') process.stdout.write(ev.text)
}

// ...ou só o texto final
const text = await llm.complete('anthropic', { system: 'Seja breve.', messages: [{ role: 'user', content: 'Explique SSE.' }] })
```

## Onde ficam as credenciais (`storage`)

A lib nunca decide isso por você. Escolha uma implementação (ou escreva a sua com
`get/set/delete`):

- `createSafeStorageStorage({ safeStorage, dir })` — **Electron**: usa Keychain/DPAPI. Recomendado em apps desktop.
- `createEncryptedFileStorage({ dir, secret? })` — Node: AES-256-GCM em arquivos `.enc` (0600). Sem `secret`, gera uma chave em `dir/.key`.
- `createMemoryStorage()` — testes e sessões efêmeras.

No Electron (processo principal):

```ts
import { app, safeStorage } from 'electron'
import { createLLM, createSafeStorageStorage } from 'llm-connector'

const llm = createLLM({
  storage: createSafeStorageStorage({ safeStorage, dir: path.join(app.getPath('userData'), 'llm') }),
})
```

Tokens e chaves **não** aparecem em `status()`: só e-mail, plano, chave mascarada e datas.
Em apps Electron, mantenha a lib no processo principal e exponha ao renderer apenas
estado e texto, nunca credenciais.

## Login do Codex em dois passos (para UIs)

```ts
const flow = await llm.codex.startLogin()        // { flowId, userCode, verificationUri, interval }
// mostre userCode e abra verificationUri; depois, a cada flow.interval segundos:
const r = await llm.codex.pollLogin(flow.flowId) // { status: 'pending', interval } | { status: 'connected', email, plan, ... }
llm.codex.cancelLogin(flow.flowId)               // se o usuário fechar a janela
```

Tokens são renovados automaticamente (uma renovação por vez, pois o refresh token é rotativo).
Se a sessão for revogada, o erro é `reauth_required` e as credenciais são apagadas.

## API

- `createLLM({ storage, fetch?, userAgent?, codex?, anthropic?, openai?, extraProviders? })`
- `llm.statuses()` · `llm.listModels(id, { force? })` · `llm.stream(id, req)` · `llm.complete(id, req, onDelta?)`
- `llm.provider(id)` · `llm.register(provider)` · `llm.providers`
- `req`: `{ model?, messages, system?, maxTokens?, temperature?, signal? }` (`signal` = botão "Parar")
- Eventos: `{ type: 'delta', text }` e, ao final, `{ type: 'done', text, usage? }`
- Por provedor: `llm.anthropic.setApiKey`, `llm.openai.setApiKey`, `llm.codex.login/startLogin/pollLogin/test`, e `disconnect()` em todos.

### Erros

Tudo lança `LLMError` com `code` estável: `not_connected`, `reauth_required`,
`invalid_credentials`, `rate_limited`, `network`, `invalid_request`,
`provider_error`, `flow_expired`, `storage`, `aborted`. As mensagens estão em português.

## Desenvolvimento

```bash
npm install
npm test         # testes com fetch simulado (sem rede)
npm run typecheck
npm run build
```

## Aviso

Projeto independente, **sem afiliação** com OpenAI ou Anthropic. O login do Codex segue o fluxo do Codex CLI,
que é de uso interno da OpenAI e pode mudar ou deixar de funcionar a qualquer momento; use por sua conta e risco e
respeite os termos de uso de cada serviço.

## Contribuindo

É open source (MIT) e está começando: abra issues, teste com suas contas e mande PRs. Prioridades em [CONTRIBUTING.md](CONTRIBUTING.md).

## Limites desta versão

- Só conversa de texto (sem tool calling/imagens ainda).
- O login do Codex usa o fluxo do Codex CLI, que a OpenAI pode alterar; o `clientId` e a URL base são configuráveis (`codex: { clientId, baseUrl }`).
- Claude API e OpenAI API ainda não foram validadas contra as APIs reais (os testes usam respostas simuladas): rode `examples/chat.ts` com sua chave e reporte o resultado.
