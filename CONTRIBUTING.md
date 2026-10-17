# Contribuindo

Obrigado pelo interesse! O `llm-connector` é open source e está em **beta**: toda ajuda é bem-vinda, principalmente:

- **Testar contra contas e APIs reais** (Claude API e OpenAI API ainda só têm testes com respostas simuladas) e reportar o que encontrar.
- Novos provedores (ex.: Cursor, Gemini, Ollama) implementando a interface `Provider` (`src/types.ts`).
- Suporte a *tool calling*, imagens e *structured output*.
- Melhorias de documentação e exemplos.

## Como rodar

```bash
npm install
npm run typecheck
npm test        # sem rede: usa fetch simulado
npm run build
```

## Pull requests

1. Abra uma issue para mudanças grandes, para alinharmos antes.
2. Inclua testes (`test/`) para o que mudar; novos provedores devem ter testes com `fetch` simulado, como os existentes.
3. Garanta `npm run typecheck && npm test` passando.
4. **Nunca** inclua chaves, tokens ou dados de conta em código, testes, issues ou logs.
5. Atualize o `CHANGELOG.md`.

## Segurança

Achou uma falha que envolve credenciais? Não abra issue pública: veja o `SECURITY.md`.
