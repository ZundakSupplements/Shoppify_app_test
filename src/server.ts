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
} from './shopify';

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.get('/auth', (req: Request, res: Response) => {
  const shop = req.query.shop as string | undefined;
  if (!shop) {
    return res.status(400).json({ error: 'Missing shop parameter, e.g. ?shop=example.myshopify.com' });
  }

  try {
    const sanitizedShop = sanitizeShopDomain(shop);
    const { url } = buildAuthUrl(sanitizedShop);
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

  if (!validateState(state, sanitizedShop)) {
    return res.status(400).json({ error: 'Invalid, expired, or missing state parameter.' });
  }

  if (!verifyCallbackHmac(req.query as Record<string, string>)) {
    return res.status(400).json({ error: 'Failed HMAC validation.' });
  }

  try {
    await exchangeToken(sanitizedShop, code);
    res.json({ success: true, shop: sanitizedShop, scopes: SHOPIFY_SCOPES });
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

  if (!getSession(sanitizedShop)) {
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

app.listen(port, () => {
  console.log(`Shopify public app running at http://localhost:${port}`);
});
