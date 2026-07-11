/**
 * NIP-17 DM relay handling (kind 10050 DM inbox relay lists).
 *
 * Amethyst and other NIP-17 clients ONLY read gift-wrapped DMs from the
 * relays listed in the recipient's kind 10050 event. To interoperate we must:
 *  1. Look up the recipient's 10050 list and publish gift wraps THERE
 *  2. Publish our own 10050 list so others know where to reach us
 *  3. Read gift wraps from our own 10050 relays
 */

import { SimplePool } from 'nostr-tools/pool';
import { getPublishRelays, FALLBACK_WRITE_RELAYS } from './publish';
import { signEventWithFallback } from './sign-event';

// Relays known to accept + serve kind 1059 gift wraps reliably
export const DEFAULT_DM_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://relay.0xchat.com',
];

const DISCOVERY_RELAYS = [
  'wss://purplepag.es',
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.nostr.band',
  'wss://relay.primal.net',
];

let pool: SimplePool | null = null;
function getPool(): SimplePool {
  if (!pool) pool = new SimplePool();
  return pool;
}

const dmRelayCache = new Map<string, { relays: string[]; fetchedAt: number }>();
const CACHE_TTL = 30 * 60 * 1000; // 30 min

/**
 * Fetch a user's DM inbox relays (kind 10050). Falls back to their
 * kind 10002 write relays, then to defaults known to carry gift wraps.
 */
export async function fetchDmInboxRelays(pubkey: string): Promise<string[]> {
  const cached = dmRelayCache.get(pubkey);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL) return cached.relays;

  const p = getPool();

  try {
    const dmList = await p.get(DISCOVERY_RELAYS, {
      kinds: [10050],
      authors: [pubkey],
    }, { maxWait: 5000 });

    if (dmList) {
      const relays = dmList.tags
        .filter((t) => t[0] === 'relay' && t[1]?.startsWith('ws'))
        .map((t) => t[1])
        .slice(0, 5);
      if (relays.length > 0) {
        dmRelayCache.set(pubkey, { relays, fetchedAt: Date.now() });
        return relays;
      }
    }
  } catch { /* fall through */ }

  // Fallback: their NIP-65 relay list (kind 10002) — read relays
  try {
    const relayList = await p.get(DISCOVERY_RELAYS, {
      kinds: [10002],
      authors: [pubkey],
    }, { maxWait: 5000 });

    if (relayList) {
      const relays = relayList.tags
        .filter((t) => t[0] === 'r' && t[1]?.startsWith('ws') && (t[2] === undefined || t[2] === 'read'))
        .map((t) => t[1])
        .slice(0, 5);
      if (relays.length > 0) {
        dmRelayCache.set(pubkey, { relays, fetchedAt: Date.now() });
        return relays;
      }
    }
  } catch { /* fall through */ }

  dmRelayCache.set(pubkey, { relays: DEFAULT_DM_RELAYS, fetchedAt: Date.now() });
  return DEFAULT_DM_RELAYS;
}

/**
 * Publish an event to an explicit set of relays (used for gift wraps that
 * must land on the recipient's DM inbox relays, not our write relays).
 */
export async function publishToRelays(
  event: Parameters<SimplePool['publish']>[1],
  relays: string[],
): Promise<{ success: string[]; failed: string[] }> {
  const targets = [...new Set(relays)].slice(0, 10);
  const p = getPool();

  const attempts = await Promise.allSettled(p.publish(targets, event, { maxWait: 10_000 }));
  const success: string[] = [];
  const failed: string[] = [];

  attempts.forEach((result, i) => {
    if (result.status === 'fulfilled') success.push(targets[i]);
    else failed.push(targets[i]);
  });

  // Server-side fallback if nothing succeeded (WebSocket-blocked environments)
  if (success.length === 0) {
    try {
      const res = await fetch('/api/nostr-publish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event, relays: targets.slice(0, 6) }),
      });
      if (res.ok) {
        const data = await res.json() as { success?: string[] };
        if (data.success?.length) return { success: data.success, failed };
      }
    } catch { /* ignore */ }
  }

  return { success, failed };
}

/**
 * Ensure our own kind 10050 DM relay list is published so other NIP-17
 * clients (Amethyst, 0xchat, etc.) know where to send us gift wraps.
 * Runs at most once per session.
 */
let ownListEnsured = false;
export async function ensureOwnDmRelayList(publicKey: string): Promise<void> {
  if (ownListEnsured) return;
  ownListEnsured = true;

  try {
    const p = getPool();
    const existing = await p.get(DISCOVERY_RELAYS, {
      kinds: [10050],
      authors: [publicKey],
    }, { maxWait: 5000 });
    if (existing) {
      // Cache own relays for reading
      const relays = existing.tags
        .filter((t) => t[0] === 'relay' && t[1]?.startsWith('ws'))
        .map((t) => t[1]);
      if (relays.length > 0) {
        dmRelayCache.set(publicKey, { relays, fetchedAt: Date.now() });
        return;
      }
    }

    // Publish a default DM relay list
    const event = {
      kind: 10050,
      content: '',
      tags: DEFAULT_DM_RELAYS.map((url) => ['relay', url]),
      created_at: Math.floor(Date.now() / 1000),
    };
    const signed = await signEventWithFallback(event, publicKey);
    const targets = [...new Set([...(await getPublishRelays()), ...DISCOVERY_RELAYS, ...FALLBACK_WRITE_RELAYS])];
    await publishToRelays(signed, targets);
    dmRelayCache.set(publicKey, { relays: DEFAULT_DM_RELAYS, fetchedAt: Date.now() });
  } catch {
    // Non-fatal — DMs still go to default relays
  }
}
