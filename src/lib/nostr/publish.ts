/**
 * Robust Nostr event publishing via nostr-tools SimplePool.
 * Falls back to server-side relay proxy when browser WebSockets fail.
 */

import { SimplePool } from 'nostr-tools/pool';
import type { SignedEvent } from './events';
import { getWriteRelays, loadRelayList } from './relays';

export const FALLBACK_WRITE_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.snort.social',
  'wss://nostr-pub.wellorder.net',
  'wss://relay.nostr.bg',
  'wss://relay.nostr.band',
  'wss://nostr.wine',
  'wss://purplepag.es',
];

export interface PublishResult {
  success: string[];
  failed: string[];
}

let pool: SimplePool | null = null;

function getPool(): SimplePool {
  if (!pool) {
    pool = new SimplePool();
  }
  return pool;
}

function isPublishSuccess(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  if (value.startsWith('connection failure')) return false;
  if (value === 'duplicate url') return false;
  if (value.startsWith('connection skipped')) return false;
  return true;
}

async function publishViaServer(event: SignedEvent, relays: string[]): Promise<PublishResult> {
  try {
    const res = await fetch('/api/nostr-publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event, relays: relays.slice(0, 6) }),
    });
    if (!res.ok) return { success: [], failed: relays };
    const data = await res.json() as { success?: string[]; failed?: string[] };
    return {
      success: data.success ?? [],
      failed: data.failed ?? [],
    };
  } catch {
    return { success: [], failed: relays };
  }
}

export async function getPublishRelays(): Promise<string[]> {
  const relayList = await loadRelayList();
  const configured = getWriteRelays(relayList);
  const merged = [...new Set([...configured, ...FALLBACK_WRITE_RELAYS])];
  return merged.slice(0, 10);
}

export async function publishEvent(event: SignedEvent): Promise<PublishResult> {
  const targets = await getPublishRelays();
  const p = getPool();

  const attempts = await Promise.allSettled(
    p.publish(targets, event, { maxWait: 12_000 }),
  );

  const success: string[] = [];
  const failed: string[] = [];

  attempts.forEach((result, i) => {
    const relay = targets[i];
    if (result.status === 'fulfilled' && isPublishSuccess(result.value)) {
      success.push(relay);
    } else {
      failed.push(relay);
    }
  });

  if (success.length === 0) {
    const serverResult = await publishViaServer(event, targets);
    if (serverResult.success.length > 0) {
      return {
        success: serverResult.success,
        failed: [...new Set([...failed, ...serverResult.failed])],
      };
    }
  }

  return { success, failed };
}

export function formatPublishResult(result: PublishResult): string {
  if (result.success.length === 0) {
    return 'Could not reach any relay. Event signed but not broadcast.';
  }
  if (result.failed.length > 0) {
    return `Published to ${result.success.length} relay${result.success.length > 1 ? 's' : ''}, ${result.failed.length} failed`;
  }
  return `Published to ${result.success.length} relay${result.success.length > 1 ? 's' : ''}`;
}
