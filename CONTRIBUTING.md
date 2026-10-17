# Contributing

Thanks for your interest! `llm-connector` is open source and in **beta**, so all help is welcome, especially:

- **Testing against real accounts and APIs.** Claude API and OpenAI API only have mocked tests so far; report what you find.
- New providers (e.g. Cursor, Gemini, Ollama) implementing the `Provider` interface (`src/types.ts`).
- Support for *tool calling*, images and *structured output*.
- Documentation and example improvements.

## Getting started

```bash
npm install
npm run typecheck
npm test        # no network: uses a mocked fetch
npm run build
```

## Pull requests

1. Open an issue first for large changes, so we can agree on the approach.
2. Add tests (`test/`) for what you change. New providers need tests with a mocked `fetch`, like the existing ones.
3. Make sure `npm run typecheck && npm test` pass.
4. **Never** include keys, tokens or account data in code, tests, issues or logs.
5. Update `CHANGELOG.md`.

## Language and translations

English is the project language: code, comments, error messages, issues and the main docs.
`README.md` is the source of truth. Translations live next to it as `README.<locale>.md`
(currently `README.pt-BR.md` and `README.es.md`).

- When you change `README.md`, update the translations too if you can. If you can't, say so in the PR and a maintainer will follow up.
- New translations are welcome. Copy the structure of an existing one, keep the note that English is the reference, and add a link to the language bar at the top of every README.

## Security

Found a flaw involving credentials? Don't open a public issue; see [SECURITY.md](SECURITY.md).
