import fs from 'fs/promises';
import path from 'path';

export interface StoredSession {
  accessToken: string;
  scope: string;
  shopDomain: string;
  createdAt: number;
}

export interface StoredState {
  nonce: string;
  shopDomain: string;
  createdAt: number;
}

export interface ProductWebhookEvent {
  id: number;
  shopDomain: string;
  topic: string;
  payload: unknown;
  receivedAt: number;
}

const dataDir = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const sessionFile = path.join(dataDir, 'sessions.json');
const stateFile = path.join(dataDir, 'states.json');
const webhookFile = path.join(dataDir, 'product_webhooks.json');

const sessions = new Map<string, StoredSession>();
const states = new Map<string, StoredState>();
const webhookEvents: ProductWebhookEvent[] = [];

let initialized = false;
let initPromise: Promise<void> | null = null;

async function ensureInitialized(): Promise<void> {
  if (initialized) return;
  if (!initPromise) {
    initPromise = initialize();
  }
  await initPromise;
  initialized = true;
}

async function initialize(): Promise<void> {
  await fs.mkdir(dataDir, { recursive: true });
  await restoreSessions();
  await restoreStates();
  await restoreWebhooks();
}

async function restoreSessions(): Promise<void> {
  try {
    const raw = await fs.readFile(sessionFile, 'utf-8');
    const parsed: StoredSession[] = JSON.parse(raw);
    parsed.forEach((session) => sessions.set(session.shopDomain, session));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

async function restoreStates(): Promise<void> {
  try {
    const raw = await fs.readFile(stateFile, 'utf-8');
    const parsed: StoredState[] = JSON.parse(raw);
    parsed.forEach((state) => states.set(state.nonce, state));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

async function restoreWebhooks(): Promise<void> {
  try {
    const raw = await fs.readFile(webhookFile, 'utf-8');
    const parsed: ProductWebhookEvent[] = JSON.parse(raw);
    webhookEvents.push(...parsed);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

async function persistSessions(): Promise<void> {
  const payload = Array.from(sessions.values());
  await fs.writeFile(sessionFile, JSON.stringify(payload, null, 2));
}

async function persistStates(): Promise<void> {
  const payload = Array.from(states.values());
  await fs.writeFile(stateFile, JSON.stringify(payload, null, 2));
}

async function persistWebhooks(): Promise<void> {
  await fs.writeFile(webhookFile, JSON.stringify(webhookEvents, null, 2));
}

export async function saveSession(session: StoredSession): Promise<void> {
  await ensureInitialized();
  sessions.set(session.shopDomain, session);
  await persistSessions();
}

export async function loadSession(shopDomain: string): Promise<StoredSession | undefined> {
  await ensureInitialized();
  return sessions.get(shopDomain);
}

export async function saveState(state: StoredState): Promise<void> {
  await ensureInitialized();
  states.set(state.nonce, state);
  await persistStates();
}

export async function consumeState(nonce: string): Promise<StoredState | undefined> {
  await ensureInitialized();
  const entry = states.get(nonce);
  if (entry) {
    states.delete(nonce);
    await persistStates();
  }
  return entry;
}

export async function recordWebhook(event: ProductWebhookEvent): Promise<void> {
  await ensureInitialized();
  webhookEvents.push(event);
  await persistWebhooks();
}

export async function listWebhooks(): Promise<ProductWebhookEvent[]> {
  await ensureInitialized();
  return [...webhookEvents].sort((a, b) => b.receivedAt - a.receivedAt);
}
