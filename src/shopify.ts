import 'dotenv/config';
import crypto from 'crypto';
import { URLSearchParams } from 'url';

type StateNonce = string;

export interface ShopSession {
  accessToken: string;
  scope: string;
}

const stateStore = new Map<StateNonce, string>();
const sessionStore = new Map<string, ShopSession>();

export const SHOPIFY_SCOPES = (process.env.SHOPIFY_SCOPES ?? 'read_products').split(',');
const apiKey = process.env.SHOPIFY_API_KEY;
const apiSecret = process.env.SHOPIFY_API_SECRET;
const appUrl = process.env.APP_URL;

if (!apiKey || !apiSecret || !appUrl) {
  throw new Error('SHOPIFY_API_KEY, SHOPIFY_API_SECRET, and APP_URL must be defined in environment variables.');
}

export function buildAuthUrl(shopDomain: string): { url: string; state: StateNonce } {
  const state = crypto.randomBytes(16).toString('hex');
  stateStore.set(state, shopDomain);

  const params = new URLSearchParams({
    client_id: apiKey,
    scope: SHOPIFY_SCOPES.join(','),
    redirect_uri: `${appUrl}/auth/callback`,
    state,
  });

  return {
    url: `https://${shopDomain}/admin/oauth/authorize?${params.toString()}`,
    state,
  };
}

export function verifyCallbackHmac(query: Record<string, string | string[]>): boolean {
  if (!apiSecret) return false;
  const queryParams = { ...query } as Record<string, string>;
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

  const response = await fetch(`https://${shopDomain}/admin/oauth/access_token`, {
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
  sessionStore.set(shopDomain, session);
  return session;
}

export function validateState(state: string | undefined, shopDomain: string): boolean {
  if (!state) return false;
  const match = stateStore.get(state);
  stateStore.delete(state);
  return match === shopDomain;
}

export function getSession(shopDomain: string): ShopSession | undefined {
  return sessionStore.get(shopDomain);
}

export async function fetchProducts(shopDomain: string): Promise<Array<{ id: number; title: string; images: Array<{ src: string; alt: string | null }> }>> {
  const session = getSession(shopDomain);
  if (!session) {
    throw new Error(`No session found for ${shopDomain}. Start OAuth first.`);
  }

  const products: Array<{ id: number; title: string; images: Array<{ src: string; alt: string | null }> }> = [];
  let pageInfo: string | undefined;

  while (true) {
    const url = new URL(`https://${shopDomain}/admin/api/2024-04/products.json`);
    url.searchParams.set('fields', 'id,title,images');
    url.searchParams.set('limit', '250');
    if (pageInfo) {
      url.searchParams.set('page_info', pageInfo);
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
      links?: { next?: { url: string } };
    };

    body.products.forEach((product) => {
      products.push({
        id: product.id,
        title: product.title,
        images: (product.images ?? []).map((img) => ({ src: img.src, alt: img.alt ?? null })),
      });
    });

    const linkHeader = response.headers.get('link');
    const hasNext = linkHeader?.includes('rel="next"');

    if (hasNext && linkHeader) {
      const match = /<([^>]+)>; rel="next"/.exec(linkHeader);
      if (match) {
        const nextUrl = new URL(match[1]);
        pageInfo = nextUrl.searchParams.get('page_info') ?? undefined;
        if (pageInfo) continue;
      }
    }

    break;
  }

  return products;
}
