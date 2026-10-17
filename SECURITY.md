# Security

If you find a vulnerability, especially one involving how tokens or keys are stored or leaked, report it
privately through **Security › Report a vulnerability** in this GitHub repository instead of opening a public issue.

Safe-usage reminders:

- Prefer `createSafeStorageStorage` (Electron) or `createEncryptedFileStorage` with a `secret` supplied by your app. Avoid storing credentials in plain text.
- In desktop apps, keep the library in the main process and never expose tokens to the UI.
