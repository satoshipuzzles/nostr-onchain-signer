/**
 * Shared relay subscription helpers via nostr-tools SimplePool.
 */

import { SimplePool } from 'nostr-tools/pool';
import type { Filter } from 'nostr-tools/filter';

export const DEFAULT_READ_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.snort.social',
  'wss://nostr-pub.wellorder.net',
  'wss://relay.nostr.band',
  'wss://purplepag.es',
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
  const { relayUrls, filter, onEvent, onEose, maxWait = 12_000 } = options;

  if (relayUrls.length === 0) {
    onEose?.();
    return () => {};
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

  return () => closer.close();
}
