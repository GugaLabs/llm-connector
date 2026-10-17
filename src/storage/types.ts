/**
 * Where the library stores credentials (tokens, API keys). Deliberately small so
 * each app can plug in the implementation that fits it.
 */
export interface CredentialStorage {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
}

export const STORAGE_KEY_PATTERN = /^[A-Za-z0-9._-]{1,80}$/

export function assertStorageKey(key: string): void {
  if (!STORAGE_KEY_PATTERN.test(key) || key === '.' || key === '..') {
    throw new Error(`Invalid storage key: ${key}`)
  }
}
