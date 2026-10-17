import type { CredentialStorage } from './types.js'

/** Keeps everything in process memory. Good for tests and short-lived sessions. */
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
