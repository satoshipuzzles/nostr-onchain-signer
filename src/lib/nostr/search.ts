/**
 * Search box parsing for Discover: work out whether a query names a specific
 * event, a person, an addressable event, a hashtag, or is free text, and
 * build the relay filters that find it.
 */

import { nip19 } from 'nostr-tools';
import type { Filter } from 'nostr-tools/filter';

export type SearchTarget =
  | { type: 'event'; id: string; relays: string[] }
  | { type: 'profile'; pubkey: string; relays: string[] }
  | { type: 'addr'; kind: number; pubkey: string; identifier: string; relays: string[] }
  | { type: 'hex'; hex: string }
  | { type: 'hashtag'; tag: string }
  | { type: 'text'; text: string };

/** Relays that implement NIP-50 full-text search. Never relay.primal.net. */
export const SEARCH_RELAYS = ['wss://search.nos.today', 'wss://relay.ditto.pub', 'wss://nostr.wine', 'wss://relay.nostr.band'];

export function parseSearchQuery(raw: string): SearchTarget | null {
  const q = raw.trim().replace(/^nostr:/i, '');
  if (!q) return null;
  const lower = q.toLowerCase();

  if (/^(note|nevent|naddr|npub|nprofile)1[02-9ac-hj-np-z]+$/.test(lower)) {
    try {
      const d = nip19.decode(lower);
      switch (d.type) {
        case 'note': return { type: 'event', id: d.data, relays: [] };
        case 'nevent': return { type: 'event', id: d.data.id, relays: d.data.relays ?? [] };
        case 'naddr': return {
          type: 'addr', kind: d.data.kind, pubkey: d.data.pubkey,
          identifier: d.data.identifier, relays: d.data.relays ?? [],
        };
        case 'npub': return { type: 'profile', pubkey: d.data, relays: [] };
        case 'nprofile': return { type: 'profile', pubkey: d.data.pubkey, relays: d.data.relays ?? [] };
      }
    } catch {
      /* fall through to text search */
    }
  }
  // 64 hex is either an event id or a pubkey; the caller looks up both.
  if (/^[0-9a-f]{64}$/.test(lower)) return { type: 'hex', hex: lower };
  if (/^#[^\s#]+$/.test(q)) return { type: 'hashtag', tag: q.slice(1).toLowerCase() };
  return { type: 'text', text: q };
}

/** Filters that find notes for a target. Profiles are handled by the people search. */
export function noteFilters(t: SearchTarget, limit = 40): Filter[] {
  switch (t.type) {
    case 'event': return [{ ids: [t.id] }];
    case 'hex': return [{ ids: [t.hex] }];
    case 'addr': return [{ kinds: [t.kind], authors: [t.pubkey], '#d': [t.identifier], limit: 1 }];
    case 'hashtag': return [{ kinds: [1], '#t': [t.tag], limit }];
    case 'text': return [{ kinds: [1, 30023], search: t.text, limit } as Filter];
    case 'profile': return [{ kinds: [1], authors: [t.pubkey], limit }];
  }
}

/** Relays to ask: hints from the link first, then search relays for text, then the user's own. */
export function searchRelaysFor(t: SearchTarget, readRelays: string[]): string[] {
  const hints = 'relays' in t ? t.relays : [];
  const base = t.type === 'text' ? SEARCH_RELAYS : [...readRelays, ...SEARCH_RELAYS];
  return [...new Set([...hints, ...base])].filter((r) => !r.includes('primal.net')).slice(0, 8);
}
