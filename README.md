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

## Install & Run
```bash
npm install
npm run dev
```

The server exposes:
- `GET /auth?shop={shop-domain}` → redirects to Shopify for OAuth (rejects invalid shop domains).
- `GET /auth/callback` → validates HMAC + state (with expiry), exchanges the code for an access token.
- `GET /products?shop={shop-domain}&page_info={cursor?}&limit={1-250?}` → returns one page of product titles and images with an optional `nextPageInfo` cursor for pagination.
- `GET /health` → simple health check.

## OAuth flow (high level)
1. Merchant clicks your "Connect Shopify" button that sends them to `/auth?shop=example.myshopify.com`.
2. Shopify redirects back to `/auth/callback` with `code`, `state`, and `hmac`.
3. The callback verifies the `state` nonce and HMAC, then exchanges the `code` for an access token.
4. Tokens are stored in memory (replace with a persistent store for production).
5. `/products` uses the stored token to fetch product titles and images (250 per page, with pagination via `page_info`).

## Next steps for production
- Replace in-memory session storage with a database (e.g., Postgres or Redis).
- Serve behind HTTPS and configure your callback URL in the Partner Dashboard.
- Add webhook subscriptions for `products/create`, `products/update`, and `products/delete` to keep your SaaS in sync.
- Implement offline tokens or session tokens if you embed the app inside the Shopify admin.
- Add rate-limit handling, retries with jitter, and structured logging.
