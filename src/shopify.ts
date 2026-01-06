import 'dotenv/config';
import crypto from 'crypto';
import { URLSearchParams } from 'url';

import { consumeState, loadSession, recordWebhook, saveSession, saveState } from './storage';

type StateNonce = string;

export interface ShopSession {
  accessToken: string;
  scope: string;
  shopDomain: string;
  createdAt: number;
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

export const SHOPIFY_SCOPES = (process.env.SHOPIFY_SCOPES ?? 'read_products')
  .split(',')
  .map((scope) => scope.trim())
  .filter(Boolean);
const stateTtlMs = Number(process.env.STATE_TTL_MS ?? 5 * 60 * 1000);
const accessMode = process.env.SHOPIFY_ACCESS_MODE === 'per-user' ? 'per-user' : 'offline';
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

export async function buildAuthUrl(shopDomain: string): Promise<{ url: string; state: StateNonce }> {
  const validatedShop = sanitizeShopDomain(shopDomain);
  const state = crypto.randomBytes(16).toString('hex');
  await saveState({ nonce: state, shopDomain: validatedShop, createdAt: Date.now() });

  const params = new URLSearchParams({
    client_id: apiKey ?? '',
    scope: SHOPIFY_SCOPES.join(','),
    redirect_uri: `${appUrl}/auth/callback`,
    state,
  });

  if (accessMode === 'per-user') {
    params.append('grant_options[]', 'per-user');
  }

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

  const response = await shopifyRequest(`https://${validatedShop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      client_id: apiKey,
      client_secret: apiSecret,
      code,
    }),
    retryOnThrottle: false,
  });

  const body = (await response.json()) as { access_token: string; scope: string };
  const session: ShopSession = {
    accessToken: body.access_token,
    scope: body.scope,
    shopDomain: validatedShop,
    createdAt: Date.now(),
  };
  await saveSession(session);
  return session;
}

export async function validateState(state: string | undefined, shopDomain: string): Promise<boolean> {
  if (!state) return false;
  const match = await consumeState(state);
  if (!match) return false;
  const expired = Date.now() - match.createdAt > stateTtlMs;
  if (expired) return false;
  return match.shopDomain === shopDomain;
}

export async function getSession(shopDomain: string): Promise<ShopSession | undefined> {
  return loadSession(sanitizeShopDomain(shopDomain));
}

export async function fetchProductsPage(
  shopDomain: string,
  options: { pageInfo?: string; limit?: number } = {},
): Promise<ProductPage> {
  const session = await getSession(shopDomain);
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

  const response = await shopifyRequest(url.toString(), {
    headers: {
      'X-Shopify-Access-Token': session.accessToken,
      'Content-Type': 'application/json',
    },
  });

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

interface ShopifyRequestOptions extends RequestInit {
  retryOnThrottle?: boolean;
}

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 500;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function computeBackoff(attempt: number): number {
  const jitter = Math.random() * 100;
  return BASE_DELAY_MS * Math.pow(2, attempt) + jitter;
}

function shouldRetry(response: Response): boolean {
  return response.status === 429 || (response.status >= 500 && response.status < 600);
}

function throttleDelayFromHeaders(response: Response): number | undefined {
  const limitHeader = response.headers.get('x-shopify-shop-api-call-limit');
  if (!limitHeader) return undefined;
  const [used, bucket] = limitHeader.split('/').map((part) => Number(part));
  if (!Number.isFinite(used) || !Number.isFinite(bucket) || bucket === 0) return undefined;
  const utilization = used / bucket;
  if (utilization < 0.8) return undefined;
  return BASE_DELAY_MS + (utilization - 0.8) * 1000;
}

async function shopifyRequest(url: string, options: ShopifyRequestOptions = {}, attempt = 0): Promise<Response> {
  const response = await fetch(url, options);

  if (response.ok) {
    return response;
  }

  const throttleDelay = throttleDelayFromHeaders(response);
  const allowRetry = options.retryOnThrottle !== false;
  const shouldThrottleRetry = allowRetry && shouldRetry(response) && attempt < MAX_RETRIES;

  if (shouldThrottleRetry) {
    const backoff = computeBackoff(attempt) + (throttleDelay ?? 0);
    await delay(backoff);
    return shopifyRequest(url, options, attempt + 1);
  }

  const errorText = await response.text();
  throw new Error(`Shopify request failed: ${response.status} ${errorText}`);
}

export function verifyWebhookHmac(rawBody: Buffer, hmacHeader: string | undefined): boolean {
  if (!apiSecret || !hmacHeader) return false;
  const digest = crypto.createHmac('sha256', apiSecret).update(rawBody).digest('base64');
  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmacHeader));
}

export async function registerProductWebhooks(shopDomain: string, accessToken: string): Promise<void> {
  const validatedShop = sanitizeShopDomain(shopDomain);
  const topics = ['products/create', 'products/update', 'products/delete'];

  for (const topic of topics) {
    await shopifyRequest(`https://${validatedShop}/admin/api/2024-04/webhooks.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': accessToken,
      },
      body: JSON.stringify({
        webhook: {
          topic,
          address: `${appUrl}/webhooks/products`,
          format: 'json',
        },
      }),
    });
  }
}

export async function recordProductWebhook(
  shopDomain: string,
  topic: string,
  payload: unknown,
): Promise<void> {
  const productId = typeof payload === 'object' && payload && 'id' in (payload as Record<string, unknown>)
    ? Number((payload as Record<string, unknown>).id)
    : Date.now();

  await recordWebhook({
    id: productId,
    shopDomain,
    topic,
    payload,
    receivedAt: Date.now(),
  });
}
