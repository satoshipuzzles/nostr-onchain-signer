/**
 * The feed store: feeds people make and publish, that anyone can browse and add as a tab.
 *
 * Three sorts of feed live here:
 *
 *  1. The built-in "Nostronchain algo" (the For you tab, see algo.ts). Always first in the store.
 *
 *  2. Algorithm feeds from other providers: NIP-90 content-discovery DVMs. They announce
 *     themselves with a NIP-89 handler event (kind 31990 with ["k","5300"]). Reading one:
 *       - anyone (guests too): the provider's newest public result, kind 6300 by the DVM,
 *         whose content is a JSON array of ["e", <id>] / ["a", <addr>] tags. Nothing is signed.
 *       - signed in, on request ("Personal picks"): a kind 5300 job request ["p", <dvm>] signed
 *         by the user, answered by a 6300 (or a 7000 status) tagging the request. A provider
 *         that asks for payment is shown as such and never paid automatically.
 *
 *  3. Recipe feeds anyone can build here. An addressable event of our own kind:
 *
 *       kind 31618 (unused elsewhere as of 2026-10; "Nostr Onchain feed recipe")
 *       content: JSON Recipe (below), versioned with "v"
 *       ["d", <slug>]            which of the author's feeds (re-publishing replaces it)
 *       ["title", <name>]
 *       ["summary", <description>]
 *       ["image", <https url>]   optional
 *       ["t", <hashtag>] …       the recipe's hashtags, so relays can find feeds by topic
 *       ["alt", "Nostr feed: <name>"]   NIP-31 fallback for other clients
 *
 *     Recipe = {
 *       v: 1,
 *       sources: {
 *         follows: boolean       include the viewer's own follows
 *         authors: hex[]         people
 *         followSets: string[]   "30000:<pk>:<d>" NIP-51 follow sets, or "3:<pk>" someone's follows
 *         hashtags: string[]
 *         relays: string[]       read only these relays (empty = the usual ones)
 *         kinds: number[]        default notes + picture / video posts
 *         match: 'any' | 'all'   people OR hashtags (default), or people AND hashtags
 *       },
 *       filters: { only: ShowOnly, noReplies, noReposts, noHashtags, minEngagement, mutedWords[] },
 *       ranking: 'chronological' | 'foryou'   newest first, or the For you weights
 *     }
 *
 * The feeds a user has added (the tabs on their Feed page, in order) are a replaceable list:
 *
 *       kind 10618 "added feeds"  ["a", "31618:<pk>:<d>"] / ["a", "31990:<pk>:<d>"] …  in tab order
 *
 * It mirrors the NIP-51 list shape (a public list of "a" references), so the store can rank
 * feeds by how many people added them: a count of distinct authors of 10618 lists that
 * reference each feed. Guests keep the same list on the device only, and can carry it into
 * their account when they sign in. Feeds made by a guest are kept locally ("local:<id>")
 * until published.
 */
import { useEffect, useState } from 'react';
import { nip19 } from 'nostr-tools';
import { streamQuery, getViewerReadRelays, outboxRelaysFor, normalizeRelay, DEFAULT_RELAYS, type NEvent } from './query';
import { passesFilters, isReply, DEFAULT_FILTERS, type ShowOnly, type FeedFilterPrefs } from './feed-filters';
import { mutedNow } from './mute';
import { mediaKinds } from './embeds';
import { parseZapReceipt } from './zap';
import { NO_PROMOTE, isJunk, diversify, type Ranked } from './algo';
import { KIND_PICTURE, KIND_VIDEO, KIND_SHORT_VIDEO, EMPTY_ENGAGEMENT, subscribeEvents, type FeedNote, type Engagement } from './feed';

export const KIND_FEED_RECIPE = 31618;
export const KIND_ADDED_FEEDS = 10618;
export const KIND_DVM_HANDLER = 31990;
export const KIND_DVM_REQUEST = 5300;
export const KIND_DVM_RESULT = 6300;
export const KIND_DVM_FEEDBACK = 7000;

/** The For you algorithm's store entry. */
export const BUILTIN_FORYOU = 'builtin:foryou';

/** Where feeds are published and looked for. Never relay.primal.net. */
export const FEED_STORE_RELAYS = [...new Set([...DEFAULT_RELAYS, 'wss://relay.ditto.pub', 'wss://nos.lol', 'wss://relay.damus.io', 'wss://offchain.pub'])];

export const DEFAULT_RECIPE_KINDS = [1, KIND_PICTURE, KIND_VIDEO, KIND_SHORT_VIDEO];

export interface Recipe {
  v: 1;
  sources: {
    follows: boolean;
    authors: string[];
    followSets: string[];
    hashtags: string[];
    relays: string[];
    kinds: number[];
    match: 'any' | 'all';
  };
  filters: {
    only: ShowOnly;
    noReplies: boolean;
    noReposts: boolean;
    noHashtags: boolean;
    minEngagement: number;
    mutedWords: string[];
  };
  ranking: 'chronological' | 'foryou';
}

export function emptyRecipe(): Recipe {
  return {
    v: 1,
    sources: { follows: false, authors: [], followSets: [], hashtags: [], relays: [], kinds: [...DEFAULT_RECIPE_KINDS], match: 'any' },
    filters: { only: 'all', noReplies: true, noReposts: false, noHashtags: false, minEngagement: 0, mutedWords: [] },
    ranking: 'chronological',
  };
}

export type FeedType = 'builtin' | 'recipe' | 'dvm';

export interface FeedDef {
  /** "31618:<pk>:<d>", "31990:<pk>:<d>", "local:<id>" or BUILTIN_FORYOU */
  addr: string;
  type: FeedType;
  pubkey: string;
  d: string;
  title: string;
  description: string;
  image: string;
  hashtags: string[];
  createdAt: number;
  recipe?: Recipe;
  /** DVM asks for payment (an "amount" tag on its announcement) */
  paid?: boolean;
  /** published event id (for deletion) */
  eventId?: string;
}

export const FORYOU_DEF: FeedDef = {
  addr: BUILTIN_FORYOU, type: 'builtin', pubkey: '', d: 'foryou',
  title: 'Nostronchain algo',
  description: 'The For you feed: what the people you follow (or, for guests, a starter set of Bitcoiners) like, zap, repost and reply to, ranked in your browser with no server. Spam and bots sink; nobody is boosted for paying.',
  image: '/logo.png', hashtags: ['xbt', 'onchain', 'bip110'], createdAt: 0,
};

const isHex = (s: string) => /^[0-9a-f]{64}$/.test(s);
const now = () => Math.floor(Date.now() / 1000);
const HOUR = 3600;

export function naddrOf(def: FeedDef): string | null {
  if (def.type === 'builtin' || def.addr.startsWith('local:')) return null;
  const kind = def.type === 'dvm' ? KIND_DVM_HANDLER : KIND_FEED_RECIPE;
  try { return nip19.naddrEncode({ kind, pubkey: def.pubkey, identifier: def.d }); } catch { return null; }
}

// ─── recipes ────────────────────────────────────────────────────

function cleanRecipe(raw: unknown): Recipe | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<Recipe> & { sources?: Partial<Recipe['sources']>; filters?: Partial<Recipe['filters']> };
  const base = emptyRecipe();
  const strs = (a: unknown, max = 500) => (Array.isArray(a) ? a.filter((x): x is string => typeof x === 'string').slice(0, max) : []);
  const s: Partial<Recipe['sources']> = r.sources || {};
  const f: Partial<Recipe['filters']> = r.filters || {};
  const kinds = Array.isArray(s.kinds) ? s.kinds.filter((k): k is number => Number.isInteger(k) && k >= 0 && k < 65536).slice(0, 12) : [];
  const ONLY: ShowOnly[] = ['all', 'images', 'video', 'audio', 'links', 'text'];
  return {
    v: 1,
    sources: {
      follows: !!s.follows,
      authors: strs(s.authors).map((x) => x.toLowerCase()).filter(isHex),
      followSets: strs(s.followSets, 20).filter((x) => /^(30000:[0-9a-f]{64}:.+|3:[0-9a-f]{64})$/.test(x)),
      hashtags: strs(s.hashtags, 30).map((t) => t.replace(/^#+/, '').toLowerCase().trim()).filter(Boolean),
      relays: strs(s.relays, 12).map((u) => normalizeRelay(u)).filter((u): u is string => !!u),
      kinds: kinds.length ? kinds : base.sources.kinds,
      match: s.match === 'all' ? 'all' : 'any',
    },
    filters: {
      only: ONLY.includes(f.only as ShowOnly) ? (f.only as ShowOnly) : 'all',
      noReplies: !!f.noReplies,
      noReposts: !!f.noReposts,
      noHashtags: !!f.noHashtags,
      minEngagement: Math.max(0, Math.min(1000, Number(f.minEngagement) || 0)),
      mutedWords: strs(f.mutedWords, 50).map((w) => w.trim()).filter(Boolean),
    },
    ranking: r.ranking === 'foryou' ? 'foryou' : 'chronological',
  };
}

export const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'feed';

/** The unsigned event for publishing a recipe feed. */
export function recipeTemplate(def: { d: string; title: string; description: string; image: string; recipe: Recipe }) {
  const tags: string[][] = [
    ['d', def.d],
    ['title', def.title.slice(0, 80)],
    ['summary', def.description.slice(0, 500)],
  ];
  if (/^https:\/\//.test(def.image)) tags.push(['image', def.image]);
  for (const t of def.recipe.sources.hashtags.slice(0, 10)) tags.push(['t', t]);
  tags.push(['alt', `Nostr feed: ${def.title.slice(0, 80)}`]);
  return { kind: KIND_FEED_RECIPE, created_at: now(), content: JSON.stringify(def.recipe), tags };
}

export function parseRecipeEvent(e: NEvent): FeedDef | null {
  if (e.kind !== KIND_FEED_RECIPE) return null;
  const tag = (n: string) => e.tags.find((t) => t[0] === n)?.[1] ?? '';
  const d = tag('d');
  if (!d) return null;
  let recipe: Recipe | null = null;
  try { recipe = cleanRecipe(JSON.parse(e.content)); } catch { recipe = null; }
  if (!recipe) return null;
  const image = tag('image');
  return {
    addr: `${KIND_FEED_RECIPE}:${e.pubkey}:${d}`, type: 'recipe', pubkey: e.pubkey, d,
    title: (tag('title') || 'Untitled feed').slice(0, 80),
    description: tag('summary').slice(0, 500),
    image: /^https:\/\//.test(image) ? image : '',
    hashtags: recipe.sources.hashtags,
    createdAt: e.created_at, recipe, eventId: e.id,
  };
}

export function parseDvmEvent(e: NEvent): FeedDef | null {
  if (e.kind !== KIND_DVM_HANDLER) return null;
  if (!e.tags.some((t) => t[0] === 'k' && t[1] === String(KIND_DVM_REQUEST))) return null;
  const d = e.tags.find((t) => t[0] === 'd')?.[1] ?? '';
  const exp = Number(e.tags.find((t) => t[0] === 'expiration')?.[1] || 0);
  if (exp && exp < now()) return null;
  let meta: Record<string, unknown> = {};
  try { const v = JSON.parse(e.content || '{}'); if (v && typeof v === 'object') meta = v; } catch { /* plain text */ }
  const str = (k: string) => (typeof meta[k] === 'string' ? (meta[k] as string) : '');
  const title = str('display_name') || str('displayName') || str('name');
  if (!title) return null;
  const image = str('picture') || str('image');
  return {
    addr: `${KIND_DVM_HANDLER}:${e.pubkey}:${d}`, type: 'dvm', pubkey: e.pubkey, d,
    title: title.slice(0, 80),
    description: (str('about') || '').slice(0, 500),
    image: /^https:\/\//.test(image) ? image : '',
    hashtags: e.tags.filter((t) => t[0] === 't' && t[1]).map((t) => t[1].toLowerCase()).slice(0, 8),
    createdAt: e.created_at, eventId: e.id,
    paid: e.tags.some((t) => t[0] === 'amount' && Number(t[1]) > 0) || meta.amount === 'paid',
  };
}

// ─── the user's added feeds (tabs) ──────────────────────────────

export interface AddedFeeds {
  items: FeedDef[];
  updatedAt: number;
  syncedAt: number;
}

const ADDED_KEY = (pk: string) => `nostronchain_added_feeds_v1_${pk || 'guest'}`;
const addedListeners = new Set<() => void>();

export function loadAdded(pubkey: string): AddedFeeds {
  try {
    const v = JSON.parse(localStorage.getItem(ADDED_KEY(pubkey)) || 'null');
    if (v && Array.isArray(v.items)) {
      const items = (v.items as FeedDef[]).filter((x) => x && typeof x.addr === 'string' && x.addr !== BUILTIN_FORYOU && !NO_PROMOTE.has(x.pubkey));
      return { items, updatedAt: +v.updatedAt || 0, syncedAt: +v.syncedAt || 0 };
    }
  } catch { /* blocked storage */ }
  return { items: [], updatedAt: 0, syncedAt: 0 };
}
function storeAdded(pubkey: string, l: AddedFeeds) {
  try { localStorage.setItem(ADDED_KEY(pubkey), JSON.stringify(l)); } catch { /* blocked storage */ }
  for (const fn of addedListeners) fn();
}
function setAdded(pubkey: string, items: FeedDef[]): AddedFeeds {
  const seen = new Set<string>();
  const clean = items.filter((x) => x.addr !== BUILTIN_FORYOU && !seen.has(x.addr) && (seen.add(x.addr), true)).slice(0, 30);
  const next = { ...loadAdded(pubkey), items: clean, updatedAt: now() };
  storeAdded(pubkey, next);
  return next;
}
export function addFeed(pubkey: string, def: FeedDef): AddedFeeds {
  const cur = loadAdded(pubkey);
  if (cur.items.some((x) => x.addr === def.addr)) return setAdded(pubkey, cur.items.map((x) => (x.addr === def.addr ? def : x)));
  return setAdded(pubkey, [...cur.items, def]);
}
export function removeFeed(pubkey: string, addr: string): AddedFeeds {
  return setAdded(pubkey, loadAdded(pubkey).items.filter((x) => x.addr !== addr));
}
export function moveFeed(pubkey: string, addr: string, by: -1 | 1): AddedFeeds {
  const items = [...loadAdded(pubkey).items];
  const i = items.findIndex((x) => x.addr === addr);
  const j = i + by;
  if (i < 0 || j < 0 || j >= items.length) return loadAdded(pubkey);
  [items[i], items[j]] = [items[j], items[i]];
  return setAdded(pubkey, items);
}
/** Only published feeds can go in the Nostr list; local ones stay on the device. */
export function isAddedDirty(l: AddedFeeds): boolean { return l.updatedAt > l.syncedAt; }

export function addedListTemplate(items: FeedDef[]) {
  return {
    kind: KIND_ADDED_FEEDS,
    created_at: now(),
    content: '',
    tags: items.filter((x) => !x.addr.startsWith('local:') && x.type !== 'builtin').map((x) => ['a', x.addr]),
  };
}
export function markAddedSynced(pubkey: string, createdAt: number) {
  const cur = loadAdded(pubkey);
  storeAdded(pubkey, { ...cur, syncedAt: Math.max(createdAt, cur.updatedAt) });
}

/** Feeds added while signed out, not yet in this account's list. */
export function pendingGuestFeeds(pubkey: string): FeedDef[] {
  if (!pubkey) return [];
  const mine = new Set(loadAdded(pubkey).items.map((x) => x.addr));
  return loadAdded('').items.filter((x) => !mine.has(x.addr));
}
export function mergeGuestFeeds(pubkey: string): AddedFeeds {
  const merged = setAdded(pubkey, [...loadAdded(pubkey).items, ...pendingGuestFeeds(pubkey)]);
  storeAdded('', { items: [], updatedAt: now(), syncedAt: now() });
  return merged;
}
export function dismissGuestFeeds() {
  storeAdded('', { items: [], updatedAt: now(), syncedAt: now() });
}

export function useAddedFeeds(pubkey: string): AddedFeeds {
  const [l, setL] = useState(() => loadAdded(pubkey));
  useEffect(() => {
    setL(loadAdded(pubkey));
    const fn = () => setL(loadAdded(pubkey));
    addedListeners.add(fn);
    return () => { addedListeners.delete(fn); };
  }, [pubkey]);
  return l;
}

function queryAll(relays: string[], filters: Parameters<typeof streamQuery>[0]['filters'], timeoutMs: number, onEvent?: (e: NEvent) => void): Promise<NEvent[]> {
  return new Promise((resolve) => { streamQuery({ relays, filters, timeoutMs, onEvent, onDone: resolve }); });
}

/** Look up feed definitions by address (newest version of each). */
export async function resolveFeeds(addrs: string[]): Promise<Map<string, FeedDef>> {
  const out = new Map<string, FeedDef>();
  const parts = addrs.map((a) => a.split(':')).filter((p) => p.length >= 3 && isHex(p[1]));
  if (!parts.length) return out;
  const filters = parts.map(([k, pk, ...d]) => ({ kinds: [Number(k)], authors: [pk], '#d': [d.join(':')] }));
  const evs = await queryAll(FEED_STORE_RELAYS, filters, 6000);
  for (const e of evs.sort((a, b) => a.created_at - b.created_at)) {
    const def = parseRecipeEvent(e) ?? parseDvmEvent(e);
    if (def) out.set(def.addr, def);
  }
  return out;
}

/** Adopt the published list when it is newer than the device's copy. Resolves true when it changed. */
export async function pullAddedFeeds(pubkey: string): Promise<boolean> {
  if (!pubkey) return false;
  const relays = [...new Set([...(await getViewerReadRelays().catch(() => [] as string[])), ...FEED_STORE_RELAYS])];
  const evs = await queryAll(relays, [{ kinds: [KIND_ADDED_FEEDS], authors: [pubkey], limit: 2 }], 6000);
  const ev = evs.sort((a, b) => b.created_at - a.created_at)[0];
  const cur = loadAdded(pubkey);
  if (!ev || ev.created_at <= Math.max(cur.updatedAt, cur.syncedAt)) return false;
  const addrs = ev.tags.filter((t) => t[0] === 'a' && t[1]).map((t) => t[1]);
  const known = new Map(cur.items.map((x) => [x.addr, x]));
  const missing = addrs.filter((a) => !known.has(a));
  const found = missing.length ? await resolveFeeds(missing) : new Map<string, FeedDef>();
  const items = addrs.map((a) => known.get(a) ?? found.get(a)).filter((x): x is FeedDef => !!x && !NO_PROMOTE.has(x.pubkey));
  // keep local-only feeds (not in the published list) at the end
  for (const x of cur.items) if (x.addr.startsWith('local:')) items.push(x);
  storeAdded(pubkey, { items, updatedAt: ev.created_at, syncedAt: ev.created_at });
  return true;
}

// ─── browsing the store ─────────────────────────────────────────

export interface StoreState {
  feeds: FeedDef[];
  /** addr -> how many people added it */
  counts: Map<string, number>;
  /** DVM pubkeys that published a public result in the last day (their preview works for guests) */
  active: Set<string>;
  done: boolean;
}

/**
 * Every published recipe feed and content-discovery DVM, newest version of each, and how
 * many people's added-feeds lists reference each. Odell's feeds are left out.
 */
export function streamStore(onUpdate: (s: StoreState) => void): () => void {
  const byAddr = new Map<string, FeedDef>();
  const adders = new Map<string, Set<string>>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const active = new Set<string>();
  let pending = 3;
  const counts = () => new Map([...adders].map(([a, s]) => [a, s.size]));
  const emit = (done: boolean) => onUpdate({ feeds: [...byAddr.values()], counts: counts(), active: new Set(active), done });
  const soon = () => { if (!timer) timer = setTimeout(() => { timer = null; emit(false); }, 250); };
  const finish = () => { if (--pending <= 0) { if (timer) clearTimeout(timer); emit(true); } };
  const c1 = streamQuery({
    relays: FEED_STORE_RELAYS,
    filters: [{ kinds: [KIND_FEED_RECIPE], limit: 300 }, { kinds: [KIND_DVM_HANDLER], '#k': [String(KIND_DVM_REQUEST)], limit: 300 }],
    timeoutMs: 9000,
    onEvent: (e) => {
      if (NO_PROMOTE.has(e.pubkey)) return;
      const def = parseRecipeEvent(e) ?? parseDvmEvent(e);
      if (!def) return;
      const prev = byAddr.get(def.addr);
      if (prev && prev.createdAt >= def.createdAt) return;
      byAddr.set(def.addr, def);
      soon();
    },
    onDone: finish,
  });
  const latestList = new Map<string, number>();
  const c2 = streamQuery({
    relays: FEED_STORE_RELAYS,
    filters: [{ kinds: [KIND_ADDED_FEEDS], limit: 1000 }],
    timeoutMs: 9000,
    onEvent: (e) => {
      const prev = latestList.get(e.pubkey);
      if (prev && prev >= e.created_at) return;
      latestList.set(e.pubkey, e.created_at);
      for (const s of adders.values()) s.delete(e.pubkey);
      for (const t of e.tags) {
        if (t[0] !== 'a' || !t[1]) continue;
        let s = adders.get(t[1]);
        if (!s) { s = new Set(); adders.set(t[1], s); }
        s.add(e.pubkey);
      }
      soon();
    },
    onDone: finish,
  });
  const c3 = streamQuery({
    relays: FEED_STORE_RELAYS.slice(0, 4),
    filters: [{ kinds: [KIND_DVM_RESULT], since: now() - 86400, limit: 300 }],
    timeoutMs: 9000,
    cloud: false,
    onEvent: (e) => { if (!active.has(e.pubkey) && e.content.trim().startsWith('[')) { active.add(e.pubkey); soon(); } },
    onDone: finish,
  });
  return () => { c1(); c2(); c3(); if (timer) clearTimeout(timer); };
}

/** Store order: most added first, then providers with fresh public picks, then newest. */
export function sortStore(feeds: FeedDef[], counts: Map<string, number>, active: Set<string> = new Set()): FeedDef[] {
  const live = (f: FeedDef) => (f.type === 'dvm' && active.has(f.pubkey) ? 1 : 0);
  return [...feeds].sort((a, b) => (counts.get(b.addr) ?? 0) - (counts.get(a.addr) ?? 0) || live(b) - live(a) || b.createdAt - a.createdAt);
}

export function matchesSearch(def: FeedDef, q: string, authorName = ''): boolean {
  const s = q.trim().toLowerCase();
  if (!s) return true;
  return [def.title, def.description, authorName, ...def.hashtags.map((t) => `#${t}`)].some((x) => x.toLowerCase().includes(s));
}

// ─── running a recipe ───────────────────────────────────────────

export interface FeedItem {
  note: FeedNote;
  engagement?: Engagement;
}

export interface RunContext {
  me: string;
  follows: Set<string>;
}

const chunk = <T,>(a: T[], n: number) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));
const toNote = (e: NEvent): FeedNote => ({ id: e.id, pubkey: e.pubkey, content: e.content, created_at: e.created_at, tags: e.tags, kind: e.kind });

async function followSetMembers(refs: string[], relays: string[]): Promise<string[]> {
  if (!refs.length) return [];
  const filters = refs.map((r) => {
    const [k, pk, ...d] = r.split(':');
    return k === '3' ? { kinds: [3], authors: [pk], limit: 1 } : { kinds: [30000], authors: [pk], '#d': [d.join(':')], limit: 1 };
  });
  const evs = await queryAll(relays, filters, 5000);
  const newest = new Map<string, NEvent>();
  for (const e of evs) {
    const key = `${e.kind}:${e.pubkey}:${e.tags.find((t) => t[0] === 'd')?.[1] ?? ''}`;
    const p = newest.get(key);
    if (!p || p.created_at < e.created_at) newest.set(key, e);
  }
  const out = new Set<string>();
  for (const e of newest.values()) for (const t of e.tags) if (t[0] === 'p' && isHex(t[1] || '')) out.add(t[1]);
  return [...out];
}

function engagementScore(en: Engagement & { zappers?: number }): number {
  return en.reactions + 2 * en.reposts + 3 * en.replies + (en.zapSats > 0 ? 1.5 * (1 + Math.log10(1 + en.zapSats)) : 0);
}

export function recipeFilterPrefs(r: Recipe): FeedFilterPrefs {
  return { ...DEFAULT_FILTERS, only: r.filters.only, hideReplies: r.filters.noReplies, hideReposts: r.filters.noReposts, hideHashtags: r.filters.noHashtags, mutedWords: r.filters.mutedWords };
}

/**
 * Run a recipe: gather from its sources, drop what its filters (and the viewer's mutes)
 * leave out, then order it. Calls onUpdate as results land. Returns a cancel.
 */
export function runRecipe(recipe: Recipe, ctx: RunContext, onUpdate: (items: FeedItem[], done: boolean) => void): () => void {
  let cancelled = false;
  (async () => {
    const viewer = await getViewerReadRelays().catch(() => [] as string[]);
    const usual = [...new Set([...viewer.slice(0, 4), ...DEFAULT_RELAYS, 'wss://relay.ditto.pub'])].filter((r) => !/primal\.net/i.test(r));
    const own = recipe.sources.relays.filter((r) => !/primal\.net/i.test(r));
    const s = recipe.sources;
    const setMembers = await followSetMembers(s.followSets, usual);
    const authors = [...new Set([...s.authors, ...(s.follows ? [...ctx.follows] : []), ...setMembers])].slice(0, 1000);
    if (cancelled) return;
    let relays = own.length ? own : usual;
    if (!own.length && authors.length) {
      const outbox = await outboxRelaysFor(authors.slice(0, 300), 4).catch(() => [] as string[]);
      relays = [...new Set([...usual, ...outbox.filter((r) => !/primal\.net/i.test(r))])].slice(0, 10);
    }
    if (cancelled) return;
    const kinds = s.kinds.length ? s.kinds : DEFAULT_RECIPE_KINDS;
    const ranked = recipe.ranking === 'foryou';
    const since = now() - (ranked ? 36 : 72) * HOUR;
    const tags = s.hashtags;
    const filters: Record<string, unknown>[] = [];
    if (authors.length && tags.length && s.match === 'all') {
      for (const a of chunk(authors, 250)) filters.push({ kinds, authors: a, '#t': tags, since, limit: 300 });
    } else {
      for (const a of chunk(authors, 250)) filters.push({ kinds, authors: a, since, limit: 300 });
      if (tags.length) filters.push({ kinds, '#t': tags, since, limit: 300 });
    }
    if (!filters.length) filters.push({ kinds, since: now() - 12 * HOUR, limit: 300 }); // a relay feed: everything there
    const prefs = recipeFilterPrefs(recipe);
    const notes = new Map<string, FeedNote>();
    const keep = (n: FeedNote) => {
      const muted = mutedNow();
      if (muted.has(n.pubkey)) return false;
      if (isJunk(n)) return false;
      if (!passesFilters(n, prefs)) return false;
      return true;
    };
    let timer: ReturnType<typeof setTimeout> | null = null;
    const order = (eng?: Map<string, Engagement>): FeedItem[] => {
      let list = [...notes.values()].filter(keep);
      if (eng && recipe.filters.minEngagement > 0) list = list.filter((n) => engagementScore(eng.get(n.id) ?? EMPTY_ENGAGEMENT) >= recipe.filters.minEngagement);
      if (!ranked || !eng) return list.sort((a, b) => b.created_at - a.created_at).map((note) => ({ note, engagement: eng?.get(note.id) }));
      const t = now();
      const scored: Ranked[] = list.map((n) => {
        const E = engagementScore(eng.get(n.id) ?? EMPTY_ENGAGEMENT);
        const recency = Math.pow(0.5, Math.max(0, t - n.created_at) / (10 * HOUR));
        const m = mediaKinds(n);
        const media = [KIND_PICTURE, KIND_VIDEO, KIND_SHORT_VIDEO].includes(n.kind) || m.has('image') || m.has('video');
        let score = (1 + 2.2 * Math.log2(1 + E)) * recency * (media ? 1.25 : 1) * (isReply(n) ? 0.6 : 1);
        if (NO_PROMOTE.has(n.pubkey)) score = recency * 0.5;
        return { note: n, score, why: [], discovery: false };
      });
      return diversify(scored.sort((a, b) => b.score - a.score), 0).map((r) => ({ note: r.note, engagement: eng.get(r.note.id) }));
    };
    const emitSoon = () => { if (!timer) timer = setTimeout(() => { timer = null; if (!cancelled && !ranked && !recipe.filters.minEngagement) onUpdate(order(), false); }, 300); };
    await queryAll(relays, filters as Parameters<typeof streamQuery>[0]['filters'], 8000, (e) => {
      if (!kinds.includes(e.kind) || notes.has(e.id)) return;
      notes.set(e.id, toNote(e));
      emitSoon();
    });
    if (timer) clearTimeout(timer);
    if (cancelled) return;
    // engagement for the strongest candidates (needed for ranking / a minimum; nice to show anyway)
    const candidates = [...notes.values()].filter(keep).sort((a, b) => b.created_at - a.created_at).slice(0, 300);
    if (!ranked && !recipe.filters.minEngagement) onUpdate(order(), false);
    const eng = new Map<string, Engagement>(candidates.map((n) => [n.id, { ...EMPTY_ENGAGEMENT }]));
    const seenZap = new Set<string>();
    await Promise.all(chunk(candidates.map((n) => n.id), 100).map((ids) => queryAll(relays.slice(0, 6), [
      { kinds: [1, 6, 7, 16], '#e': ids, limit: 1500 },
      { kinds: [9735], '#e': ids, limit: 500 },
    ], 6000, (e) => {
      const target = e.tags.filter((t) => t[0] === 'e' && t[1]).pop()?.[1];
      const en = target ? eng.get(target) : undefined;
      if (!en) return;
      if (e.kind === 7) en.reactions++;
      else if (e.kind === 6 || e.kind === 16) en.reposts++;
      else if (e.kind === 1) en.replies++;
      else if (e.kind === 9735 && !seenZap.has(e.id)) { seenZap.add(e.id); en.zapSats += parseZapReceipt(e)?.amountSats ?? 0; }
    })));
    if (cancelled) return;
    onUpdate(order(eng), true);
  })().catch((err) => { console.error('recipe', err); if (!cancelled) onUpdate([], true); });
  return () => { cancelled = true; };
}

// ─── reading a DVM ──────────────────────────────────────────────

export interface DvmStatus {
  state: 'idle' | 'waiting' | 'payment' | 'error' | 'done';
  message?: string;
  /** created_at of the result being shown */
  at?: number;
}

function resultRefs(e: NEvent): { ids: string[]; addrs: string[]; relays: string[] } {
  let tags: unknown = [];
  try { tags = JSON.parse(e.content); } catch { tags = []; }
  const list = Array.isArray(tags) ? (tags as unknown[]).filter((t): t is string[] => Array.isArray(t)) : [];
  const ids = list.filter((t) => t[0] === 'e' && isHex(t[1] || '')).map((t) => t[1]);
  const addrs = list.filter((t) => t[0] === 'a' && typeof t[1] === 'string').map((t) => t[1]);
  const relays = (e.tags.find((t) => t[0] === 'relays') || []).slice(1).map((u) => normalizeRelay(u)).filter((u): u is string => !!u);
  return { ids: ids.slice(0, 200), addrs: addrs.slice(0, 50), relays };
}

async function fetchRefs(refs: { ids: string[]; addrs: string[]; relays: string[] }): Promise<FeedNote[]> {
  const relays = [...new Set([...refs.relays.filter((r) => !/primal\.net/i.test(r)).slice(0, 4), ...DEFAULT_RELAYS, 'wss://relay.ditto.pub'])];
  const filters: Record<string, unknown>[] = chunk(refs.ids, 100).map((ids) => ({ ids }));
  for (const a of refs.addrs) {
    const [k, pk, ...d] = a.split(':');
    if (isHex(pk || '')) filters.push({ kinds: [Number(k)], authors: [pk], '#d': [d.join(':')], limit: 1 });
  }
  if (!filters.length) return [];
  const evs = await queryAll(relays, filters as Parameters<typeof streamQuery>[0]['filters'], 7000);
  const byId = new Map(evs.map((e) => [e.id, toNote(e)]));
  const muted = mutedNow();
  // keep the DVM's order
  const ordered = refs.ids.map((id) => byId.get(id)).filter((n): n is FeedNote => !!n);
  const extra = evs.filter((e) => !refs.ids.includes(e.id)).map(toNote);
  return [...ordered, ...extra].filter((n) => !muted.has(n.pubkey));
}

/** The provider's newest public result. Read-only: works for guests, signs nothing. */
export async function latestDvmResult(def: FeedDef): Promise<{ notes: FeedNote[]; at: number } | null> {
  const relays = FEED_STORE_RELAYS;
  const evs = await queryAll(relays, [{ kinds: [KIND_DVM_RESULT], authors: [def.pubkey], since: now() - 3 * 86400, limit: 10 }], 6000);
  for (const e of evs.sort((a, b) => b.created_at - a.created_at)) {
    const refs = resultRefs(e);
    if (!refs.ids.length && !refs.addrs.length) continue; // encrypted or empty
    return { notes: await fetchRefs(refs), at: e.created_at };
  }
  return null;
}

/** A personal request: signed by the user, answered by the provider. */
export function dvmRequestTemplate(def: FeedDef, me: string, relays: string[]) {
  return {
    kind: KIND_DVM_REQUEST,
    created_at: now(),
    content: '',
    tags: [
      ['p', def.pubkey],
      ['relays', ...relays.filter((r) => !/primal\.net/i.test(r)).slice(0, 5)],
      ['param', 'max_results', '100'],
      ['param', 'user', me],
      ['alt', 'NIP-90 content discovery request'],
    ],
  };
}

/** Wait for the answer to a published request. Payment requests stop it (nothing is paid). */
export function awaitDvmAnswer(requestId: string, def: FeedDef, relays: string[], onStatus: (s: DvmStatus) => void, onNotes: (n: FeedNote[]) => void, timeoutMs = 45_000): () => void {
  let finished = false;
  const closers: (() => void)[] = [];
  const stop = () => { clearTimeout(timer); for (const c of closers) { try { c(); } catch { /* closed */ } } };
  const timer = setTimeout(() => {
    if (finished) return;
    finished = true;
    stop();
    onStatus({ state: 'error', message: 'No answer from the provider yet. Showing its public picks.' });
  }, timeoutMs);
  const filter = { kinds: [KIND_DVM_RESULT, KIND_DVM_FEEDBACK], '#e': [requestId], authors: [def.pubkey] };
  closers.push(subscribeEvents(relays.filter((r) => !/primal\.net/i.test(r)), filter, (ev) => {
    const e = ev as NEvent;
    if (finished) return;
    if (e.kind === KIND_DVM_FEEDBACK) {
      const st = e.tags.find((t) => t[0] === 'status');
      if (st?.[1] === 'payment-required') { finished = true; stop(); onStatus({ state: 'payment', message: 'This provider asks for a payment for personal picks, so nothing was sent. Showing its public picks.' }); }
      else if (st?.[1] === 'error') { finished = true; stop(); onStatus({ state: 'error', message: st[2] || 'The provider could not do it' }); }
      else onStatus({ state: 'waiting', message: st?.[2] || 'Working on it…' });
      return;
    }
    const refs = resultRefs(e);
    if (!refs.ids.length && !refs.addrs.length) return;
    finished = true;
    stop();
    fetchRefs(refs).then((n) => { onNotes(n); onStatus({ state: 'done', at: e.created_at }); });
  }));
  return () => { finished = true; stop(); };
}
