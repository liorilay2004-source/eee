# Web app

Hebrew RTL flight search UI built with React, Vite, TypeScript and Tailwind CSS.

## Local development

```sh
npm ci
npm run dev
```

The Vite dev server proxies `/api/*` to the Cloudflare Worker. Production builds use `VITE_API_BASE`, defaulting to the deployed `eee-api` Worker URL.

## Checks and build

```sh
npm run lint
npm test
npm run build
```

## Cloudflare Pages

Build with `npm run build`, then deploy the generated `dist/` directory with Wrangler Pages. The Worker must allow the exact Pages origin through `ALLOWED_ORIGIN`. The current API needs a Travelpayouts token for live price searches.

## UI notes

- The search is a sentence of five question chips (from, to, when, how long, who). Each chip opens one focused dialog (bottom sheet on phones, popover on desktop). Pure logic for months, durations, pair counts, error mapping and empty-state suggestions lives in `src/lib/builder.ts` with tests in `builder.test.ts`.
- Results are bound to the submitted request, never to the live form; editing marks them as belonging to the previous search.
- Prices are Aviasales cached fares: the UI never claims they were checked live.
- Heebo is self-hosted from `src/assets/fonts` (SIL OFL, see `OFL.txt`), so there are no third-party font requests and the CSP stays `font-src 'self'`.
- `public/sw.js` is network-first for pages; the `stamp-service-worker` plugin in `vite.config.ts` writes a per-build id into `dist/sw.js` so each deploy replaces the old caches.
- Private-use lock: when the Worker has the `ACCESS_KEY` secret, every page shows a Hebrew lock screen until the key is entered once per browser (`src/components/LockScreen.tsx`, logic in `src/lib/access.ts`). The key is kept in localStorage (`eee.accessKey`, memory only where storage is blocked) and sent only as `Authorization: Bearer <key>` by `src/api/client.ts`; it never goes into a URL, and the service worker never handles API requests. Without the secret (or against an older API with no `/api/auth/check`) the app behaves exactly as before. Deploy this build before the secret is set: an older build has no lock screen, so against a locked API it can only show errors. Every API call must go through `apiCall` (or `getJson`/`postJson`) in `src/api/client.ts`, which adds the key; `src/lib/client-guard.test.ts` fails on any other `fetch()`. Setup: `docs/CLOUDFLARE_SETUP.md`, section 6ג.
