import dotenv from 'dotenv';
import express, { Request, Response } from 'express';
import {
  buildAuthUrl,
  exchangeToken,
  fetchProductsPage,
  getSession,
  sanitizeShopDomain,
  SHOPIFY_SCOPES,
  validateState,
  verifyCallbackHmac,
  verifyWebhookHmac,
  registerProductWebhooks,
  recordProductWebhook,
} from './shopify';
import { listWebhooks } from './storage';

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

// Use JSON body parsing for all routes except webhook endpoints (which need raw body for HMAC verification).
app.use((req, res, next) => {
  if (req.path.startsWith('/webhooks')) {
    return next();
  }
  return express.json()(req, res, next);
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.get('/auth', async (req: Request, res: Response) => {
  const shop = req.query.shop as string | undefined;
  if (!shop) {
    return res.status(400).json({ error: 'Missing shop parameter, e.g. ?shop=example.myshopify.com' });
  }

  try {
    const sanitizedShop = sanitizeShopDomain(shop);
    const { url } = await buildAuthUrl(sanitizedShop);
    res.redirect(url);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid shop domain';
    res.status(400).json({ error: message });
  }
});

app.get('/auth/callback', async (req: Request, res: Response) => {
  const { shop, code, state } = req.query as Record<string, string | undefined>;

  if (!shop || !code) {
    return res.status(400).json({ error: 'Missing shop or code in callback.' });
  }

  let sanitizedShop: string;
  try {
    sanitizedShop = sanitizeShopDomain(shop);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid shop domain';
    return res.status(400).json({ error: message });
  }

  if (!(await validateState(state, sanitizedShop))) {
    return res.status(400).json({ error: 'Invalid, expired, or missing state parameter.' });
  }

  if (!verifyCallbackHmac(req.query as Record<string, string>)) {
    return res.status(400).json({ error: 'Failed HMAC validation.' });
  }

  try {
    const session = await exchangeToken(sanitizedShop, code);
    await registerProductWebhooks(sanitizedShop, session.accessToken);
    res.json({ success: true, shop: sanitizedShop, scopes: SHOPIFY_SCOPES, accessMode: process.env.SHOPIFY_ACCESS_MODE ?? 'offline' });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ error: message });
  }
});

app.get('/products', async (req: Request, res: Response) => {
  const shop = req.query.shop as string | undefined;
  const pageInfo = req.query.page_info as string | undefined;
  const limit = Number(req.query.limit ?? '');
  if (!shop) {
    return res.status(400).json({ error: 'Missing shop parameter.' });
  }

  let sanitizedShop: string;
  try {
    sanitizedShop = sanitizeShopDomain(shop);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid shop domain';
    return res.status(400).json({ error: message });
  }

  if (!(await getSession(sanitizedShop))) {
    return res.status(401).json({ error: 'No session for this shop. Complete OAuth first.' });
  }

  try {
    const productsPage = await fetchProductsPage(sanitizedShop, { pageInfo, limit });
    res.json({ count: productsPage.products.length, nextPageInfo: productsPage.nextPageInfo, products: productsPage.products });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ error: message });
  }
});

app.post('/webhooks/products', express.raw({ type: 'application/json' }), async (req: Request, res: Response) => {
  const hmacHeader = req.header('X-Shopify-Hmac-Sha256') || req.header('x-shopify-hmac-sha256');
  if (!verifyWebhookHmac(req.body as Buffer, hmacHeader)) {
    return res.status(401).send('invalid hmac');
  }

  const topic = req.header('X-Shopify-Topic') || 'unknown';
  const shopDomain = req.header('X-Shopify-Shop-Domain') || 'unknown-shop';

  try {
    const payload = JSON.parse((req.body as Buffer).toString('utf-8'));
    await recordProductWebhook(shopDomain, topic, payload);
    res.status(200).send('ok');
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to parse webhook payload';
    res.status(500).json({ error: message });
  }
});

app.get('/webhooks/products', async (_req: Request, res: Response) => {
  const events = await listWebhooks();
  res.json({ count: events.length, events });
});

app.listen(port, () => {
  console.log(`Shopify public app running at http://localhost:${port}`);
});
