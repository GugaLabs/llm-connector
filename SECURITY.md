# Segurança

Se você encontrar uma vulnerabilidade (principalmente envolvendo armazenamento ou vazamento de tokens/chaves),
reporte de forma privada em **Security › Report a vulnerability** neste repositório do GitHub, em vez de abrir uma issue pública.

Lembretes de uso seguro:

- Prefira `createSafeStorageStorage` (Electron) ou `createEncryptedFileStorage` com `secret` vindo do seu app; evite guardar credenciais em texto puro.
- Em apps desktop, mantenha a lib no processo principal e nunca exponha tokens à interface.
