import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { LLMError } from '../types.js'
import { assertStorageKey, type CredentialStorage } from './types.js'

export interface EncryptedFileStorageOptions {
  /** Folder for the encrypted files (one per credential). */
  dir: string
  /**
   * Secret used to derive the AES-256 key. If omitted, a random key is created at
   * `<dir>/.key` (0600): it protects against casual reads of the files, but not
   * against someone with access to the whole folder. Prefer passing a secret from
   * your app's keychain or an environment variable.
   */
  secret?: string | Buffer
}

/** `<key>.enc` files encrypted with AES-256-GCM. Works in any Node app. */
export function createEncryptedFileStorage(options: EncryptedFileStorageOptions): CredentialStorage {
  let keyPromise: Promise<Buffer> | null = null

  const getKey = () => {
    keyPromise ??= (async () => {
      if (options.secret !== undefined) return scryptSync(options.secret, 'llm-connector/v1', 32)
      await mkdir(options.dir, { recursive: true, mode: 0o700 })
      const keyPath = join(options.dir, '.key')
      try {
        return Buffer.from((await readFile(keyPath, 'utf8')).trim(), 'base64')
      } catch {
        const fresh = randomBytes(32)
        await writeFile(keyPath, fresh.toString('base64'), { mode: 0o600 })
        return fresh
      }
    })()
    return keyPromise
  }

  const filePath = (key: string) => {
    assertStorageKey(key)
    return join(options.dir, `${key}.enc`)
  }

  return {
    async get(key) {
      let raw: string
      try {
        raw = await readFile(filePath(key), 'utf8')
      } catch {
        return null
      }
      try {
        const box = JSON.parse(raw) as { iv: string; tag: string; data: string }
        const decipher = createDecipheriv('aes-256-gcm', await getKey(), Buffer.from(box.iv, 'base64'))
        decipher.setAuthTag(Buffer.from(box.tag, 'base64'))
        return Buffer.concat([decipher.update(Buffer.from(box.data, 'base64')), decipher.final()]).toString('utf8')
      } catch {
        // Corrupted file or different key: treat as "not connected".
        return null
      }
    },
    async set(key, value) {
      const path = filePath(key)
      try {
        await mkdir(options.dir, { recursive: true, mode: 0o700 })
        const iv = randomBytes(12)
        const cipher = createCipheriv('aes-256-gcm', await getKey(), iv)
        const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
        const box = { v: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') }
        await writeFile(path, JSON.stringify(box), { mode: 0o600 })
      } catch (error) {
        throw new LLMError(`Could not write the credential: ${(error as Error).message}`, 'storage')
      }
    },
    async delete(key) {
      await rm(filePath(key), { force: true })
    },
  }
}
