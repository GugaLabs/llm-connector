# Changelog

Formato baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/); versionamento [SemVer](https://semver.org/lang/pt-BR/).

## [0.0.1-beta.0] - 2026-10-17

Primeira versão pública (beta).

### Adicionado
- Cliente unificado `createLLM` com `statuses`, `listModels`, `stream` e `complete`.
- Provedor **Codex** (assinatura do ChatGPT): login por código, renovação de token com proteção contra renovações simultâneas, catálogo de modelos e streaming.
- Provedor **Claude API** (Anthropic) e **OpenAI API** (com `baseUrl` para endpoints compatíveis), por chave de API.
- Armazenamento de credenciais plugável: memória, arquivo criptografado (AES-256-GCM) e adaptador para o `safeStorage` do Electron.
- Interface `Provider` para novos provedores e erros tipados (`LLMError`).
