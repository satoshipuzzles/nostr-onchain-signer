/**
 * One shared read pool for the whole app, and patient reconnects.
 *
 * Two things this fixes:
 *
 *  - Feeds and queries each had their own SimplePool, so every page load opened two
 *    sockets to each relay. Busy relays count handshakes per address; one socket per
 *    relay is both kinder and more likely to be let in.
 *
 *  - A relay that turns a handshake away (relay.damus.io answered most upgrades with
 *    503 in 2026-11 while its NIP-11 document loaded fine) was only tried again by the
 *    next query, so it stayed dark for whole sessions. keepWarm() retries in the
 *    background with a growing, jittered delay; once a socket opens it is kept, and
 *    every later query uses it.
 */
import { SimplePool } from 'nostr-tools/pool';

let pool: SimplePool | null = null;

export function sharedPool(): SimplePool {
  if (!pool) pool = new SimplePool({ enableReconnect: true });
  return pool;
}

const norm = (u: string) => u.trim().replace(/\/+$/, '').toLowerCase();

export function isRelayConnected(url: string): boolean {
  const want = norm(url);
  try {
    for (const [k, ok] of sharedPool().listConnectionStatus()) if (ok && norm(k) === want) return true;
  } catch { /* no pool yet */ }
  return false;
}

// six tries over about a minute and a half; the next query starts a new round if still down
const DELAYS = [1500, 3000, 6000, 12000, 25000, 45000];
const warming = new Set<string>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function warm(url: string) {
  for (const base of DELAYS) {
    await sleep(base * (0.75 + Math.random() * 0.5));
    if (isRelayConnected(url)) break;
    if (typeof document !== 'undefined' && document.hidden) break; // not while the tab is in the background
    try {
      await sharedPool().ensureRelay(url, { connectionTimeout: 6000 });
      break;
    } catch { /* refused or timed out: wait longer and try again */ }
  }
  warming.delete(url);
}

/** Keep trying to open these relays in the background. Safe to call on every query. */
export function keepWarm(urls: string[]) {
  for (const raw of urls) {
    if (!/^wss:\/\//i.test(raw)) continue;
    const url = norm(raw);
    if (warming.has(url) || isRelayConnected(url)) continue;
    warming.add(url);
    void warm(url);
  }
}

// For diagnosing from the browser console: __nostrRelays() -> { url: connected }
try {
  (globalThis as unknown as { __nostrRelays?: () => Record<string, boolean> }).__nostrRelays =
    () => Object.fromEntries(sharedPool().listConnectionStatus());
} catch { /* no global */ }
