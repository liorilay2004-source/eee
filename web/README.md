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
