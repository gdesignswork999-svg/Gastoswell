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

- Each local profile and its finance data are encrypted with the profile password and stored in that browser on that device.
- Data does not currently sync between devices or to an online MySQL database.
- Password recovery is not available. Download and keep a backup.
- Do not commit `data/`, `.env` files, `node_modules/`, or `dist/`.
- The existing `server.js` includes a local JSON API and is not configured for public deployment. Do not expose it publicly.

## Current deployment status

The PWA can be built and served locally. Public hosting, GitHub Pages/Vercel deployment configuration, and cloud database synchronization are not configured yet.
