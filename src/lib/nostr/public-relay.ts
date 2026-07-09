/**
 * Shared relay helpers for public pages (unlock, sign) that run outside the extension.
 */

import { SimplePool } from 'nostr-tools/pool';
import type { Filter } from 'nostr-tools/filter';
import type { Event } from 'nostr-tools';
import { loadRelayList, getReadRelays, getWriteRelays } from './relays';
import { FALLBACK_WRITE_RELAYS } from './publish';

export const PUBLIC_READ_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.snort.social',
  'wss://relay.nostr.band',
  'wss://purplepag.es',
  'wss://nostr-pub.wellorder.net',
  'wss://relay.nostr.bg',
  'wss://nostr.wine',
];

let pool: SimplePool | null = null;

function getPool(): SimplePool {
  if (!pool) pool = new SimplePool();
  return pool;
}

export function appOrigin(): string {
  if (typeof window !== 'undefined' && window.location?.origin) {
    return window.location.origin;
  }
  return 'https://nostr-onchain-signer.vercel.app';
}

export async function getPublicReadRelays(): Promise<string[]> {
  try {
    const list = await loadRelayList();
    const configured = getReadRelays(list);
    return [...new Set([...configured, ...PUBLIC_READ_RELAYS])].slice(0, 10);
  } catch {
    return PUBLIC_READ_RELAYS.slice(0, 8);
  }
}

export async function getPublicWriteRelays(): Promise<string[]> {
  try {
    const list = await loadRelayList();
    const configured = getWriteRelays(list);
    return [...new Set([...configured, ...FALLBACK_WRITE_RELAYS])].slice(0, 10);
  } catch {
    return FALLBACK_WRITE_RELAYS.slice(0, 8);
  }
}

export async function queryPublicEvents(filter: Filter, maxWait = 15_000): Promise<Event[]> {
  const relays = await getPublicReadRelays();
  return getPool().querySync(relays, filter, { maxWait });
}

function isPublishOk(value: unknown): boolean {
  return typeof value === 'string'
    && !value.startsWith('connection failure')
    && value !== 'duplicate url'
    && !value.startsWith('connection skipped');
}

export async function publishPublicEvent(event: Event): Promise<{ ok: boolean; error?: string }> {
  const relays = await getPublicWriteRelays();
  const attempts = await Promise.allSettled(
    getPool().publish(relays, event, { maxWait: 12_000 }),
  );

  const anySuccess = attempts.some(
    (r) => r.status === 'fulfilled' && isPublishOk(r.value),
  );

  if (anySuccess) return { ok: true };

  try {
    const res = await fetch('/api/nostr-publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event, relays: relays.slice(0, 6) }),
    });
    if (res.ok) {
      const data = await res.json() as { success?: string[] };
      if ((data.success?.length ?? 0) > 0) return { ok: true };
    }
  } catch { /* fall through */ }

  return { ok: false, error: 'Could not reach any relay. Try again or check relay settings.' };
}
