import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { LLMError } from '../types.js'
import { assertStorageKey, type CredentialStorage } from './types.js'

/** Parte do `safeStorage` do Electron que usamos (tipo estrutural: não dependemos do Electron). */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(plain: string): Buffer
  decryptString(encrypted: Buffer): string
}

/**
 * Criptografa com o Keychain (macOS), DPAPI (Windows) ou libsecret (Linux) via
 * `safeStorage` do Electron. Use no processo principal:
 *
 *   createSafeStorageStorage({ safeStorage, dir: path.join(app.getPath('userData'), 'llm') })
 */
export function createSafeStorageStorage(options: { safeStorage: SafeStorageLike; dir: string }): CredentialStorage {
  const { safeStorage, dir } = options
  const filePath = (key: string) => {
    assertStorageKey(key)
    return join(dir, `${key}.bin`)
  }
  return {
    async get(key) {
      try {
        if (!safeStorage.isEncryptionAvailable()) return null
        return safeStorage.decryptString(await readFile(filePath(key)))
      } catch {
        return null
      }
    },
    async set(key, value) {
      if (!safeStorage.isEncryptionAvailable()) {
        throw new LLMError('O armazenamento seguro do sistema não está disponível; não é seguro guardar a credencial.', 'storage')
      }
      await mkdir(dir, { recursive: true })
      await writeFile(filePath(key), safeStorage.encryptString(value), { mode: 0o600 })
    },
    async delete(key) {
      await rm(filePath(key), { force: true })
    },
  }
}
