import 'dotenv/config';
import crypto from 'crypto';
import { URLSearchParams } from 'url';

type StateNonce = string;

export interface ShopSession {
  accessToken: string;
  scope: string;
}

export interface ProductImage {
  src: string;
  alt: string | null;
}

export interface Product {
  id: number;
  title: string;
  images: ProductImage[];
}

export interface ProductPage {
  products: Product[];
  nextPageInfo?: string;
}

interface StateEntry {
  shopDomain: string;
  createdAt: number;
}

const stateStore = new Map<StateNonce, StateEntry>();
const sessionStore = new Map<string, ShopSession>();

export const SHOPIFY_SCOPES = (process.env.SHOPIFY_SCOPES ?? 'read_products')
  .split(',')
  .map((scope) => scope.trim())
  .filter(Boolean);
const stateTtlMs = Number(process.env.STATE_TTL_MS ?? 5 * 60 * 1000);
const apiKey = process.env.SHOPIFY_API_KEY;
const apiSecret = process.env.SHOPIFY_API_SECRET;
const appUrl = process.env.APP_URL;

if (!apiKey || !apiSecret || !appUrl) {
  throw new Error('SHOPIFY_API_KEY, SHOPIFY_API_SECRET, and APP_URL must be defined in environment variables.');
}

export function sanitizeShopDomain(shopDomain: string): string {
  const trimmed = shopDomain.trim();
  const match = trimmed.match(/^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/);
  if (!match) {
    throw new Error('Invalid shop domain. Expected format: example.myshopify.com');
  }
  return trimmed;
}

export function buildAuthUrl(shopDomain: string): { url: string; state: StateNonce } {
  const validatedShop = sanitizeShopDomain(shopDomain);
  const state = crypto.randomBytes(16).toString('hex');
  stateStore.set(state, { shopDomain: validatedShop, createdAt: Date.now() });

  const params = new URLSearchParams({
    client_id: apiKey,
    scope: SHOPIFY_SCOPES.join(','),
    redirect_uri: `${appUrl}/auth/callback`,
    state,
  });

  return {
    url: `https://${validatedShop}/admin/oauth/authorize?${params.toString()}`,
    state,
  };
}

export function verifyCallbackHmac(query: Record<string, string | string[]>): boolean {
  if (!apiSecret) return false;
  const queryParams: Record<string, string> = {};
  Object.entries(query).forEach(([key, value]) => {
    if (key === 'signature') return; // Not used for HMAC calculation
    queryParams[key] = Array.isArray(value) ? value.join(',') : value;
  });
  const receivedHmac = queryParams.hmac;
  delete queryParams.hmac;

  const sortedParams = new URLSearchParams();
  Object.keys(queryParams)
    .sort()
    .forEach((key) => {
      sortedParams.append(key, queryParams[key]);
    });

  const message = sortedParams.toString();
  const computedHmac = crypto.createHmac('sha256', apiSecret).update(message).digest('hex');

  return computedHmac === receivedHmac;
}

export async function exchangeToken(shopDomain: string, code: string): Promise<ShopSession> {
  if (!apiSecret || !apiKey) {
    throw new Error('Missing API credentials.');
  }

  const validatedShop = sanitizeShopDomain(shopDomain);

  const response = await fetch(`https://${validatedShop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      client_id: apiKey,
      client_secret: apiSecret,
      code,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to exchange token: ${response.status} ${errorText}`);
  }

  const body = (await response.json()) as { access_token: string; scope: string };
  const session: ShopSession = { accessToken: body.access_token, scope: body.scope };
  sessionStore.set(validatedShop, session);
  return session;
}

export function validateState(state: string | undefined, shopDomain: string): boolean {
  if (!state) return false;
  const match = stateStore.get(state);
  stateStore.delete(state);
  if (!match) return false;
  const expired = Date.now() - match.createdAt > stateTtlMs;
  if (expired) return false;
  return match.shopDomain === shopDomain;
}

export function getSession(shopDomain: string): ShopSession | undefined {
  return sessionStore.get(sanitizeShopDomain(shopDomain));
}

export async function fetchProductsPage(
  shopDomain: string,
  options: { pageInfo?: string; limit?: number } = {},
): Promise<ProductPage> {
  const session = getSession(shopDomain);
  if (!session) {
    throw new Error(`No session found for ${shopDomain}. Start OAuth first.`);
  }

  const validatedShop = sanitizeShopDomain(shopDomain);
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 250);
  const url = new URL(`https://${validatedShop}/admin/api/2024-04/products.json`);
  url.searchParams.set('fields', 'id,title,images');
  url.searchParams.set('limit', limit.toString());
  if (options.pageInfo) {
    url.searchParams.set('page_info', options.pageInfo);
  }

  const response = await fetch(url, {
    headers: {
      'X-Shopify-Access-Token': session.accessToken,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to fetch products: ${response.status} ${errorText}`);
  }

  const body = (await response.json()) as {
    products: Array<{ id: number; title: string; images?: Array<{ src: string; alt?: string | null }> }>;
  };

  const products: Product[] = body.products.map((product) => ({
    id: product.id,
    title: product.title,
    images: (product.images ?? []).map((img) => ({ src: img.src, alt: img.alt ?? null })),
  }));

  const linkHeader = response.headers.get('link');
  const nextPageInfo = parseNextPageInfo(linkHeader);

  return { products, nextPageInfo };
}

export async function fetchProducts(shopDomain: string): Promise<Product[]> {
  const aggregated: Product[] = [];
  let pageInfo: string | undefined;

  do {
    const { products, nextPageInfo } = await fetchProductsPage(shopDomain, { pageInfo });
    aggregated.push(...products);
    pageInfo = nextPageInfo;
  } while (pageInfo);

  return aggregated;
}

function parseNextPageInfo(linkHeader: string | null): string | undefined {
  if (!linkHeader) return undefined;
  const match = /<([^>]+)>; rel="next"/.exec(linkHeader);
  if (!match) return undefined;
  const nextUrl = new URL(match[1]);
  return nextUrl.searchParams.get('page_info') ?? undefined;
}
