# Gastoswell

An offline-capable personal finance PWA for tracking transactions, accounts, bills, debts, savings goals, and spending analytics.

## Run locally

Install dependencies:

```sh
npm install
```

For development:

```sh
npm run dev
```

For the installable PWA and offline app shell:

```sh
npm run build
npm start
```

Then open `http://127.0.0.1:3000/` in a supported browser and install Gastoswell from the browser menu. Visit the app once before using it offline so the browser can cache its files. Use the same browser and address when reopening it.

## Data and privacy

- Each local profile and its finance data are encrypted in the browser with a key derived from the profile password.
- Local mode stores encrypted data in that browser on that device. Optional cloud mode sends only the AES-GCM IV and ciphertext to MySQL; the server does not receive the password or decrypted finance records.
- Cloud authentication sends a derived verifier, which the server stores as a scrypt hash. A random HttpOnly, SameSite session cookie protects workspace requests; workspace updates use version checks so concurrent edits are not silently overwritten.
- Password recovery is not available. Download and keep a backup.
- Do not commit `data/`, `.env` files, `node_modules/`, or `dist/`.
- Use HTTPS and set `COOKIE_SECURE=true` when hosting behind HTTPS. The included server is intended for local use and is not configured for public deployment; do not expose it or XAMPP/phpMyAdmin publicly.

## Enable encrypted MySQL sync

1. In phpMyAdmin, select the existing `gastoswell` database and import `database/migrate-encrypted-sync.sql` once. It adds `users.key_salt` and creates `encrypted_workspaces`. Do not run this migration if `key_salt` already exists. For a fresh database, import `database/schema.sql` instead; it already includes both.
2. Copy `.env.example` to `.env` and set your local MySQL host, database, username, and password. Use a dedicated MySQL account with access only to `gastoswell`; never put real credentials in frontend files or share them in chat.
3. Run `npm run dev`, then use **Use encrypted cloud sync** on the login screen to create or open a cloud account. You can also register an existing local account to sync it.

Cloud sync is optional. The app keeps its encrypted local copy and remains usable offline. If two devices edit the workspace independently, choose which copy to keep when the app reports a conflict.

## Free preview deployment

The repository includes a Render Blueprint in `render.yaml` for a free preview. It builds the Vite app and serves the frontend and API from the same Node.js service. For encrypted cloud sync, use a remote MySQL-compatible database such as TiDB Cloud Starter; the local XAMPP database at `127.0.0.1` cannot be reached by Render.

1. Create a TiDB Cloud Starter instance and create the Gastoswell schema using `database/schema.sql` (or apply the encrypted-sync migration to an existing compatible database).
2. In Render, create a Blueprint from this GitHub repository and select the `render.yaml` file.
3. When prompted, enter the TiDB connection values for `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, and `DB_PASSWORD` as Render environment variables. Never add them to the repository or share them in chat.
4. Deploy and wait for the logs to confirm `Encrypted sync is using MySQL database "..."`. Open the Render URL, create a test cloud account, then verify sign-in and sync before using the app on another device.

The Blueprint enables TLS for the database connection, sets `COOKIE_SECURE=true`, and binds the service to `0.0.0.0`; Render supplies the `PORT` value. Keep the Render service and database in nearby regions when possible.

This free setup is for preview/testing, not production: Render free web services sleep after inactivity and have ephemeral local storage. Keep backups, use test data only, and review the current provider limits before deployment. Do not expose XAMPP or phpMyAdmin to the public internet.
