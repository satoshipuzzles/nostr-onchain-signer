/**
 * Robust Nostr event publishing via nostr-tools SimplePool.
 * Falls back to server-side relay proxy when browser WebSockets fail.
 */

import { SimplePool } from 'nostr-tools/pool';
import type { SignedEvent } from './events';
import { getWriteRelays, loadRelayList } from './relays';

// Checked 2026-10-19: relay.nostr.bg no longer resolves, relay.nostr.band is down and
// nostr.wine refuses non-members (403), so they are gone. Never relay.primal.net.
export const FALLBACK_WRITE_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.ditto.pub',
  'wss://relay.snort.social',
  'wss://offchain.pub',
  'wss://nostr.bitcoiner.social',
  'wss://nostr-pub.wellorder.net',
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

export interface PublishOptions {
  /** Resolve as soon as this many relays have accepted the event (the rest keep going). */
  resolveAfter?: number;
  /** Called once every relay has answered or timed out, with the final tally. */
  onSettled?: (result: PublishResult) => void;
  /** Publish to these relays instead of the user's write relays. */
  relays?: string[];
}

export async function publishEvent(event: SignedEvent, opts: PublishOptions = {}): Promise<PublishResult> {
  const targets = opts.relays?.length ? opts.relays : await getPublishRelays();
  const p = getPool();

  const success: string[] = [];
  const failed: string[] = [];
  const pubs = p.publish(targets, event, { maxWait: 12_000 });

  // Each relay reports on its own. With resolveAfter, the caller hears back as soon as the
  // event is out (usually a few hundred ms) instead of waiting on the slowest or deadest relay.
  await new Promise<void>((resolve) => {
    let answered = 0;
    let resolved = false;
    const settleOne = () => {
      answered++;
      if (!resolved && opts.resolveAfter && success.length >= opts.resolveAfter) { resolved = true; resolve(); }
      if (answered === targets.length) {
        if (!resolved) { resolved = true; resolve(); }
        // with no relay at all, the server fallback below reports instead
        if (success.length) opts.onSettled?.({ success: [...success], failed: [...failed] });
      }
    };
    pubs.forEach((pr, i) => {
      pr.then(
        (v) => { (isPublishSuccess(v) ? success : failed).push(targets[i]); settleOne(); },
        () => { failed.push(targets[i]); settleOne(); },
      );
    });
    if (!targets.length) resolve();
  });

  if (success.length === 0) {
    const serverResult = await publishViaServer(event, targets);
    opts.onSettled?.(serverResult);
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
