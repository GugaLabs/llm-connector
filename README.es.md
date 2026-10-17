# llm-connector

[English](README.md) · [Português (Brasil)](README.pt-BR.md) · **Español**

> Esta es una traducción. La referencia es el [README en inglés](README.md): si las versiones no coinciden, prevalece la inglesa.

[![CI](https://github.com/GugaLabs/llm-connector/actions/workflows/ci.yml/badge.svg)](https://github.com/GugaLabs/llm-connector/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/llm-connector/beta)](https://www.npmjs.com/package/llm-connector)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

> **Versión inicial (beta, `0.0.1-beta`).** La API puede cambiar sin aviso antes de la `1.0`.
> Por ahora **Codex** es el proveedor de referencia: es el único validado en una app real.
> **Claude API y OpenAI API están implementadas, pero solo se probaron con respuestas simuladas.** Todavía hay que probarlas contra las APIs reales. Cualquier ayuda es bienvenida: consulta el [CONTRIBUTING](CONTRIBUTING.md).

Conectores listos para LLMs, con una sola API. Instalas la librería, eliges dónde
guardar las credenciales y usas `login`, `listModels` y `stream`. No hace falta reescribir
OAuth, renovación de tokens, parsers de streaming ni catálogos de modelos en cada proyecto.

| Proveedor | Id | Autenticación | Límites de uso | Estado |
| --- | --- | --- | --- | --- |
| Codex (suscripción ChatGPT) | `codex` | Inicio de sesión con código en el navegador (OAuth); el uso cuenta en el plan de ChatGPT | Ventanas de 5h y semanal, créditos (en vivo) | Referencia (validado en una app real) |
| Claude API | `anthropic` | Clave de API | Solicitudes/tokens por minuto (desde los headers de la respuesta) | Experimental (solo pruebas simuladas) |
| OpenAI API | `openai` | Clave de API (acepta `baseUrl` para endpoints compatibles) | Solicitudes/tokens por minuto (desde los headers de la respuesta) | Experimental (solo pruebas simuladas) |

Puedes añadir otros proveedores (p. ej. Cursor) implementando la interfaz `Provider` y
pasándolos en `extraProviders` o con `llm.register(...)`.

Requisitos: Node 20+ (usa el `fetch` nativo). Sin dependencias en runtime.

## Instalación

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
await llm.anthropic.setApiKey('sk-ant-...')          // valida la clave y la guarda
await llm.codex.login({                               // suscripción ChatGPT
  onCode: ({ userCode, verificationUri }) => console.log(`Abre ${verificationUri} e introduce ${userCode}`),
})

// 2) Ver estado y modelos
console.log(await llm.statuses())                     // { codex: { connected, ... }, anthropic: {...}, openai: {...} }
const { models, defaultModel } = await llm.listModels('codex')

// 3) Conversar (streaming)
for await (const ev of llm.stream('codex', { messages: [{ role: 'user', content: '¡Hola!' }] })) {
  if (ev.type === 'delta') process.stdout.write(ev.text)
}

// ...o solo el texto final
const text = await llm.complete('anthropic', { system: 'Sé breve.', messages: [{ role: 'user', content: 'Explica SSE.' }] })
```

## Dónde se guardan las credenciales (`storage`)

La librería nunca lo decide por ti. Elige una implementación o escribe la tuya con
`get/set/delete`:

- `createSafeStorageStorage({ safeStorage, dir })`: para **Electron**. Usa Keychain, DPAPI o libsecret. Recomendado en apps de escritorio.
- `createEncryptedFileStorage({ dir, secret? })`: para Node. Guarda archivos `.enc` con AES-256-GCM (permisos 0600). Sin `secret`, genera una clave en `dir/.key`.
- `createMemoryStorage()`: para pruebas y sesiones efímeras.

En Electron (proceso principal):

```ts
import { app, safeStorage } from 'electron'
import { createLLM, createSafeStorageStorage } from 'llm-connector'

const llm = createLLM({
  storage: createSafeStorageStorage({ safeStorage, dir: path.join(app.getPath('userData'), 'llm') }),
})
```

Los tokens y las claves **nunca** aparecen en `status()`, que solo devuelve e-mail, plan,
clave enmascarada y fechas. En apps Electron, mantén la librería en el proceso principal y
expón al renderer solo estado y texto, nunca credenciales.

## Inicio de sesión de Codex en dos pasos (para interfaces)

```ts
const flow = await llm.codex.startLogin()        // { flowId, userCode, verificationUri, interval }
// muestra userCode y abre verificationUri; luego, cada flow.interval segundos:
const r = await llm.codex.pollLogin(flow.flowId) // { status: 'pending', interval } | { status: 'connected', email, plan, ... }
llm.codex.cancelLogin(flow.flowId)               // si el usuario cierra la ventana
```

Los tokens se renuevan automáticamente, de uno en uno, porque el refresh token rota.
Si la sesión se revoca, la librería borra las credenciales y lanza `reauth_required`.

## Límites de uso

`llm.usage(id)` devuelve cuánto se ha usado de cada límite, con el mismo formato para todos los proveedores, para
que puedas dibujar barras de progreso o avisar antes de llegar al límite. `llm.usages()` lo hace para todos los
proveedores conectados.

```ts
import { pacing } from 'llm-connector'

const usage = await llm.usage('codex')
// { provider: 'codex', source: 'live', plan: 'plus', limitReached: false,
//   windows: [{ id: 'primary', label: '5h', usedPercent: 42, windowSeconds: 18000, resetsAt: '...' },
//             { id: 'secondary', label: 'weekly', usedPercent: 7.5, ... }],
//   credits: { balance: '12.50', hasCredits: true, unlimited: false } }

for (const w of usage?.windows ?? []) {
  const pace = pacing(w) // { elapsedPercent, delta, pace: 'ahead' | 'on_track' | 'under' } | null
  console.log(`${w.label}: ${w.usedPercent}% usado`, pace?.pace === 'ahead' ? '(se agotará antes de renovarse)' : '')
}
```

De dónde salen los números:

- **Codex**: se consulta en vivo en el endpoint de uso de ChatGPT, con la sesión que ya iniciaste (sin login extra). El endpoint no está documentado y puede cambiar; puedes reemplazarlo con `codex: { usageUrl }`.
- **Claude API / OpenAI API**: estas APIs no tienen endpoint de uso para claves normales, pero cada respuesta trae headers de rate limit. La librería guarda los más recientes, incluso de respuestas `429`, así que `usage()` es `null` hasta la primera solicitud. El `source` es `'headers'` y las ventanas incluyen `limit` y `remaining`.
- **Proveedores propios**: implementa el método opcional `usage()` de la interfaz `Provider`.

`pacing(window)` compara la parte usada con la parte de tiempo transcurrida en la ventana: `'ahead'` significa que,
a ese ritmo, el límite se agotará antes de renovarse. Necesita `windowSeconds` y `resetsAt`, así que devuelve `null`
para los límites que vienen de los headers.

## API

- `createLLM({ storage, fetch?, userAgent?, codex?, anthropic?, openai?, extraProviders? })`
- `llm.statuses()` · `llm.usage(id)` · `llm.usages()` · `llm.listModels(id, { force? })` · `llm.stream(id, req)` · `llm.complete(id, req, onDelta?)`
- `llm.provider(id)` · `llm.register(provider)` · `llm.providers`
- `req`: `{ model?, messages, system?, maxTokens?, temperature?, signal? }`. `signal` permite cancelar, por ejemplo desde un botón "Detener".
- Eventos: `{ type: 'delta', text }` durante el streaming y, al final, `{ type: 'done', text, usage? }`.
- Por proveedor: `llm.anthropic.setApiKey`, `llm.openai.setApiKey`, `llm.codex.login/startLogin/pollLogin/test`, y `disconnect()` en todos.

### Errores

Todo lanza `LLMError` con un `code` estable: `not_connected`, `reauth_required`,
`invalid_credentials`, `rate_limited`, `network`, `invalid_request`,
`provider_error`, `flow_expired`, `storage`, `aborted`. Decide según el `code`. Los
mensajes están en inglés y pueden cambiar entre versiones; si tu app muestra el error
al usuario, tradúcelo a partir del `code`.

```ts
import { LLMError } from 'llm-connector'

try {
  await llm.complete('codex', { messages })
} catch (error) {
  if (error instanceof LLMError && error.code === 'reauth_required') mostrarBotonDeLogin()
  else throw error
}
```

## Desarrollo

```bash
npm install
npm test         # pruebas con fetch simulado (sin red)
npm run typecheck
npm run build
```

## Aviso

Proyecto independiente, **sin afiliación** con OpenAI ni Anthropic. El inicio de sesión de Codex sigue el flujo
del Codex CLI, que es interno de OpenAI y puede cambiar o dejar de funcionar en cualquier momento. Úsalo bajo tu
propia responsabilidad y respeta los términos de uso de cada servicio.

## Créditos

El mapeo de límites de Codex y la idea de ritmo (`pacing`) vienen de [ai-usagebar](https://github.com/akitaonrails/ai-usagebar),
de Fabio Akita (MIT), una app de barra de estado que sigue los límites de uso de IA en muchos proveedores.

## Contribuir

Es open source (MIT) y está empezando. Abre issues, pruébalo con tus cuentas y envía PRs.
Las prioridades están en [CONTRIBUTING.md](CONTRIBUTING.md) (en inglés).

## Limitaciones de esta versión

- Solo chat de texto (todavía sin tool calling ni imágenes).
- El inicio de sesión de Codex usa el flujo del Codex CLI, que OpenAI puede cambiar. El `clientId` y la URL base son configurables (`codex: { clientId, baseUrl }`).
- Claude API y OpenAI API aún no se validaron contra las APIs reales (las pruebas usan respuestas simuladas). Ejecuta `examples/chat.ts` con tu clave y cuéntanos el resultado.
