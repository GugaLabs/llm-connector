/**
 * Onde a biblioteca guarda credenciais (tokens, chaves de API). É uma interface
 * pequena de propósito: cada app escolhe a implementação que combina com ele.
 */
export interface CredentialStorage {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
}

export const STORAGE_KEY_PATTERN = /^[A-Za-z0-9._-]{1,80}$/

export function assertStorageKey(key: string): void {
  if (!STORAGE_KEY_PATTERN.test(key) || key === '.' || key === '..') {
    throw new Error(`Chave de armazenamento inválida: ${key}`)
  }
}
