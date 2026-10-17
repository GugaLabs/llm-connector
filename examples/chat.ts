// Uso: npx tsx examples/chat.ts codex|anthropic|openai "sua pergunta"
// (instale o tsx só para rodar o exemplo: npm i -D tsx)
import { createLLM, createEncryptedFileStorage } from '../src/index.js'

const [provider = 'codex', ...rest] = process.argv.slice(2)
const prompt = rest.join(' ') || 'Diga olá em uma frase.'
const llm = createLLM({ storage: createEncryptedFileStorage({ dir: './.llm-example' }) })

if (!(await llm.provider(provider).status()).connected) {
  if (provider === 'codex') {
    await llm.codex.login({ onCode: (f) => console.log(`Abra ${f.verificationUri} e digite: ${f.userCode}`) })
  } else {
    const key = process.env[provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY']
    if (!key) throw new Error('Defina ANTHROPIC_API_KEY ou OPENAI_API_KEY.')
    await (provider === 'anthropic' ? llm.anthropic : llm.openai).setApiKey(key)
  }
}

for await (const ev of llm.stream(provider, { messages: [{ role: 'user', content: prompt }] })) {
  if (ev.type === 'delta') process.stdout.write(ev.text)
}
console.log()
