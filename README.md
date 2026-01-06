# Shopify Public App (Node + TypeScript)

This project is a minimal public app skeleton that lets your SaaS import product titles and images from a merchant's Shopify store. It covers the OAuth flow, HMAC validation, access token exchange, and a sample `/products` endpoint that reads products through the Admin API.

## Prerequisites
- Node.js 18+
- Shopify Partner account and app credentials (API key & secret)
- A public-facing HTTPS domain for OAuth callbacks (use ngrok for local dev)

## Environment
Copy the example file and fill in your credentials:

```bash
cp .env.example .env
```

Required values:
- `SHOPIFY_API_KEY` and `SHOPIFY_API_SECRET`: From your Partner Dashboard
- `APP_URL`: Base URL of this server (e.g., `https://<ngrok>.ngrok.io`)
- `SHOPIFY_SCOPES`: Comma-separated scopes; defaults to `read_products`
- `STATE_TTL_MS`: Optional. How long (in ms) the OAuth `state` nonce stays valid. Defaults to 5 minutes.
- `PORT`: Local port (default `3000`)
- `SHOPIFY_ACCESS_MODE`: `offline` (default) or `per-user` for embedded/online token mode.
- `DATA_DIR`: Where to persist sessions/states/webhooks (default `./data`).

## Install & Run
```bash
npm install
npm run dev
```

The server exposes:
- `GET /auth?shop={shop-domain}` → redirects to Shopify for OAuth (rejects invalid shop domains).
- `GET /auth/callback` → validates HMAC + state (with expiry), exchanges the code for an access token, and registers product webhooks.
- `GET /products?shop={shop-domain}&page_info={cursor?}&limit={1-250?}` → returns one page of product titles and images with an optional `nextPageInfo` cursor for pagination.
- `POST /webhooks/products` → receives `products/create|update|delete` webhooks (HMAC verified) and persists payloads.
- `GET /webhooks/products` → lists the most recent product webhook payloads stored on disk.
- `GET /health` → simple health check.

## OAuth flow (high level)
1. Merchant clicks your "Connect Shopify" button that sends them to `/auth?shop=example.myshopify.com`.
2. Shopify redirects back to `/auth/callback` with `code`, `state`, and `hmac`.
3. The callback verifies the `state` nonce and HMAC, then exchanges the `code` for an access token.
4. Tokens and state nonces are persisted to disk (`DATA_DIR`) so you can restart or scale horizontally without losing installs.
5. `/products` uses the stored token to fetch product titles and images (250 per page, with pagination via `page_info`).
6. On successful install, the app auto-registers product webhooks and stores incoming payloads for inspection via `GET /webhooks/products`.

## Production notes
- **Persistence**: update `DATA_DIR` to point to shared durable storage (NFS/S3-backed volume, DB-backed store, or Redis) for sessions, states, and webhook audit records.
- **HTTPS**: run behind TLS and configure the callback/webhook URLs in the Partner Dashboard.
- **Webhooks**: `products/create|update|delete` are auto-registered after OAuth; ensure your public URL exposes `/webhooks/products`.
- **Rate limiting**: Shopify requests automatically back off with exponential retry when the bucket nears capacity or 429/5xx responses are returned. Tune `BASE_DELAY_MS`/`MAX_RETRIES` in `src/shopify.ts` if needed.
- **Embedded mode**: set `SHOPIFY_ACCESS_MODE=per-user` to request online tokens suitable for embedded App Bridge flows. Add client-side session token validation as needed.
