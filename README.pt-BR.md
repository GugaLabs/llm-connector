# llm-connector

[English](README.md) · **Português (Brasil)** · [Español](README.es.md)

> Esta é uma tradução. A referência é o [README em inglês](README.md): se as duas versões divergirem, vale o inglês.

[![CI](https://github.com/GugaLabs/llm-connector/actions/workflows/ci.yml/badge.svg)](https://github.com/GugaLabs/llm-connector/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/llm-connector/beta)](https://www.npmjs.com/package/llm-connector)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

> **Versão inicial (beta, `0.0.1-beta`).** A API pode mudar sem aviso antes da `1.0`.
> Por enquanto o **Codex** é o provedor de referência: é o único já validado num app real.
> **Claude API e OpenAI API estão implementadas, mas só foram testadas com respostas simuladas.** Ainda precisam de testes contra as APIs reais. Ajuda é muito bem-vinda: veja o [CONTRIBUTING](CONTRIBUTING.md).

Conectores prontos para LLMs, numa API única. Você instala a lib, escolhe onde
guardar as credenciais e usa `login`, `listModels` e `stream`. Não precisa reescrever
OAuth, renovação de token, parser de streaming ou catálogo de modelos em cada projeto.

| Provedor | Id | Autenticação | Limites de uso | Estado |
| --- | --- | --- | --- | --- |
| Codex (assinatura ChatGPT) | `codex` | Login por código no navegador (OAuth); o uso entra no plano do ChatGPT | Janelas de 5h e semanal, créditos (ao vivo) | Referência (validado num app real) |
| Claude API | `anthropic` | Chave de API | Requisições/tokens por minuto (pelos headers da resposta) | Experimental (só testes simulados) |
| OpenAI API | `openai` | Chave de API (aceita `baseUrl` para endpoints compatíveis) | Requisições/tokens por minuto (pelos headers da resposta) | Experimental (só testes simulados) |

Outros provedores (ex.: Cursor) entram implementando a interface `Provider` e
passando em `extraProviders` ou `llm.register(...)`.

Requisitos: Node 20+ (usa o `fetch` nativo). Nenhuma dependência em runtime.

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
console.log(await llm.statuses())                     // { codex: { connected, ... }, anthropic: {...}, openai: {...} }
const { models, defaultModel } = await llm.listModels('codex')

// 3) Conversar (streaming)
for await (const ev of llm.stream('codex', { messages: [{ role: 'user', content: 'Oi!' }] })) {
  if (ev.type === 'delta') process.stdout.write(ev.text)
}

// ...ou só o texto final
const text = await llm.complete('anthropic', { system: 'Seja breve.', messages: [{ role: 'user', content: 'Explique SSE.' }] })
```

## Onde ficam as credenciais (`storage`)

A lib nunca escolhe isso por você. Escolha uma implementação ou escreva a sua com
`get/set/delete`:

- `createSafeStorageStorage({ safeStorage, dir })`: para **Electron**. Usa Keychain, DPAPI ou libsecret. Recomendado em apps desktop.
- `createEncryptedFileStorage({ dir, secret? })`: para Node. Grava arquivos `.enc` com AES-256-GCM (permissão 0600). Sem `secret`, gera uma chave em `dir/.key`.
- `createMemoryStorage()`: para testes e sessões efêmeras.

No Electron (processo principal):

```ts
import { app, safeStorage } from 'electron'
import { createLLM, createSafeStorageStorage } from 'llm-connector'

const llm = createLLM({
  storage: createSafeStorageStorage({ safeStorage, dir: path.join(app.getPath('userData'), 'llm') }),
})
```

Tokens e chaves **nunca** aparecem em `status()`, que só devolve e-mail, plano, chave
mascarada e datas. Em apps Electron, mantenha a lib no processo principal e exponha ao
renderer só estado e texto, nunca credenciais.

## Login do Codex em dois passos (para UIs)

```ts
const flow = await llm.codex.startLogin()        // { flowId, userCode, verificationUri, interval }
// mostre userCode e abra verificationUri; depois, a cada flow.interval segundos:
const r = await llm.codex.pollLogin(flow.flowId) // { status: 'pending', interval } | { status: 'connected', email, plan, ... }
llm.codex.cancelLogin(flow.flowId)               // se o usuário fechar a janela
```

Os tokens são renovados automaticamente, uma renovação por vez, porque o refresh token
é rotativo. Se a sessão for revogada, a lib apaga as credenciais e lança `reauth_required`.

## Limites de uso

`llm.usage(id)` devolve quanto de cada limite já foi usado, no mesmo formato para todos os provedores. Assim
dá para desenhar barras de progresso ou avisar antes de o limite acabar. `llm.usages()` faz isso para todos os
provedores conectados.

```ts
import { pacing } from 'llm-connector'

const usage = await llm.usage('codex')
// { provider: 'codex', source: 'live', plan: 'plus', limitReached: false,
//   windows: [{ id: 'primary', label: '5h', usedPercent: 42, windowSeconds: 18000, resetsAt: '...' },
//             { id: 'secondary', label: 'weekly', usedPercent: 7.5, ... }],
//   credits: { balance: '12.50', hasCredits: true, unlimited: false } }

for (const w of usage?.windows ?? []) {
  const pace = pacing(w) // { elapsedPercent, delta, pace: 'ahead' | 'on_track' | 'under' } | null
  console.log(`${w.label}: ${w.usedPercent}% usado`, pace?.pace === 'ahead' ? '(vai acabar antes de renovar)' : '')
}
```

De onde vêm os números:

- **Codex**: consulta ao vivo no endpoint de uso do ChatGPT, com a sessão em que você já entrou (sem login extra). O endpoint não é documentado e pode mudar; dá para trocar com `codex: { usageUrl }`.
- **Claude API / OpenAI API**: essas APIs não têm endpoint de uso para chaves comuns, mas toda resposta traz headers de rate limit. A lib guarda os mais recentes, inclusive de respostas `429`, então `usage()` é `null` até a primeira requisição. O `source` é `'headers'` e as janelas trazem `limit` e `remaining`.
- **Provedores próprios**: implemente o método opcional `usage()` da interface `Provider`.

`pacing(window)` compara a fatia usada com a fatia de tempo que já passou na janela: `'ahead'` quer dizer que,
nesse ritmo, o limite acaba antes de renovar. Precisa de `windowSeconds` e `resetsAt`, então devolve `null` para
os limites que vêm dos headers.

## API

- `createLLM({ storage, fetch?, userAgent?, codex?, anthropic?, openai?, extraProviders? })`
- `llm.statuses()` · `llm.usage(id)` · `llm.usages()` · `llm.listModels(id, { force? })` · `llm.stream(id, req)` · `llm.complete(id, req, onDelta?)`
- `llm.provider(id)` · `llm.register(provider)` · `llm.providers`
- `req`: `{ model?, messages, system?, maxTokens?, temperature?, signal? }`. O `signal` permite cancelar, por exemplo num botão "Parar".
- Eventos: `{ type: 'delta', text }` durante o streaming e, no fim, `{ type: 'done', text, usage? }`.
- Por provedor: `llm.anthropic.setApiKey`, `llm.openai.setApiKey`, `llm.codex.login/startLogin/pollLogin/test`, e `disconnect()` em todos.

### Erros

Tudo lança `LLMError` com `code` estável: `not_connected`, `reauth_required`,
`invalid_credentials`, `rate_limited`, `network`, `invalid_request`,
`provider_error`, `flow_expired`, `storage`, `aborted`. Use o `code` para decidir o
que fazer. As mensagens estão em inglês e podem mudar entre versões; se o seu app
mostra o erro ao usuário, traduza a partir do `code`.

```ts
import { LLMError } from 'llm-connector'

try {
  await llm.complete('codex', { messages })
} catch (error) {
  if (error instanceof LLMError && error.code === 'reauth_required') mostrarBotaoDeLogin()
  else throw error
}
```

## Desenvolvimento

```bash
npm install
npm test         # testes com fetch simulado (sem rede)
npm run typecheck
npm run build
```

## Aviso

Projeto independente, **sem afiliação** com OpenAI ou Anthropic. O login do Codex segue o fluxo do Codex CLI,
que é interno da OpenAI e pode mudar ou deixar de funcionar a qualquer momento. Use por sua conta e risco e
respeite os termos de uso de cada serviço.

## Créditos

O mapeamento de limites do Codex e a ideia de ritmo (`pacing`) vêm do [ai-usagebar](https://github.com/akitaonrails/ai-usagebar),
do Fabio Akita (MIT), um app de barra de status que acompanha os limites de uso de IA em vários provedores.

## Contribuindo

É open source (MIT) e está começando. Abra issues, teste com suas contas e mande PRs.
As prioridades estão no [CONTRIBUTING.md](CONTRIBUTING.md) (em inglês).

## Limites desta versão

- Só conversa de texto (ainda sem tool calling nem imagens).
- O login do Codex usa o fluxo do Codex CLI, que a OpenAI pode alterar. O `clientId` e a URL base são configuráveis (`codex: { clientId, baseUrl }`).
- Claude API e OpenAI API ainda não foram validadas contra as APIs reais (os testes usam respostas simuladas). Rode `examples/chat.ts` com sua chave e conte o resultado.
