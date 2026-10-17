/**
 * Shared, batched lookups for profiles (kind 0) and single events (quotes,
 * reaction targets, thread parents). Components ask by key; requests made in
 * the same ~120 ms are merged into one relay query. Results are kept in
 * memory and profiles are also written to the persistent profile cache.
 */

import type { Filter } from 'nostr-tools/filter';
import { type ProfileMetadata } from './social';
import { sanitizeProfile, getCachedProfiles, cacheProfiles } from './cache';
import { streamQuery, relaysForAuthors, DEFAULT_RELAYS, INDEXER_RELAYS, cleanRelays, getViewerReadRelays, type NEvent } from './query';

type Listener = () => void;

// ─── Profiles ────────────────────────────────────────────────────

const profiles = new Map<string, ProfileMetadata>();
const profileListeners = new Map<string, Set<Listener>>();
const profileRequested = new Set<string>();
const profileMissing = new Map<string, number>(); // pubkey -> when we last failed
let profileQueue = new Set<string>();
let profileTimer: ReturnType<typeof setTimeout> | null = null;

const HEX64 = /^[0-9a-f]{64}$/;

function notify(map: Map<string, Set<Listener>>, key: string) {
  map.get(key)?.forEach((fn) => { try { fn(); } catch { /* ignore */ } });
}

function listen(map: Map<string, Set<Listener>>, key: string, fn: Listener): () => void {
  let set = map.get(key);
  if (!set) { set = new Set(); map.set(key, set); }
  set.add(fn);
  return () => { set!.delete(fn); };
}

export function getProfileSync(pubkey: string): ProfileMetadata | undefined {
  return profiles.get(pubkey);
}

export function onProfile(pubkey: string, fn: Listener): () => void {
  return listen(profileListeners, pubkey, fn);
}

/** Seed the store with profiles already loaded elsewhere. */
export function primeProfiles(list: Iterable<ProfileMetadata>) {
  for (const p of list) {
    if (!p?.pubkey) continue;
    const had = profiles.get(p.pubkey);
    if (!had || (!had.name && !had.displayName && (p.name || p.displayName))) {
      profiles.set(p.pubkey, p);
      notify(profileListeners, p.pubkey);
    }
  }
}

/** Ask for profiles; they arrive through onProfile listeners. */
export function requestProfiles(pubkeys: string[], hints: string[] = []) {
  for (const pk of pubkeys) {
    if (!pk || !HEX64.test(pk) || profileRequested.has(pk)) continue;
    const failedAt = profileMissing.get(pk);
    if (failedAt && Date.now() - failedAt < 60_000) continue;
    profileRequested.add(pk);
    profileQueue.add(pk);
  }
  for (const h of hints) profileHints.add(h);
  if (profileQueue.size && !profileTimer) profileTimer = setTimeout(flushProfiles, 120);
}

const profileHints = new Set<string>();

async function flushProfiles() {
  profileTimer = null;
  const batch = [...profileQueue];
  profileQueue = new Set();
  const hints = [...profileHints].slice(0, 3);
  profileHints.clear();
  if (!batch.length) return;

  // Persistent cache first: instant names, then refresh from relays anyway
  try {
    const { cached } = await getCachedProfiles(batch);
    primeProfiles(cached.values());
  } catch { /* storage unavailable */ }

  const viewer = await getViewerReadRelays();
  const relays = cleanRelays([...hints, ...INDEXER_RELAYS, ...DEFAULT_RELAYS, ...viewer.slice(0, 3)], 10);
  for (let i = 0; i < batch.length; i += 150) {
    const chunk = batch.slice(i, i + 150);
    const newest = new Map<string, NEvent>();
    streamQuery({
      relays,
      filters: [{ kinds: [0], authors: chunk, limit: chunk.length * 2 }],
      timeoutMs: 6000,
      onEvent: (e) => {
        if (e.kind !== 0) return;
        const prev = newest.get(e.pubkey);
        if (prev && prev.created_at >= e.created_at) return;
        newest.set(e.pubkey, e);
        try {
          const p = sanitizeProfile(JSON.parse(e.content), e.pubkey);
          profiles.set(e.pubkey, p);
          notify(profileListeners, e.pubkey);
        } catch { /* bad JSON */ }
      },
      onDone: () => {
        const found = new Map<string, ProfileMetadata>();
        for (const pk of chunk) {
          const p = profiles.get(pk);
          if (newest.has(pk) && p) found.set(pk, p);
          else if (!newest.has(pk)) {
            // Let a later request retry (maybe a relay was slow)
            profileRequested.delete(pk);
            profileMissing.set(pk, Date.now());
          }
        }
        if (found.size) cacheProfiles(found).catch(() => {});
      },
    });
  }
}

/** Display name for a pubkey, or a short npub-ish fallback. */
export function profileName(p: ProfileMetadata | undefined | null, pubkey: string, fallback?: string): string {
  return p?.displayName || p?.name || fallback || pubkey.slice(0, 8);
}

// ─── Events (by id or address) ───────────────────────────────────

export type EventPointer =
  | { type: 'id'; id: string; relays?: string[]; author?: string }
  | { type: 'addr'; kind: number; pubkey: string; identifier: string; relays?: string[] };

export function pointerKey(p: EventPointer): string {
  return p.type === 'id' ? p.id : `${p.kind}:${p.pubkey}:${p.identifier}`;
}

const events = new Map<string, NEvent | null>(); // null = looked, not found
const eventListeners = new Map<string, Set<Listener>>();
const eventRequested = new Set<string>();
let eventQueue: EventPointer[] = [];
let eventTimer: ReturnType<typeof setTimeout> | null = null;

export function getEventSync(key: string): NEvent | null | undefined {
  return events.get(key);
}

export function onEvent(key: string, fn: Listener): () => void {
  return listen(eventListeners, key, fn);
}

/** Store an event we already have (e.g. from a thread query). */
export function primeEvent(e: NEvent) {
  if (!e?.id) return;
  if (!events.get(e.id)) {
    events.set(e.id, e);
    notify(eventListeners, e.id);
  }
}

export function requestEvent(p: EventPointer) {
  const key = pointerKey(p);
  if (eventRequested.has(key) || events.get(key)) return;
  eventRequested.add(key);
  eventQueue.push(p);
  if (!eventTimer) eventTimer = setTimeout(flushEvents, 120);
}

async function flushEvents() {
  eventTimer = null;
  const batch = eventQueue;
  eventQueue = [];
  if (!batch.length) return;

  const hints = batch.flatMap((p) => p.relays ?? []);
  const authors = batch.map((p) => (p.type === 'id' ? p.author : p.pubkey)).filter((x): x is string => !!x);
  const relays = await relaysForAuthors(authors, hints);

  const ids = batch.filter((p): p is Extract<EventPointer, { type: 'id' }> => p.type === 'id').map((p) => p.id);
  const filters: Filter[] = [];
  if (ids.length) filters.push({ ids, limit: ids.length });
  for (const p of batch) {
    if (p.type === 'addr') filters.push({ kinds: [p.kind], authors: [p.pubkey], '#d': [p.identifier], limit: 1 });
  }
  // The cloud only serves some kinds; id lookups name no kind, so give it the common ones
  const cloudable: Filter[] = [
    ...(ids.length ? [{ ids, kinds: [0, 1, 6, 7, 1111, 9735], limit: ids.length }] : []),
    ...filters.filter((f) => !f.ids),
  ];

  const settle = (key: string, e: NEvent | null) => {
    const prev = events.get(key);
    if (e && prev && prev.created_at >= e.created_at) return;
    if (!e && prev) return;
    events.set(key, e);
    notify(eventListeners, key);
  };

  const onEv = (e: NEvent) => {
    if (ids.includes(e.id)) settle(e.id, e);
    for (const p of batch) {
      if (p.type === 'addr' && e.kind === p.kind && e.pubkey === p.pubkey
        && e.tags.some((t) => t[0] === 'd' && (t[1] ?? '') === p.identifier)) {
        settle(pointerKey(p), e);
      }
    }
  };

  let pending = 2;
  const done = () => {
    if (--pending > 0) return;
    for (const p of batch) {
      const key = pointerKey(p);
      if (!events.get(key)) {
        settle(key, null);
        eventRequested.delete(key); // allow a retry later
      }
    }
  };
  streamQuery({ relays, filters, onEvent: onEv, onDone: done, timeoutMs: 7000, cloud: false });
  if (cloudable.length) streamQuery({ relays: [], cloudRelays: relays, filters: cloudable, onEvent: onEv, onDone: done, timeoutMs: 7000 });
  else done();
}
