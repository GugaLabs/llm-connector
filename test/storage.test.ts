import { mkdtemp, readFile, readdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createEncryptedFileStorage, createMemoryStorage, createSafeStorageStorage } from '../src/index.js'

describe('storage', () => {
  it('memória: get/set/delete', async () => {
    const s = createMemoryStorage()
    expect(await s.get('a')).toBeNull()
    await s.set('a', '1')
    expect(await s.get('a')).toBe('1')
    await s.delete('a')
    expect(await s.get('a')).toBeNull()
  })

  it('arquivo criptografado: não guarda texto puro e relê', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'llm-'))
    const s = createEncryptedFileStorage({ dir, secret: 'segredo' })
    await s.set('codex', 'token-super-secreto')
    expect(await s.get('codex')).toBe('token-super-secreto')
    expect(await readFile(join(dir, 'codex.enc'), 'utf8')).not.toContain('token-super-secreto')
    expect((await stat(join(dir, 'codex.enc'))).mode & 0o777).toBe(0o600)
    // outro segredo não consegue ler
    expect(await createEncryptedFileStorage({ dir, secret: 'outro' }).get('codex')).toBeNull()
    await s.delete('codex')
    expect(await s.get('codex')).toBeNull()
  })

  it('arquivo criptografado sem segredo gera .key e persiste entre instâncias', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'llm-'))
    await createEncryptedFileStorage({ dir }).set('k', 'v')
    expect(await readdir(dir)).toContain('.key')
    expect(await createEncryptedFileStorage({ dir }).get('k')).toBe('v')
  })

  it('rejeita chaves com caminho', async () => {
    const s = createEncryptedFileStorage({ dir: await mkdtemp(join(tmpdir(), 'llm-')), secret: 'x' })
    await expect(s.get('../evil')).resolves.toBeNull()
    await expect(s.set('../evil', 'x')).rejects.toThrow()
  })

  it('safeStorage (adaptador) criptografa via função fornecida', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'llm-'))
    const fake = {
      isEncryptionAvailable: () => true,
      encryptString: (s: string) => Buffer.from(s).reverse(),
      decryptString: (b: Buffer) => Buffer.from(b).reverse().toString(),
    }
    const s = createSafeStorageStorage({ safeStorage: fake, dir })
    await s.set('codex', 'abc')
    expect(await s.get('codex')).toBe('abc')
    const off = createSafeStorageStorage({ safeStorage: { ...fake, isEncryptionAvailable: () => false }, dir })
    expect(await off.get('codex')).toBeNull()
    await expect(off.set('codex', 'x')).rejects.toMatchObject({ code: 'storage' })
  })
})
