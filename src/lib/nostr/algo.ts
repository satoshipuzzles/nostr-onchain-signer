/**
 * The Nostr Onchain algorithm: a "For you" feed ranked in the browser, no server.
 *
 * Candidates come from the people you follow, the people they follow (web of trust), what your
 * network liked / reposted / zapped in the last day or two, notes trending with real engagement,
 * and the on-chain topics this suite is about. Each note is scored on who engaged with it (your
 * network counts far more than strangers), how much (zaps by sats, real replies over bare "+"),
 * how fresh it is and whether it has media; junk is dropped and spammy notes sink. The ranked
 * list is then spread out so no author or topic crowds the page, with some clearly labelled
 * discovery picks mixed in. Every note carries a short "why".
 */
import { streamQuery, outboxRelaysFor, getViewerReadRelays, DEFAULT_RELAYS, INDEXER_RELAYS, type NEvent } from './query';
import { parseZapReceipt } from './zap';
import { resolveProfiles } from './cache';
import { mediaKinds } from './embeds';
import { isReply } from './feed-filters';
import { mutedNow } from './mute';
import { KIND_PICTURE, KIND_VIDEO, KIND_SHORT_VIDEO } from './feed';
import type { FeedNote } from './feed';
import type { ProfileMetadata } from './social';

// ─── preferences ────────────────────────────────────────────────

export interface AlgoTune {
  /** 0 = only people you follow, 1 = lots of new voices */
  discovery: number;
  /** -1 = fewer pictures and videos, 1 = more */
  media: number;
  /** hashtags to boost (on-chain ones by default) */
  topics: string[];
  /** include notes behind a content warning */
  showCW: boolean;
}
export const DEFAULT_TUNE: AlgoTune = { discovery: 0.25, media: 0, topics: ['xbt', 'onchain', 'bip110', 'nostronchain'], showCW: false };

/** "Show less like this": authors and topics the algorithm leaves out (it does not mute them elsewhere). */
export interface ShowLess { authors: string[]; topics: string[] }

const TUNE_KEY = 'algo_tune_v1';
const LESS_KEY = 'algo_less_v1';

export function loadTune(): AlgoTune {
  try { const v = JSON.parse(localStorage.getItem(TUNE_KEY) || 'null'); if (v && typeof v === 'object') return { ...DEFAULT_TUNE, ...v }; } catch { /* blocked */ }
  return { ...DEFAULT_TUNE };
}
export function saveTune(t: Partial<AlgoTune>): AlgoTune {
  const next = { ...loadTune(), ...t };
  try { localStorage.setItem(TUNE_KEY, JSON.stringify(next)); } catch { /* blocked */ }
  return next;
}
export function loadLess(): ShowLess {
  try { const v = JSON.parse(localStorage.getItem(LESS_KEY) || 'null'); if (v && typeof v === 'object') return { authors: v.authors || [], topics: v.topics || [] }; } catch { /* blocked */ }
  return { authors: [], topics: [] };
}
export function saveLess(l: ShowLess): ShowLess {
  try { localStorage.setItem(LESS_KEY, JSON.stringify(l)); } catch { /* blocked */ }
  return l;
}

// ─── constants ──────────────────────────────────────────────────

/** Never promoted: may appear only when followed, and then with no boost. Never in discovery picks or the feed store. */
export const NO_PROMOTE = new Set(['04c915daefee38317fa734444acee390a8269fe5810b2241e5e6dd343dfbecc9']);
/**
 * For guests (and accounts that follow nobody yet): a starter graph built from the follow
 * lists of a few well-connected Bitcoin / Nostr accounts. The people several of them follow
 * become the "follows", and what those people like, zap and repost decides the ranking.
 * Checked on relay.damus.io 2026-10-21 (all have kind 0 and a kind 3 list).
 */
export const SEED_ACCOUNTS = [
  '50de492cfe5472450df1a0176fdf6d915e97cb5d9f8d3eccef7d25ff0a8871de', // ₿igfoot
  '3d1d35447ec2832ac40c2aae56a74ec4998cce528526da6569f076591cf1c932', // Puzzles_Onchain
  '6e468422dfb74a5738702a8823b9b28168abab8655faacb6853cd0ee15deee93', // Gigi
  '32e1827635450ebb3c5a7d12c1f8e7b2b514439ac10a67eef3d9fd9c5c68e245', // jb55
  '3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d', // fiatjaf
  '97c70a44366a6535c145b333f973ea86dfdc2d7a99da618c40c64705ad98e322', // hodlbod
  '3f770d65d3a764a9c5cb503ae123e62ec7598ad035d836e2a810f3877a745b24', // Derek Ross
].filter((pk) => !NO_PROMOTE.has(pk));
/** How many of the seeds' follows make up a guest's starter graph (the most-followed first). */
const SEED_GRAPH_MAX = 400;
const ONCHAIN_TAGS = ['xbt', 'onchain', 'bip110', 'nostronchain', 'bitcoinnotbtc', 'knots', 'blake2b'];
const SPAM_HOSTS = /(surge\.sh|originality|\.sell\.app|gumroad\.com\/l\/|bit\.ly\/|tinyurl\.com|t\.me\/joinchat)/i;
const HOUR = 3600;
/** Notes, plus picture and video posts (NIP-68 / NIP-71), which NoteCard renders from their imeta. */
const CANDIDATE_KINDS = [1, KIND_PICTURE, KIND_VIDEO, KIND_SHORT_VIDEO];
const MEDIA_POST = new Set([KIND_PICTURE, KIND_VIDEO, KIND_SHORT_VIDEO]);

// ─── helpers ────────────────────────────────────────────────────

const toNote = (e: NEvent): FeedNote => ({ id: e.id, pubkey: e.pubkey, content: e.content, created_at: e.created_at, tags: e.tags, kind: e.kind });
const chunk = <T,>(a: T[], n: number) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));
function hashtags(n: { content: string; tags: string[][] }): string[] {
  const s = new Set(n.tags.filter((t) => t[0] === 't' && t[1]).map((t) => t[1].toLowerCase()));
  for (const m of n.content.match(/(^|\s)#[\p{L}\p{N}_]{2,}/gu) || []) s.add(m.trim().slice(1).toLowerCase());
  return [...s];
}
/** The note a reaction / repost / reply points at (last e tag, or the reply marker). */
function targetOf(e: NEvent): string | null {
  const es = e.tags.filter((t) => t[0] === 'e' && t[1]);
  if (!es.length) return null;
  return (es.find((t) => t[3] === 'reply') ?? es[es.length - 1])[1];
}
function fingerprint(text: string): string {
  return text.toLowerCase().replace(/https?:\/\/\S+/g, '').replace(/nostr:\S+/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().slice(0, 140);
}
/** Junk no one wants in a curated feed: presence pings, raw JSON, link-only product spam. */
export function isJunk(n: FeedNote): boolean {
  const c = n.content.trim();
  if (MEDIA_POST.has(n.kind ?? 1)) return !n.tags.some((t) => t[0] === 'imeta' || t[0] === 'url');
  if (!c) return true;
  if (/^[[{]/.test(c)) { try { JSON.parse(c); return true; } catch { /* not JSON */ } }
  if (/"type"\s*:\s*"presence"/.test(c)) return true;
  if (SPAM_HOSTS.test(c)) return true;
  const text = c.replace(/https?:\/\/\S+/g, '').replace(/nostr:\S+/g, '').trim();
  const links = (c.match(/https?:\/\/\S+/g) || []).length;
  if (links >= 1 && text.length < 4 && !mediaKinds(n).size) return true; // a bare link
  return false;
}

// ─── the run ────────────────────────────────────────────────────

export type WhyKind = 'zapped' | 'liked' | 'reposted' | 'replied' | 'network' | 'trending' | 'fof' | 'follow' | 'onchain' | 'new' | 'topic';
export interface Why { kind: WhyKind; text: string }

export interface Ranked {
  note: FeedNote;
  score: number;
  why: Why[];
  /** not from someone you follow */
  discovery: boolean;
  topic?: string;
}

export interface AlgoInput {
  me: string;                 // '' for a guest
  follows: Set<string>;
  muted: Set<string>;
  mutedWords: string[];
  tune: AlgoTune;
  less: ShowLess;
  /** notes / replies switch */
  includeReplies: boolean;
}

interface Signals {
  zapSats: number; zapFrom: Set<string>; likes: Set<string>; reposts: Set<string>; replies: Map<string, number>; // replier -> text length
}

interface Pool {
  at: number;
  key: string;
  notes: Map<string, FeedNote>;
  signals: Map<string, Signals>;
  wot: Map<string, number>;     // follows-of-follows: pubkey -> how many follows follow them
  follows: Set<string>;
  profiles: Map<string, ProfileMetadata>;
  since: number;
  /** no follows of your own: the follows are the seed accounts' */
  seeded: boolean;
}

const poolCache = new Map<string, Pool>();
const wotCache = new Map<string, { at: number; wot: Map<string, number>; follows: Set<string> }>();

function sig(m: Map<string, Signals>, id: string): Signals {
  let s = m.get(id);
  if (!s) { s = { zapSats: 0, zapFrom: new Set(), likes: new Set(), reposts: new Set(), replies: new Map() }; m.set(id, s); }
  return s;
}

/** Follows-of-follows from the follows' own kind-3 lists. For a guest the follows are the seed accounts' follows. */
async function webOfTrust(me: string, follows: Set<string>, relays: string[]): Promise<{ wot: Map<string, number>; follows: Set<string> }> {
  const key = me || 'guest';
  const hit = wotCache.get(key);
  if (hit && Date.now() - hit.at < 15 * 60_000 && (me ? hit.follows.size === follows.size : true)) return hit;
  let base = follows;
  if (!me || base.size === 0) {
    // the people most of the seed accounts follow (newest list per seed), capped so the
    // second hop stays a handful of queries
    const lists = await queryOnce(relays, [{ kinds: [3], authors: SEED_ACCOUNTS }], 5000);
    const newest = new Map<string, NEvent>();
    for (const e of lists) { const p = newest.get(e.pubkey); if (!p || p.created_at < e.created_at) newest.set(e.pubkey, e); }
    const hits = new Map<string, number>();
    for (const e of newest.values()) {
      for (const pk of new Set(e.tags.filter((t) => t[0] === 'p' && /^[0-9a-f]{64}$/.test(t[1] || '')).map((t) => t[1]))) {
        if (!NO_PROMOTE.has(pk)) hits.set(pk, (hits.get(pk) ?? 0) + 1);
      }
    }
    const ranked = [...hits.entries()].sort((a, b) => b[1] - a[1]).map(([pk]) => pk);
    base = new Set([...SEED_ACCOUNTS, ...ranked.slice(0, SEED_GRAPH_MAX)]);
  }
  const counts = new Map<string, number>();
  const lists = (await Promise.all(chunk([...base], 150).map((authors) => queryOnce(relays, [{ kinds: [3], authors }], 6000)))).flat();
  const latest = new Map<string, NEvent>();
  for (const e of lists) { const p = latest.get(e.pubkey); if (!p || p.created_at < e.created_at) latest.set(e.pubkey, e); }
  for (const e of latest.values()) {
    for (const t of e.tags) {
      const pk = t[0] === 'p' ? t[1] : '';
      if (!pk || pk === me || base.has(pk) || !/^[0-9a-f]{64}$/.test(pk)) continue;
      counts.set(pk, (counts.get(pk) ?? 0) + 1);
    }
  }
  const out = { at: Date.now(), wot: counts, follows: base };
  wotCache.set(key, out);
  return out;
}

function queryOnce(relays: string[], filters: Parameters<typeof streamQuery>[0]['filters'], timeoutMs: number, onEvent?: (e: NEvent) => void): Promise<NEvent[]> {
  return new Promise((resolve) => {
    streamQuery({ relays, filters, timeoutMs, onEvent, onDone: resolve });
  });
}

/**
 * Gather candidates and signals, calling onProgress with a fresh ranking as data lands
 * (first after the follows' notes arrive, last when everything is in). Returns a cancel.
 */
export function runAlgo(input: AlgoInput, onProgress: (ranked: Ranked[], done: boolean) => void, opts: { window?: number } = {}): () => void {
  let cancelled = false;
  const windowSecs = (opts.window ?? 36) * HOUR;
  const key = `${input.me || 'guest'}:${input.follows.size}`;
  const cached = poolCache.get(key);
  if (cached && Date.now() - cached.at < 5 * 60_000) {
    setTimeout(() => { if (!cancelled) onProgress(rank(cached, input), true); }, 0);
    return () => { cancelled = true; };
  }

  (async () => {
    const viewer = await getViewerReadRelays().catch(() => DEFAULT_RELAYS);
    const base = [...new Set([...viewer.slice(0, 5), ...DEFAULT_RELAYS, 'wss://relay.ditto.pub'])].filter((r) => !/primal\.net/i.test(r)).slice(0, 9);
    const indexers = [...new Set([...INDEXER_RELAYS, 'wss://relay.damus.io', 'wss://relay.ditto.pub'])];
    const since = Math.floor(Date.now() / 1000) - windowSecs;
    const seeded = !input.me || input.follows.size === 0;

    // Your follows' notes and what they engaged with start at once on the usual relays, so
    // the first notes show in a second or two; the web of trust and the follows' own
    // (outbox) relays are worked out alongside and fill in more as they land.
    const pool: Pool = { at: Date.now(), key, notes: new Map(), signals: new Map(), wot: new Map(), follows: seeded ? new Set() : input.follows, profiles: new Map(), since, seeded };
    let lastEmit = 0;
    let pendingEmit: ReturnType<typeof setTimeout> | null = null;
    const emit = (done = false) => {
      if (cancelled) return;
      const now = Date.now();
      if (!done && now - lastEmit < 700) {
        if (!pendingEmit) pendingEmit = setTimeout(() => { pendingEmit = null; emit(); }, 700);
        return;
      }
      lastEmit = now;
      onProgress(rank(pool, input), done);
    };
    const addNote = (e: NEvent) => { if (CANDIDATE_KINDS.includes(e.kind) && !pool.notes.has(e.id)) { pool.notes.set(e.id, toNote(e)); if (pool.follows.has(e.pubkey)) emit(); } };
    const addSignal = (e: NEvent) => {
      if (e.kind === 9735) {
        const z = parseZapReceipt(e);
        if (!z?.eventId) return;
        const s = sig(pool.signals, z.eventId);
        if (z.sender && s.zapFrom.has(z.sender)) return;
        s.zapSats += z.amountSats;
        s.zapFrom.add(z.sender || `anon-${e.id}`);
        return;
      }
      const t = targetOf(e);
      if (!t) return;
      const s = sig(pool.signals, t);
      if (e.kind === 7) s.likes.add(e.pubkey);
      else if (e.kind === 6 || e.kind === 16) s.reposts.add(e.pubkey);
      else if (e.kind === 1 && isReply(toNote(e))) s.replies.set(e.pubkey, Math.max(s.replies.get(e.pubkey) ?? 0, e.content.replace(/nostr:\S+/g, '').trim().length));
    };

    const wotP = webOfTrust(input.me, input.follows, indexers);
    let follows = pool.follows;
    if (seeded) { follows = (await wotP).follows; pool.follows = follows; }
    if (cancelled) return;
    const followList = [...follows];

    const fromFollows = (relays: string[]) => Promise.all(chunk(followList, 250).map((authors) => queryOnce(relays, [
      { kinds: CANDIDATE_KINDS, authors, since, limit: 400 },
      { kinds: [7, 6, 16], authors, since, limit: 600 },
    ], 7000, (e) => { if (CANDIDATE_KINDS.includes(e.kind)) { addNote(e); if (e.kind === 1 && isReply(toNote(e))) addSignal(e); } else addSignal(e); })));
    const zapsFrom = (relays: string[]) => queryOnce(relays, chunk(followList, 250).map((P) => ({ kinds: [9735], '#P': P, since, limit: 400 })), 7000, addSignal);

    const followNotes = fromFollows(base).then(() => emit());
    const signals = Promise.resolve();
    const zaps = zapsFrom(base);

    // alongside: web of trust, outbox relays, trending and topics
    const later = (async () => {
      const { wot } = await wotP;
      pool.wot = wot;
      if (cancelled) return;
      const outbox = await outboxRelaysFor(followList.slice(0, 400), 5).catch(() => [] as string[]);
      const extra = outbox.filter((r) => !base.includes(r) && !/primal\.net/i.test(r));
      const relays = [...base, ...extra].slice(0, 12);
      const topWot = [...wot.entries()].filter(([, c]) => c >= (follows.size > 40 ? 2 : 1)).sort((x, y) => y[1] - x[1]).slice(0, 250).map(([pk]) => pk);
      const topics = [...new Set([...ONCHAIN_TAGS, ...input.tune.topics.map((t) => t.toLowerCase().replace(/^#/, ''))])].slice(0, 12);
      await Promise.all([
        extra.length ? fromFollows(extra) : Promise.resolve(),
        extra.length ? zapsFrom(extra) : Promise.resolve(),
        topWot.length ? Promise.all(chunk(topWot, 200).map((authors) => queryOnce(relays, [{ kinds: CANDIDATE_KINDS, authors, since, limit: 250 }], 7000, addNote))) : Promise.resolve(),
        queryOnce(['wss://relay.damus.io', 'wss://relay.ditto.pub', 'wss://nos.lol', 'wss://relay.snort.social'], [{ kinds: CANDIDATE_KINDS, since: Math.floor(Date.now() / 1000) - 12 * HOUR, limit: 250 }], 6000, addNote),
        queryOnce(relays, [{ kinds: CANDIDATE_KINDS, '#t': topics, since: Math.floor(Date.now() / 1000) - 3 * windowSecs, limit: 150 }], 6000, addNote),
      ]);
      return relays;
    })();
    await Promise.all([followNotes, signals, zaps]);
    if (cancelled) return;
    emit();
    const relays = (await later) || base;
    if (cancelled) return;
    // the notes your network engaged with that we don't have yet
    const missing = [...pool.signals.keys()].filter((id) => !pool.notes.has(id)).slice(0, 300);
    await Promise.all(chunk(missing, 150).map((ids) => queryOnce(relays, [{ ids }], 6000, addNote)));
    if (cancelled) return;
    emit();

    // 4) engagement from everyone on the strongest non-network candidates (trending check)
    const prelim = rank(pool, input).slice(0, 160).map((r) => r.note.id);
    const engagement = await Promise.all(chunk(prelim, 80).map((ids) => queryOnce(relays, [
      { kinds: [7, 6, 16], '#e': ids, limit: 1500 },
      { kinds: [9735], '#e': ids, limit: 600 },
      { kinds: [1], '#e': ids, limit: 800 },
    ], 6000)));
    for (const e of engagement.flat()) addSignal(e);

    // 5) profiles of the likely authors (bot flag, "has a profile")
    const authors = [...new Set(rank(pool, input).slice(0, 220).map((r) => r.note.pubkey))];
    pool.profiles = await resolveProfiles(authors, relays.slice(0, 6)).catch(() => new Map());
    if (cancelled) return;
    pool.at = Date.now();
    poolCache.set(key, pool);
    emit(true);
  })().catch((err) => { console.error('algo', err); if (!cancelled) onProgress([], true); });

  return () => { cancelled = true; };
}

/** Drop the cached pool (pull to refresh). */
export function clearAlgoCache(): void { poolCache.clear(); }

// ─── scoring ────────────────────────────────────────────────────

function trust(pk: string, pool: Pool, me: string): number {
  if (pk === me) return 0;
  if (pool.follows.has(pk)) return 1;
  const c = pool.wot.get(pk) ?? 0;
  if (c) return 0.25 + 0.5 * Math.min(1, c / 6);
  return 0.08;
}

function rank(pool: Pool, input: AlgoInput): Ranked[] {
  const now = Math.floor(Date.now() / 1000);
  // blocked / muted now (also changes made after the pool was built), not just at the start
  const muted = new Set([...input.muted, ...mutedNow()]);
  const less = { a: new Set(input.less.authors), t: new Set(input.less.topics.map((t) => t.toLowerCase())) };
  const boostTopics = new Set(input.tune.topics.map((t) => t.toLowerCase().replace(/^#/, '')));
  const seenText = new Set<string>();
  const scored: Ranked[] = [];

  const notes = [...pool.notes.values()].sort((a, b) => b.created_at - a.created_at);
  for (const n of notes) {
    if (n.pubkey === input.me) continue;
    if (muted.has(n.pubkey) || less.a.has(n.pubkey)) continue;
    const followed = pool.follows.has(n.pubkey);
    if (NO_PROMOTE.has(n.pubkey) && !(input.me && pool.follows.has(n.pubkey))) continue;
    const reply = isReply(n);
    if (reply && !input.includeReplies) continue;
    if (isJunk(n)) continue;
    const tags = hashtags(n);
    if (tags.some((t) => less.t.has(t))) continue;
    if (tags.length > 8) continue;
    const cw = n.tags.some((t) => t[0] === 'content-warning' || (t[0] === 'L' && /nsfw/i.test(t[1] || '')) || (t[0] === 't' && /^nsfw$/i.test(t[1] || '')));
    if (cw && !input.tune.showCW) continue;
    if (input.mutedWords.length) { const lc = n.content.toLowerCase(); if (input.mutedWords.some((w) => w && lc.includes(w.toLowerCase()))) continue; }
    const prof = pool.profiles.get(n.pubkey);
    if (prof?.bot) continue;
    const fp = fingerprint(n.content);
    if (fp.length > 12) { if (seenText.has(fp)) continue; seenText.add(fp); }
    const age = now - n.created_at;
    if (age < -600) continue;                         // from the future
    if (age > now - pool.since + 72 * HOUR) continue;  // topic notes may reach back a little further

    // engagement, weighted by who gave it
    const s = pool.signals.get(n.id);
    let E = 0;
    let netLikes = 0, netReposts = 0, netReplies = 0, netZappers = 0, netZapSats = 0;
    if (s) {
      for (const pk of s.likes) { if (muted.has(pk)) continue; const w = trust(pk, pool, input.me); E += 1 * w; if (pool.follows.has(pk)) netLikes++; }
      for (const pk of s.reposts) { if (muted.has(pk)) continue; const w = trust(pk, pool, input.me); E += 2 * w; if (pool.follows.has(pk)) netReposts++; }
      for (const [pk, len] of s.replies) { if (muted.has(pk)) continue; const w = trust(pk, pool, input.me); E += (len >= 12 ? 3 : 1) * w; if (pool.follows.has(pk)) netReplies++; }
      if (s.zapSats > 0) {
        let wz = 0;
        for (const pk of s.zapFrom) { if (muted.has(pk)) continue; const w = trust(pk, pool, input.me); wz = Math.max(wz, w); if (pool.follows.has(pk)) netZappers++; }
        const zapW = (1 + Math.log10(1 + s.zapSats)) * 1.5 * Math.max(wz, 0.08) * Math.max(1, Math.sqrt(s.zapFrom.size));
        E += zapW;
        if (netZappers) netZapSats = s.zapSats;
      }
    }

    const wotCount = pool.wot.get(n.pubkey) ?? 0;
    const authorBase = followed ? 2 : wotCount ? 0.6 + 0.6 * Math.min(1, wotCount / 6) : 0.25;
    const halfLifeH = 10;
    const recency = Math.pow(0.5, Math.max(0, age) / (halfLifeH * HOUR));
    const media = mediaKinds(n);
    const words = n.content.replace(/https?:\/\/\S+/g, '').trim().split(/\s+/).filter(Boolean).length;
    let quality = 1;
    if (tags.length > 4) quality *= 0.35;
    if (words < 3 && !media.size && !MEDIA_POST.has(n.kind ?? 1)) quality *= 0.4;
    if (!followed && !prof && pool.profiles.size) quality *= 0.5;   // no profile at all
    if (reply) quality *= 0.6;
    const hasMedia = MEDIA_POST.has(n.kind ?? 1) || media.has('image') || media.has('video') || media.has('audio');
    let boost = 1;
    if (hasMedia) boost *= 1.25 + 0.35 * input.tune.media;          // media -1 → 0.9, 0 → 1.25, 1 → 1.6
    else if (input.tune.media < 0) boost *= 1 + 0.2 * -input.tune.media;
    if (s && s.replies.size >= 2) boost *= 1.15;                  // a conversation
    else if (/\?\s*$/.test(n.content.trim()) && words >= 5) boost *= 1.08;
    const onchain = tags.some((t) => ONCHAIN_TAGS.includes(t));
    const boosted = tags.find((t) => boostTopics.has(t));
    if (onchain) boost *= 1.2;
    if (boosted && !onchain) boost *= 1.15;

    let score = (authorBase + Math.log2(1 + E) * 2.2) * recency * quality * boost;
    if (NO_PROMOTE.has(n.pubkey)) score = authorBase * recency * 0.5;   // followed: present, never pushed

    // why
    const why: Why[] = [];
    const G = pool.seeded; // guest: the "network" is the Bitcoin starter graph, not people you follow
    if (netZappers) why.push({ kind: 'zapped', text: G ? `Zapped ${(s?.zapSats ?? 0).toLocaleString()} sats by Bitcoiners` : netZappers === 1 ? `Zapped ${netZapSats.toLocaleString()} sats by someone you follow` : `Zapped by ${netZappers} people you follow` });
    else if (s && s.zapSats >= 1000) why.push({ kind: 'zapped', text: `${s.zapSats.toLocaleString()} sats in zaps` });
    if (netReposts) why.push({ kind: 'reposted', text: G ? (netReposts === 1 ? 'Reposted by a Bitcoiner' : `Reposted by ${netReposts} Bitcoiners`) : netReposts === 1 ? 'Reposted by someone you follow' : `Reposted by ${netReposts} you follow` });
    if (netLikes >= 2) why.push({ kind: 'liked', text: G ? `Liked by ${netLikes} Bitcoiners` : `Liked by ${netLikes} people you follow` });
    if (netReplies >= 2) why.push({ kind: 'replied', text: G ? `${netReplies} Bitcoiners replied` : `${netReplies} people you follow replied` });
    if (!why.length && E >= 6 && !netLikes) why.push({ kind: followed || wotCount ? 'network' : 'trending', text: followed || wotCount ? (G ? 'Popular with Bitcoiners' : 'Popular with your network') : 'Trending' });
    if (!followed && wotCount) why.push({ kind: 'fof', text: G ? (wotCount === 1 ? 'Followed by a Bitcoiner' : `Followed by ${wotCount} Bitcoiners`) : wotCount === 1 ? 'Followed by someone you follow' : `Followed by ${wotCount} people you follow` });
    if (!followed && !wotCount && !why.some((w) => w.kind === 'trending')) why.push({ kind: 'new', text: 'New voice' });
    if (onchain) why.push({ kind: 'onchain', text: 'On-chain' });
    else if (boosted) why.push({ kind: 'topic', text: `#${boosted}` });
    if (followed && why.length === 0) why.push({ kind: 'follow', text: G ? 'Popular with Bitcoiners' : 'From someone you follow' });

    scored.push({ note: n, score, why: why.slice(0, 2), discovery: !followed, topic: tags[0] });
  }
  return diversify(scored.sort((a, b) => b.score - a.score), input.tune.discovery);
}

/**
 * Spread the ranking out: at most 2 notes per author and 3 per topic in any 20-note window,
 * and roughly `discovery` of each 10 from outside your follows (when good ones exist).
 */
export function diversify(sorted: Ranked[], discovery: number): Ranked[] {
  const out: Ranked[] = [];
  const pools = { follow: sorted.filter((r) => !r.discovery), other: sorted.filter((r) => r.discovery) };
  const share = Math.min(0.6, Math.max(0, discovery));
  const window = (key: (r: Ranked) => string | undefined, v: string | undefined) => v ? out.slice(-19).filter((r) => key(r) === v).length : 0;
  const fits = (r: Ranked) => window((x) => x.note.pubkey, r.note.pubkey) < 2 && window((x) => x.topic, r.topic) < 3;
  const take = (list: Ranked[]) => { const i = list.findIndex(fits); return i < 0 ? null : list.splice(i, 1)[0]; };
  while (pools.follow.length || pools.other.length) {
    const recent = out.slice(-10);
    const otherShare = recent.length ? recent.filter((r) => r.discovery).length / recent.length : 0;
    const topF = pools.follow.find(fits), topO = pools.other.find(fits);
    let pick: Ranked | null = null;
    if (topO && (!topF || (otherShare < share && topO.score >= 0.3 * topF.score) || topO.score > topF.score * (1.6 - share))) pick = take(pools.other);
    if (!pick) pick = take(pools.follow) ?? take(pools.other);
    if (!pick) {
      // only crowded authors/topics left: append them in score order at the end
      out.push(...[...pools.follow, ...pools.other].sort((a, b) => b.score - a.score));
      break;
    }
    out.push(pick);
  }
  return out;
}
