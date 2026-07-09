/**
 * Nostr feed subscription manager.
 */

import { CUSTOM_KIND } from './kinds';
import { subscribeRelays } from './relay-subscribe';
import type { Filter } from 'nostr-tools/filter';

export type FeedMode = 'global' | 'following' | 'media' | 'onchain' | 'hashtag' | 'kind';

export interface NostrEvent {
  id: string;
  pubkey: string;
  content: string;
  created_at: number;
  tags: string[][];
  kind: number;
  sig?: string;
}

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

const IMAGE_REGEX = /https?:\/\/\S+\.(jpg|jpeg|png|gif|webp)(\?\S*)?/i;

function buildNostrFilter(filter: FeedFilter): Filter {
  const limit = filter.limit ?? 50;
  const base: Filter = { limit };
  if (filter.until) base.until = filter.until;

  const recentSince = Math.floor(Date.now() / 1000) - 30 * 86400;

  switch (filter.mode) {
    case 'global':
      return { ...base, kinds: [1], since: recentSince };
    case 'following':
      if (!filter.pubkeys?.length) return { ...base, kinds: [1], limit: 0 };
      return { ...base, kinds: [1], authors: filter.pubkeys };
    case 'media':
      return { ...base, kinds: [1] };
    case 'onchain':
      return { ...base, kinds: [1, CUSTOM_KIND.ONCHAIN_INVOICE] };
    case 'hashtag':
      if (!filter.hashtag) return { ...base, kinds: [1] };
      return { ...base, kinds: [1], '#t': [filter.hashtag.toLowerCase().replace(/^#/, '')] };
    case 'kind':
      return { ...base, kinds: [filter.kind ?? 1] };
    default:
      return { ...base, kinds: [1] };
  }
}

function passesClientFilter(note: FeedNote, filter: FeedFilter): boolean {
  if (filter.mode === 'media') return IMAGE_REGEX.test(note.content);
  if (filter.mode === 'onchain') {
    if (note.kind === CUSTOM_KIND.ONCHAIN_INVOICE) return true;
    const lower = note.content.toLowerCase();
    return /bitcoin|transaction|btc|sats|onchain|on-chain|utxo|psbt/.test(lower);
  }
  return true;
}

export function subscribeEvents(
  relayUrls: string[],
  filter: Filter,
  onEvent: (event: NostrEvent) => void,
  onEose?: () => void,
): () => void {
  const seenIds = new Set<string>();
  return subscribeRelays({
    relayUrls,
    filter,
    onEvent: (event) => {
      const e = event as unknown as NostrEvent;
      if (!e.id || seenIds.has(e.id)) return;
      seenIds.add(e.id);
      onEvent(e);
    },
    onEose,
  });
}

export function subscribeFeed(
  relayUrls: string[],
  filter: FeedFilter,
  onNote: (note: FeedNote) => void,
  onEose?: () => void,
): () => void {
  const nostrFilter = buildNostrFilter(filter);
  if (filter.mode === 'following' && (!filter.pubkeys?.length)) {
    onEose?.();
    return () => {};
  }

  const seenIds = new Set<string>();
  return subscribeRelays({
    relayUrls,
    filter: nostrFilter,
    onEvent: (event) => {
      const e = event as unknown as NostrEvent;
      if (!e.id || seenIds.has(e.id)) return;
      seenIds.add(e.id);
      const note: FeedNote = {
        id: e.id,
        pubkey: e.pubkey,
        content: e.content,
        created_at: e.created_at,
        tags: e.tags ?? [],
        kind: e.kind,
      };
      if (passesClientFilter(note, filter)) onNote(note);
    },
    onEose,
  });
}
