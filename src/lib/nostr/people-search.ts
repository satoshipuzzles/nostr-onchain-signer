/**
 * People search: npub / nprofile / hex paste, NIP-05 lookup, the viewer's
 * follows (kind 3) and NIP-50 kind-0 search, through the browser's relays
 * and the cloud fallback. Results stream in; follows rank first.
 */

import { nip19 } from 'nostr-tools';
import { type ProfileMetadata } from './social';
import { sanitizeProfile, searchLocalCache, cacheProfiles } from './cache';
import { resolveNip05 } from './nip05';
import { streamQuery, PEOPLE_SEARCH_RELAYS, INDEXER_RELAYS, DEFAULT_RELAYS, cleanRelays, type NEvent } from './query';
import { getProfileSync, primeProfiles, requestProfiles } from './nostr-store';

export type PeopleSource = 'direct' | 'nip05' | 'follow' | 'search' | 'cache';

export interface PeopleHit {
  profile: ProfileMetadata;
  following: boolean;
  source: PeopleSource;
  score: number;
}

const HEX64 = /^[0-9a-f]{64}$/i;

/** A pasted key, or null. */
export function parseKeyQuery(q: string): { pubkey: string; relays: string[] } | null {
  const s = q.trim().replace(/^nostr:/i, '');
  if (HEX64.test(s)) return { pubkey: s.toLowerCase(), relays: [] };
  if (/^(npub|nprofile)1[02-9ac-hj-np-z]+$/i.test(s)) {
    try {
      const d = nip19.decode(s.toLowerCase());
      if (d.type === 'npub') return { pubkey: d.data, relays: [] };
      if (d.type === 'nprofile') return { pubkey: d.data.pubkey, relays: d.data.relays ?? [] };
    } catch { /* not a key */ }
  }
  return null;
}

/** name@domain, or a bare domain (meaning _@domain). */
export function parseNip05Query(q: string): string | null {
  const s = q.trim().toLowerCase();
  if (/^[a-z0-9._+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(s)) return s;
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(s) && !s.includes(' ')) return `_@${s}`;
  return null;
}

function matchScore(p: ProfileMetadata, q: string): number {
  const query = q.toLowerCase().trim();
  if (!query) return 0;
  const compact = query.replace(/\s+/g, '');
  const fields = [p.displayName, p.name].filter((x): x is string => !!x).map((x) => x.toLowerCase());
  let best = 0;
  for (const f of fields) {
    const fc = f.replace(/\s+/g, '');
    if (f === query || fc === compact) best = Math.max(best, 300);
    else if (f.startsWith(query) || fc.startsWith(compact)) best = Math.max(best, 200);
    else if (f.includes(query) || fc.includes(compact)) best = Math.max(best, 120);
  }
  const nip05 = (p.nip05 ?? '').toLowerCase();
  if (nip05) {
    const local = nip05.split('@')[0];
    if (local === compact || nip05 === query) best = Math.max(best, 260);
    else if (nip05.includes(compact)) best = Math.max(best, 100);
  }
  if (!best && (p.about ?? '').toLowerCase().includes(query)) best = 30;
  return best;
}

function quality(p: ProfileMetadata): number {
  return (p.picture ? 10 : 0) + (p.displayName || p.name ? 5 : 0) + (p.nip05 ? 5 : 0);
}

export interface SearchPeopleOptions {
  following: Set<string>;
  onUpdate: (hits: PeopleHit[], done: boolean) => void;
  /** Skip the network (local follows + cache only). */
  localOnly?: boolean;
}

/** Search people. Returns a cancel function; results arrive through onUpdate. */
export function searchPeople(query: string, opts: SearchPeopleOptions): () => void {
  const q = query.trim();
  const hits = new Map<string, PeopleHit>();
  let cancelled = false;
  const cancels: (() => void)[] = [];
  let pending = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const emit = (final = false) => {
    if (cancelled) return;
    const list = [...hits.values()].sort((a, b) => b.score - a.score);
    opts.onUpdate(list, final && pending === 0);
  };
  const schedule = () => { if (!timer) timer = setTimeout(() => { timer = null; emit(); }, 150); };
  const add = (profile: ProfileMetadata, source: PeopleSource, base = 0) => {
    if (!profile?.pubkey) return;
    const following = opts.following.has(profile.pubkey);
    const m = source === 'direct' || source === 'nip05' ? 400 : matchScore(profile, q);
    if (!m && source !== 'search') return;
    const score = base + m + (following ? 1000 : 0) + quality(profile) + (source === 'search' ? 5 : 0);
    const prev = hits.get(profile.pubkey);
    if (prev && prev.score >= score && (prev.profile.name || prev.profile.displayName)) return;
    hits.set(profile.pubkey, { profile: prev && !profile.name && !profile.displayName ? prev.profile : profile, following, source, score });
    schedule();
  };
  const begin = () => { pending++; };
  const end = () => { pending--; emit(true); };

  if (!q) {
    setTimeout(() => emit(true), 0);
    return () => { cancelled = true; };
  }

  // 1. Pasted key: look that one profile up
  const key = parseKeyQuery(q);
  if (key) {
    add(getProfileSync(key.pubkey) ?? { pubkey: key.pubkey }, 'direct');
    if (!opts.localOnly) {
      begin();
      cancels.push(lookupProfiles([key.pubkey], key.relays, (p) => add(p, 'direct'), end));
    }
    setTimeout(() => emit(), 0);
    return () => { cancelled = true; cancels.forEach((c) => c()); };
  }

  // 2. Follows and the local cache: instant
  for (const pk of opts.following) {
    const p = getProfileSync(pk);
    if (p) add(p, 'follow');
  }
  begin();
  searchLocalCache(q).then((list) => {
    for (const p of list.slice(0, 60)) add(p, opts.following.has(p.pubkey) ? 'follow' : 'cache');
  }).catch(() => {}).finally(end);

  if (opts.localOnly) return () => { cancelled = true; };

  // 3. NIP-05
  const nip05 = parseNip05Query(q);
  if (nip05) {
    begin();
    resolveNip05(nip05).then((r) => {
      if (!r || cancelled) { end(); return; }
      add(getProfileSync(r.pubkey) ?? { pubkey: r.pubkey, nip05 }, 'nip05');
      cancels.push(lookupProfiles([r.pubkey], r.relays ?? [], (p) => add(p, 'nip05'), end));
    }).catch(end);
  }

  // 4. NIP-50 kind-0 search (browser + cloud)
  if (q.length >= 2) {
    begin();
    const found = new Map<string, ProfileMetadata>();
    cancels.push(streamQuery({
      relays: PEOPLE_SEARCH_RELAYS,
      filters: [{ kinds: [0], search: nip05 ? q.split('@')[0] : q, limit: 50 }],
      timeoutMs: 7000,
      onEvent: (e: NEvent) => {
        if (e.kind !== 0) return;
        try {
          const p = sanitizeProfile(JSON.parse(e.content), e.pubkey);
          found.set(e.pubkey, p);
          add(p, opts.following.has(e.pubkey) ? 'follow' : 'search');
        } catch { /* bad profile */ }
      },
      onDone: () => {
        if (found.size) {
          primeProfiles(found.values());
          cacheProfiles(found).catch(() => {});
        }
        end();
      },
    }));
  }

  return () => {
    cancelled = true;
    if (timer) clearTimeout(timer);
    cancels.forEach((c) => c());
  };
}

/** Fetch specific profiles (kind 0) and hand each one over. */
function lookupProfiles(pubkeys: string[], hints: string[], onProfile: (p: ProfileMetadata) => void, onDone: () => void): () => void {
  const newest = new Map<string, NEvent>();
  return streamQuery({
    relays: cleanRelays([...hints, ...INDEXER_RELAYS, ...DEFAULT_RELAYS, 'wss://relay.nostr.band'], 10),
    filters: [{ kinds: [0], authors: pubkeys, limit: pubkeys.length * 2 }],
    timeoutMs: 6000,
    onEvent: (e) => {
      if (e.kind !== 0) return;
      const prev = newest.get(e.pubkey);
      if (prev && prev.created_at >= e.created_at) return;
      newest.set(e.pubkey, e);
      try { onProfile(sanitizeProfile(JSON.parse(e.content), e.pubkey)); } catch { /* bad JSON */ }
    },
    onDone: () => {
      const map = new Map<string, ProfileMetadata>();
      for (const e of newest.values()) {
        try { map.set(e.pubkey, sanitizeProfile(JSON.parse(e.content), e.pubkey)); } catch { /* skip */ }
      }
      if (map.size) { primeProfiles(map.values()); cacheProfiles(map).catch(() => {}); }
      onDone();
    },
  });
}

/** Load the viewer's follows' profiles into the store (batched). */
export function loadFollowProfiles(following: Iterable<string>) {
  requestProfiles([...following]);
}

/** Promise form for callers that want a single answer (e.g. @mention autocomplete). */
export function searchPeopleOnce(query: string, following: Set<string> = new Set()): Promise<PeopleHit[]> {
  return new Promise((resolve) => {
    let last: PeopleHit[] = [];
    const cancel = searchPeople(query, {
      following,
      onUpdate: (hits, done) => {
        last = hits;
        if (done) { cancel(); resolve(hits); }
      },
    });
    setTimeout(() => { cancel(); resolve(last); }, 8000);
  });
}
