/**
 * Per-origin permissions for NIP-07 / Bitcoin provider requests.
 *
 * The content script runs on <all_urls>, so ANY web page can reach the
 * background. Without a permission gate, a site could silently call
 * getPublicKey (deanonymize the user) or nip04/nip44 decrypt (use the key as a
 * decryption oracle against the user's DMs). This module makes every sensitive
 * method require an explicit, per-origin grant — mirroring how Alby / nos2x
 * gate access — backed by the same `connected_apps` store the Connected Apps
 * settings screen already manages.
 */

const STORAGE_KEY = 'connected_apps';

export type AppPermission = 'always' | 'ask' | 'deny';

export interface ConnectedApp {
  origin: string;
  name?: string;
  firstUsed: number;
  lastUsed: number;
  signCount: number;
  permission: AppPermission;
  allowedKinds?: number[];
}

/**
 * Methods that expose the user's key or identity and therefore require a
 * per-origin grant. getRelays and btc:getMultisigAddress are intentionally
 * excluded: the former is public relay metadata, the latter only derives an
 * address from pubkeys the page already supplied (no key/identity use).
 */
export const SENSITIVE_TYPES = new Set<string>([
  'nip07:getPublicKey',
  'nip07:signEvent',
  'nip07:signSchnorr',
  'nip07:nip04:encrypt',
  'nip07:nip04:decrypt',
  'nip07:nip44:encrypt',
  'nip07:nip44:decrypt',
  'btc:getAddress',
  'btc:signPsbt',
  'btc:signPsbtPartial',
]);

export type PermissionDecision = 'skip' | 'allow' | 'ask' | 'deny';

const OWN_APP_HOSTS = [
  'nostr-onchain-signer.vercel.app',
  'nostrfreaks.com',
  'www.nostrfreaks.com',
  'localhost',
  '127.0.0.1',
];

export function isOwnAppUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return OWN_APP_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

/** Stable per-site key: scheme://host(:port). */
export function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

async function loadApps(): Promise<ConnectedApp[]> {
  try {
    const result = await chrome.storage.local.get(STORAGE_KEY);
    const list = result[STORAGE_KEY];
    return Array.isArray(list) ? (list as ConnectedApp[]) : [];
  } catch {
    return [];
  }
}

async function saveApps(list: ConnectedApp[]): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: list });
}

export async function getApp(origin: string): Promise<ConnectedApp | undefined> {
  const list = await loadApps();
  return list.find((a) => a.origin === origin);
}

/** Create the record (as 'ask') if it doesn't exist yet, so the site shows up
 *  in Connected Apps even before the user makes a decision. */
export async function ensureApp(origin: string, name?: string): Promise<ConnectedApp> {
  const list = await loadApps();
  let app = list.find((a) => a.origin === origin);
  if (!app) {
    app = {
      origin,
      name: name || hostOf(origin),
      firstUsed: Date.now(),
      lastUsed: Date.now(),
      signCount: 0,
      permission: 'ask',
    };
    list.push(app);
    await saveApps(list);
  }
  return app;
}

export async function recordAppUsage(
  origin: string,
  opts: { name?: string; incrementSign?: boolean } = {},
): Promise<void> {
  const list = await loadApps();
  const app = list.find((a) => a.origin === origin);
  if (app) {
    app.lastUsed = Date.now();
    if (opts.incrementSign) app.signCount += 1;
    if (opts.name && !app.name) app.name = opts.name;
  } else {
    list.push({
      origin,
      name: opts.name || hostOf(origin),
      firstUsed: Date.now(),
      lastUsed: Date.now(),
      signCount: opts.incrementSign ? 1 : 0,
      permission: 'ask',
    });
  }
  await saveApps(list);
}

export async function setOriginPermission(origin: string, permission: AppPermission): Promise<void> {
  const list = await loadApps();
  const app = list.find((a) => a.origin === origin);
  if (app) {
    app.permission = permission;
    app.lastUsed = Date.now();
  } else {
    list.push({
      origin,
      name: hostOf(origin),
      firstUsed: Date.now(),
      lastUsed: Date.now(),
      signCount: 0,
      permission,
    });
  }
  await saveApps(list);
}

/**
 * Decide how to handle a request from a web page:
 *  - 'skip'  : not sensitive, or from our own app / extension — allow silently
 *  - 'allow' : origin has an 'always' grant
 *  - 'deny'  : origin is blocked
 *  - 'ask'   : needs an approval prompt
 */
export async function evaluateRequest(
  type: string,
  url: string | undefined,
): Promise<PermissionDecision> {
  if (!SENSITIVE_TYPES.has(type)) return 'skip';
  if (!url) return 'ask';
  const extPrefix = chrome.runtime.getURL('');
  if (url.startsWith(extPrefix)) return 'skip';
  if (isOwnAppUrl(url)) return 'skip';

  const origin = originOf(url);
  if (!origin) return 'ask';

  const app = await getApp(origin);
  if (!app) return 'ask';
  if (app.permission === 'deny') return 'deny';
  if (app.permission === 'always') return 'allow';
  return 'ask';
}
