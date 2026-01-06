import dotenv from 'dotenv';
import express, { Request, Response } from 'express';
import {
  buildAuthUrl,
  exchangeToken,
  fetchProducts,
  getSession,
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

  const { url } = buildAuthUrl(shop);
  res.redirect(url);
});

app.get('/auth/callback', async (req: Request, res: Response) => {
  const { shop, code, state } = req.query as Record<string, string | undefined>;

  if (!shop || !code) {
    return res.status(400).json({ error: 'Missing shop or code in callback.' });
  }

  if (!validateState(state, shop)) {
    return res.status(400).json({ error: 'Invalid or missing state parameter.' });
  }

  if (!verifyCallbackHmac(req.query as Record<string, string>)) {
    return res.status(400).json({ error: 'Failed HMAC validation.' });
  }

  try {
    await exchangeToken(shop, code);
    res.json({ success: true, shop, scopes: SHOPIFY_SCOPES });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ error: message });
  }
});

app.get('/products', async (req: Request, res: Response) => {
  const shop = req.query.shop as string | undefined;
  if (!shop) {
    return res.status(400).json({ error: 'Missing shop parameter.' });
  }

  if (!getSession(shop)) {
    return res.status(401).json({ error: 'No session for this shop. Complete OAuth first.' });
  }

  try {
    const products = await fetchProducts(shop);
    res.json({ count: products.length, products });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ error: message });
  }
});

app.listen(port, () => {
  console.log(`Shopify public app running at http://localhost:${port}`);
});
