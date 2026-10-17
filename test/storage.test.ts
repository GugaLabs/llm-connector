import { mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createEncryptedFileStorage, createMemoryStorage, createSafeStorageStorage } from '../src/index.js'

const tempDir = () => mkdtemp(join(tmpdir(), 'llm-'))

describe('storage', () => {
  it('memory: get/set/delete and initial values', async () => {
    const s = createMemoryStorage({ seeded: 'yes' })
    expect(await s.get('seeded')).toBe('yes')
    expect(await s.get('a')).toBeNull()
    await s.set('a', '1')
    expect(await s.get('a')).toBe('1')
    await s.delete('a')
    expect(await s.get('a')).toBeNull()
  })

  it('encrypted file: never stores plain text and reads it back', async () => {
    const dir = await tempDir()
    const s = createEncryptedFileStorage({ dir, secret: 'secret' })
    await s.set('codex', 'super-secret-token')
    expect(await s.get('codex')).toBe('super-secret-token')
    expect(await readFile(join(dir, 'codex.enc'), 'utf8')).not.toContain('super-secret-token')
    expect((await stat(join(dir, 'codex.enc'))).mode & 0o777).toBe(0o600)
    // a different secret cannot read it
    expect(await createEncryptedFileStorage({ dir, secret: 'other' }).get('codex')).toBeNull()
    await s.delete('codex')
    expect(await s.get('codex')).toBeNull()
  })

  it('encrypted file without a secret creates .key and persists across instances', async () => {
    const dir = await tempDir()
    await createEncryptedFileStorage({ dir }).set('k', 'v')
    expect(await readdir(dir)).toContain('.key')
    expect((await stat(join(dir, '.key'))).mode & 0o777).toBe(0o600)
    expect(await createEncryptedFileStorage({ dir }).get('k')).toBe('v')
  })

  it('encrypted file: uses a fresh IV per write', async () => {
    const dir = await tempDir()
    const s = createEncryptedFileStorage({ dir, secret: 'x' })
    await s.set('k', 'same')
    const first = await readFile(join(dir, 'k.enc'), 'utf8')
    await s.set('k', 'same')
    expect(await readFile(join(dir, 'k.enc'), 'utf8')).not.toBe(first)
  })

  it('encrypted file: a corrupted or tampered file reads as null', async () => {
    const dir = await tempDir()
    const s = createEncryptedFileStorage({ dir, secret: 'x' })
    await writeFile(join(dir, 'broken.enc'), 'not json')
    expect(await s.get('broken')).toBeNull()
    await s.set('k', 'value')
    const box = JSON.parse(await readFile(join(dir, 'k.enc'), 'utf8'))
    box.data = Buffer.from('tampered').toString('base64')
    await writeFile(join(dir, 'k.enc'), JSON.stringify(box))
    expect(await s.get('k')).toBeNull()
  })

  it('rejects keys that look like paths', async () => {
    const s = createEncryptedFileStorage({ dir: await tempDir(), secret: 'x' })
    await expect(s.get('../evil')).resolves.toBeNull()
    await expect(s.set('../evil', 'x')).rejects.toThrow()
    await expect(s.set('..', 'x')).rejects.toThrow()
    await expect(s.set('a/b', 'x')).rejects.toThrow()
  })

  it('safeStorage adapter encrypts through the given functions', async () => {
    const dir = await tempDir()
    const fake = {
      isEncryptionAvailable: () => true,
      encryptString: (s: string) => Buffer.from(s).reverse(),
      decryptString: (b: Buffer) => Buffer.from(b).reverse().toString(),
    }
    const s = createSafeStorageStorage({ safeStorage: fake, dir })
    await s.set('codex', 'abc')
    expect(await s.get('codex')).toBe('abc')
    expect(await readFile(join(dir, 'codex.bin'), 'utf8')).toBe('cba')
    const off = createSafeStorageStorage({ safeStorage: { ...fake, isEncryptionAvailable: () => false }, dir })
    expect(await off.get('codex')).toBeNull()
    await expect(off.set('codex', 'x')).rejects.toMatchObject({ code: 'storage' })
    await s.delete('codex')
    expect(await s.get('codex')).toBeNull()
  })
})
