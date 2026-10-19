/**
 * Shared relay subscription helpers via nostr-tools SimplePool.
 */

import { SimplePool } from 'nostr-tools/pool';
import type { Filter } from 'nostr-tools/filter';
import { cloudQuery } from './query';

/** Kinds the server-side reader accepts (api/nostr-query); others are left to the browser. */
const CLOUD_OK = new Set([0, 1, 3, 6, 7, 1111, 9735, 10002]);

// relay.nostr.band went dark in 2026-10; relay.ditto.pub and offchain.pub answer fast.
// purplepag.es only keeps profiles and relay lists, so it is not a note source.
export const DEFAULT_READ_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.ditto.pub',
  'wss://relay.snort.social',
  'wss://nostr-pub.wellorder.net',
  'wss://offchain.pub',
];

interface RelaySubOptions {
  relayUrls: string[];
  filter: Filter;
  onEvent: (event: Record<string, unknown>) => void;
  onEose?: () => void;
  maxWait?: number;
}

let readPool: SimplePool | null = null;

function getReadPool(): SimplePool {
  if (!readPool) readPool = new SimplePool();
  return readPool;
}

export function subscribeRelays(options: RelaySubOptions): () => void {
  const { relayUrls, filter, onEvent, onEose, maxWait = 8_000 } = options;

  if (relayUrls.length === 0) {
    onEose?.();
    return () => {};
  }

  // Some networks block some relays outright (nos.lol from some home ISPs). The server reads
  // the same relays in parallel and its events merge in; callers dedupe by id.
  let closed = false;
  const cloudKinds = (filter.kinds ?? []).filter((k) => CLOUD_OK.has(k));
  if (cloudKinds.length) {
    cloudQuery(relayUrls, [{ ...filter, kinds: cloudKinds }], Math.min(maxWait, 8000))
      .then((evs) => { if (!closed) for (const e of evs) onEvent(e as unknown as Record<string, unknown>); })
      .catch(() => {});
  }

  const closer = getReadPool().subscribeManyEose(
    relayUrls,
    filter,
    {
      onevent(event) {
        onEvent(event as unknown as Record<string, unknown>);
      },
      onclose() {
        onEose?.();
      },
      maxWait,
    },
  );

  return () => { closed = true; closer.close(); };
}

/** Which read relays currently hold an open socket (url -> connected). */
export function relayConnectionStatus(): Map<string, boolean> {
  try {
    return getReadPool().listConnectionStatus();
  } catch {
    return new Map();
  }
}
