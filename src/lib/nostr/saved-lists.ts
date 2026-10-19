/**
 * The user's saved hashtags and relays to explore, kept on the device and synced as
 * standard NIP-51 lists so other clients see them too:
 *   kind 10015 "interests"       ["t", "<hashtag>"] …
 *   kind 10012 "favorite relays" ["relay", "wss://…"] …
 * The newer of the local copy and the published list wins on load.
 */
import { useEffect, useState } from 'react';
import { normalizeRelay, streamQuery, getViewerReadRelays, DEFAULT_RELAYS } from './query';
import { PRESET_HASHTAGS } from './feed';

export const KIND_INTERESTS = 10015;
export const KIND_FAVORITE_RELAYS = 10012;

export type ListKind = 'tags' | 'relays';
export interface SavedList {
  items: string[];
  /** unix seconds of the last local change */
  updatedAt: number;
  /** created_at of the last list published or seen on relays */
  syncedAt: number;
}

/** Relays a new user starts with in the explorer: answer without auth and serve all kinds (checked 2026-10-19). */
export const STARTER_RELAYS = [
  'wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.snort.social', 'wss://relay.ditto.pub',
  'wss://relay.nostronchain.com', 'wss://offchain.pub', 'wss://nostr.bitcoiner.social', 'wss://relay.nos.social',
];

const KEY = (k: ListKind, pk: string) => `nostronchain_saved_${k}_${pk || 'guest'}`;

export function cleanTag(t: string): string {
  return t.trim().replace(/^#+/, '').toLowerCase().replace(/\s+/g, '').slice(0, 60);
}
function cleanItem(kind: ListKind, v: string): string | null {
  if (kind === 'tags') { const t = cleanTag(v); return t || null; }
  return normalizeRelay(/^wss?:\/\//i.test(v.trim()) ? v.trim() : 'wss://' + v.trim());
}
function dedupe(kind: ListKind, items: string[]): string[] {
  const out: string[] = [];
  for (const v of items) { const c = cleanItem(kind, v); if (c && !out.includes(c)) out.push(c); }
  return out;
}

export function loadList(kind: ListKind, pubkey: string): SavedList {
  try {
    const v = JSON.parse(localStorage.getItem(KEY(kind, pubkey)) || 'null');
    if (v && Array.isArray(v.items)) return { items: dedupe(kind, v.items), updatedAt: +v.updatedAt || 0, syncedAt: +v.syncedAt || 0 };
  } catch { /* blocked storage */ }
  return { items: kind === 'tags' ? [...PRESET_HASHTAGS] : [...STARTER_RELAYS], updatedAt: 0, syncedAt: 0 };
}

const listeners = new Set<() => void>();
function store(kind: ListKind, pubkey: string, l: SavedList) {
  try { localStorage.setItem(KEY(kind, pubkey), JSON.stringify(l)); } catch { /* blocked storage */ }
  for (const fn of listeners) fn();
}

export function setItems(kind: ListKind, pubkey: string, items: string[]): SavedList {
  const cur = loadList(kind, pubkey);
  const next = { ...cur, items: dedupe(kind, items), updatedAt: Math.floor(Date.now() / 1000) };
  store(kind, pubkey, next);
  return next;
}
export function addItem(kind: ListKind, pubkey: string, v: string): SavedList | null {
  const c = cleanItem(kind, v);
  if (!c) return null;
  const cur = loadList(kind, pubkey);
  if (cur.items.includes(c)) return cur;
  return setItems(kind, pubkey, [...cur.items, c]);
}
export function removeItem(kind: ListKind, pubkey: string, v: string): SavedList {
  return setItems(kind, pubkey, loadList(kind, pubkey).items.filter((x) => x !== v));
}
export function moveItem(kind: ListKind, pubkey: string, v: string, by: -1 | 1): SavedList {
  const items = [...loadList(kind, pubkey).items];
  const i = items.indexOf(v);
  const j = i + by;
  if (i < 0 || j < 0 || j >= items.length) return loadList(kind, pubkey);
  [items[i], items[j]] = [items[j], items[i]];
  return setItems(kind, pubkey, items);
}
/** Unsynced local changes exist (the list was edited after the last publish). */
export function isDirty(l: SavedList): boolean {
  return l.updatedAt > l.syncedAt;
}

/** React view of a saved list, re-rendering on any change. */
export function useSavedList(kind: ListKind, pubkey: string): SavedList {
  const [l, setL] = useState(() => loadList(kind, pubkey));
  useEffect(() => {
    setL(loadList(kind, pubkey));
    const fn = () => setL(loadList(kind, pubkey));
    listeners.add(fn);
    return () => { listeners.delete(fn); };
  }, [kind, pubkey]);
  return l;
}

export function listTemplate(kind: ListKind, items: string[]) {
  return {
    kind: kind === 'tags' ? KIND_INTERESTS : KIND_FAVORITE_RELAYS,
    created_at: Math.floor(Date.now() / 1000),
    content: '',
    tags: items.map((v) => (kind === 'tags' ? ['t', v] : ['relay', v])),
  };
}

/** Mark the list as published at `createdAt`. */
export function markSynced(kind: ListKind, pubkey: string, createdAt: number) {
  const cur = loadList(kind, pubkey);
  store(kind, pubkey, { ...cur, syncedAt: Math.max(createdAt, cur.updatedAt) });
}

/**
 * Fetch the user's published lists; adopt one when it is newer than the local copy
 * (another client edited it). Resolves with which lists changed.
 */
export async function pullLists(pubkey: string): Promise<ListKind[]> {
  if (!pubkey) return [];
  const relays = [...new Set([...(await getViewerReadRelays().catch(() => [])), ...DEFAULT_RELAYS, 'wss://purplepag.es'])];
  const newest = new Map<number, { created_at: number; tags: string[][] }>();
  await new Promise<void>((resolve) => {
    streamQuery({
      relays,
      filters: [{ kinds: [KIND_INTERESTS, KIND_FAVORITE_RELAYS], authors: [pubkey], limit: 4 }],
      timeoutMs: 7000,
      onEvent: (e) => {
        const prev = newest.get(e.kind);
        if (!prev || prev.created_at < e.created_at) newest.set(e.kind, { created_at: e.created_at, tags: e.tags });
      },
      onDone: () => resolve(),
    });
  });
  const changed: ListKind[] = [];
  for (const [k, ev] of newest) {
    const kind: ListKind = k === KIND_INTERESTS ? 'tags' : 'relays';
    const cur = loadList(kind, pubkey);
    if (ev.created_at <= Math.max(cur.updatedAt, cur.syncedAt)) continue;
    const items = dedupe(kind, ev.tags.filter((t) => t[0] === (kind === 'tags' ? 't' : 'relay')).map((t) => t[1] || ''));
    store(kind, pubkey, { items, updatedAt: ev.created_at, syncedAt: ev.created_at });
    changed.push(kind);
  }
  return changed;
}
