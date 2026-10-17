import type { CredentialStorage } from './types.js'

/** Guarda tudo só na memória do processo. Bom para testes e sessões efêmeras. */
export function createMemoryStorage(initial: Record<string, string> = {}): CredentialStorage {
  const data = new Map(Object.entries(initial))
  return {
    async get(key) {
      return data.get(key) ?? null
    },
    async set(key, value) {
      data.set(key, value)
    },
    async delete(key) {
      data.delete(key)
    },
  }
}
