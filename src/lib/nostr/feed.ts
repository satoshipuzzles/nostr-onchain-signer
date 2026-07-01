/**
 * Nostr feed subscription manager.
 * Connects to relays via WebSocket and fetches notes by feed mode.
 */

import { CUSTOM_KIND } from './kinds';

export type FeedMode = 'global' | 'following' | 'media' | 'onchain' | 'hashtag' | 'kind';

export interface FeedNote {
  id: string;
  pubkey: string;
  content: string;
  created_at: number;
  tags: string[][];
  kind: number;
}

export interface FeedFilter {
  mode: FeedMode;
  pubkeys?: string[];
  hashtag?: string;
  kind?: number;
  limit?: number;
  until?: number;
}

interface RelayConnection {
  ws: WebSocket;
  url: string;
  subId: string;
}

const IMAGE_REGEX = /https?:\/\/\S+\.(jpg|jpeg|png|gif|webp)(\?\S*)?/i;

function buildNostrFilter(filter: FeedFilter): Record<string, unknown> {
  const limit = filter.limit ?? 50;
  const base: Record<string, unknown> = { limit };

  if (filter.until) {
    base.until = filter.until;
  }

  switch (filter.mode) {
    case 'global':
      return { ...base, kinds: [1] };

    case 'following':
      if (!filter.pubkeys || filter.pubkeys.length === 0) {
        return { ...base, kinds: [1] };
      }
      return { ...base, kinds: [1], authors: filter.pubkeys };

    case 'media':
      return { ...base, kinds: [1] };

    case 'onchain':
      return { ...base, kinds: [1, CUSTOM_KIND.ONCHAIN_INVOICE] };

    case 'hashtag':
      if (!filter.hashtag) {
        return { ...base, kinds: [1] };
      }
      return { ...base, kinds: [1], '#t': [filter.hashtag.toLowerCase().replace(/^#/, '')] };

    case 'kind':
      return { ...base, kinds: [filter.kind ?? 1] };

    default:
      return { ...base, kinds: [1] };
  }
}

function passesClientFilter(note: FeedNote, filter: FeedFilter): boolean {
  if (filter.mode === 'media') {
    return IMAGE_REGEX.test(note.content);
  }

  if (filter.mode === 'onchain') {
    if (note.kind === CUSTOM_KIND.ONCHAIN_INVOICE) return true;
    const lower = note.content.toLowerCase();
    return (
      lower.includes('bitcoin') ||
      lower.includes('transaction') ||
      lower.includes('btc') ||
      lower.includes('sats') ||
      lower.includes('onchain') ||
      lower.includes('on-chain') ||
      lower.includes('utxo') ||
      lower.includes('psbt')
    );
  }

  return true;
}

/**
 * Subscribe to a Nostr feed across multiple relays.
 * Returns a cleanup function to close all connections.
 */
export function subscribeFeed(
  relayUrls: string[],
  filter: FeedFilter,
  onNote: (note: FeedNote) => void,
  onEose?: () => void
): () => void {
  const connections: RelayConnection[] = [];
  const seenIds = new Set<string>();
  let eoseCount = 0;
  let eoseFired = false;
  const totalRelays = relayUrls.length;

  for (const url of relayUrls) {
    const subId = `feed_${Math.random().toString(36).slice(2, 10)}`;

    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      continue;
    }

    const conn: RelayConnection = { ws, url, subId };
    connections.push(conn);

    ws.onopen = () => {
      const nostrFilter = buildNostrFilter(filter);
      ws.send(JSON.stringify(['REQ', subId, nostrFilter]));
    };

    ws.onmessage = (msg) => {
      try {
        const data = JSON.parse(msg.data);

        if (data[0] === 'EVENT' && data[1] === subId) {
          const event = data[2];
          if (seenIds.has(event.id)) return;
          seenIds.add(event.id);

          const note: FeedNote = {
            id: event.id,
            pubkey: event.pubkey,
            content: event.content,
            created_at: event.created_at,
            tags: event.tags ?? [],
            kind: event.kind,
          };

          if (passesClientFilter(note, filter)) {
            onNote(note);
          }
        } else if (data[0] === 'EOSE' && data[1] === subId) {
          eoseCount++;
          if (!eoseFired && eoseCount >= Math.min(totalRelays, 2)) {
            eoseFired = true;
            onEose?.();
          }
        }
      } catch {
        // ignore parse errors
      }
    };

    ws.onerror = () => {
      eoseCount++;
      if (!eoseFired && eoseCount >= totalRelays) {
        eoseFired = true;
        onEose?.();
      }
    };
  }

  return () => {
    for (const conn of connections) {
      try {
        if (conn.ws.readyState === WebSocket.OPEN) {
          conn.ws.send(JSON.stringify(['CLOSE', conn.subId]));
        }
        conn.ws.close();
      } catch {
        // ignore close errors
      }
    }
    connections.length = 0;
  };
}
