# Changelog

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows [SemVer](https://semver.org/).

## [0.0.1-beta.1] - 2026-10-17

### Changed
- English is now the package language: docs, code comments and `LLMError` messages (previously Portuguese). Branch on `error.code`, not on the message.
- The README is in English, with translations in `README.pt-BR.md` and `README.es.md`.

### Fixed
- `codex.login({ signal })` now stops right away when the signal is aborted during `onCode`, instead of waiting for authorization.

### Added
- Usage limits: `llm.usage(id)`, `llm.usages()` and a shared `UsageSnapshot` shape. Codex reads the 5h and weekly windows plus credits from the ChatGPT usage endpoint; Claude API and OpenAI API keep the rate limits from the latest response headers (including `429`s). Custom providers can implement the optional `Provider.usage()`.
- `pacing(window)` helper that tells whether usage is ahead of, on track with or under the elapsed time.
- Credits to [ai-usagebar](https://github.com/akitaonrails/ai-usagebar) (MIT), source of the Codex usage mapping and the pacing idea.
- Broader test suite (15 → 59 tests): SSE parsing, HTTP error mapping, timeouts, model caching, in-stream errors, device-code edge cases, storage tampering and usage limits.

## [0.0.1-beta.0] - 2026-10-17

First public release (beta).

### Added
- Unified `createLLM` client with `statuses`, `listModels`, `stream` and `complete`.
- **Codex** provider (ChatGPT subscription): device-code sign-in, token refresh protected against concurrent refreshes, model catalog and streaming.
- **Claude API** (Anthropic) and **OpenAI API** providers (with `baseUrl` for compatible endpoints), using API keys.
- Pluggable credential storage: memory, encrypted file (AES-256-GCM) and an adapter for Electron's `safeStorage`.
- `Provider` interface for new providers, and typed errors (`LLMError`).
