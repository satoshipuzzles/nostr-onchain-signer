/**
 * Nostr feed: filters, subscriptions, and the small pure helpers the feed
 * page needs (repost unpacking, long-form metadata, engagement tallies).
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
  since?: number;
}

export const KIND_REPOST = 6;
export const KIND_LONG_FORM = 30023;

/** Hashtag chips offered on the #Tags tab. */
export const PRESET_HASHTAGS = ['xbt', 'bitcoin', 'nostr', 'knots'];

/** Hashtags that put an ordinary note on the On-chain tab. */
export const ONCHAIN_HASHTAGS = ['xbt', 'btcb2', 'blake2b', 'onchain', 'nostronchain', 'opreturn', 'bip110'];

/** How many notes the page keeps in memory before "Load older" stops. */
export const FEED_MAX_NOTES = 400;
export const FEED_PAGE_SIZE = 40;

const IMAGE_REGEX = /https?:\/\/\S+\.(jpg|jpeg|png|gif|webp)(\?\S*)?/i;

/**
 * One relay filter per feed mode. Following and hashtag feeds include
 * reposts and long-form posts; Global stays kind 1 so it is readable.
 * The On-chain tab needs two filters (tagged notes + invoice events), so
 * it is expressed as a list.
 */
export function buildNostrFilters(filter: FeedFilter): Filter[] {
  const limit = filter.limit ?? FEED_PAGE_SIZE;
  const base: Filter = { limit };
  if (filter.until) base.until = filter.until;
  if (filter.since) base.since = filter.since;

  const recentSince = Math.floor(Date.now() / 1000) - 30 * 86400;

  switch (filter.mode) {
    case 'global':
      return [{ ...base, kinds: [1], since: filter.since ?? recentSince }];
    case 'following':
      if (!filter.pubkeys?.length) return [];
      return [{ ...base, kinds: [1, KIND_REPOST, KIND_LONG_FORM], authors: filter.pubkeys }];
    case 'media':
      return [{ ...base, kinds: [1] }];
    case 'onchain':
      return [
        { ...base, kinds: [1, KIND_LONG_FORM], '#t': ONCHAIN_HASHTAGS },
        { ...base, kinds: [CUSTOM_KIND.ONCHAIN_INVOICE] },
      ];
    case 'hashtag': {
      const tag = (filter.hashtag ?? '').toLowerCase().replace(/^#/, '').trim();
      if (!tag) return [];
      return [{ ...base, kinds: [1, KIND_LONG_FORM], '#t': [tag] }];
    }
    case 'kind':
      return [{ ...base, kinds: [filter.kind ?? 1] }];
    default:
      return [{ ...base, kinds: [1] }];
  }
}

function passesClientFilter(note: FeedNote, filter: FeedFilter): boolean {
  if (filter.mode === 'media') return IMAGE_REGEX.test(note.content);
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

/**
 * Subscribe to a feed. Opens one relay subscription per filter the mode
 * needs and reports EOSE once every one of them has settled. Events are
 * deduplicated across the filters.
 */
export function subscribeFeed(
  relayUrls: string[],
  filter: FeedFilter,
  onNote: (note: FeedNote) => void,
  onEose?: () => void,
): () => void {
  const filters = buildNostrFilters(filter);
  if (filters.length === 0) {
    onEose?.();
    return () => {};
  }

  const seenIds = new Set<string>();
  let pending = filters.length;
  let eoseSent = false;
  const finish = () => {
    pending -= 1;
    if (pending <= 0 && !eoseSent) {
      eoseSent = true;
      onEose?.();
    }
  };

  const closers = filters.map((nostrFilter) =>
    subscribeRelays({
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
      onEose: finish,
    }),
  );

  // Belt and braces: never leave the page waiting if a relay never answers.
  const timer = setTimeout(() => {
    if (!eoseSent) {
      eoseSent = true;
      onEose?.();
    }
  }, 9_000);

  return () => {
    clearTimeout(timer);
    for (const close of closers) close();
  };
}

// ─── Reposts (kind 6) ────────────────────────────────────────────

export interface RepostInfo {
  /** Pubkey of the person who reposted. */
  by: string;
  /** The reposted note, if the repost carried it inline (most clients do). */
  inner: FeedNote | null;
  /** Id of the reposted note, from the e tag, when the content was empty. */
  innerId: string | null;
}

export function parseRepost(note: FeedNote): RepostInfo | null {
  if (note.kind !== KIND_REPOST) return null;
  let inner: FeedNote | null = null;
  const raw = note.content?.trim();
  if (raw && raw.startsWith('{')) {
    try {
      const e = JSON.parse(raw) as Partial<NostrEvent>;
      if (e && typeof e.id === 'string' && typeof e.pubkey === 'string' && typeof e.content === 'string') {
        inner = {
          id: e.id,
          pubkey: e.pubkey,
          content: e.content,
          created_at: Number(e.created_at) || note.created_at,
          tags: Array.isArray(e.tags) ? e.tags : [],
          kind: Number(e.kind) || 1,
        };
      }
    } catch {
      inner = null;
    }
  }
  const eTag = note.tags.find((t) => t[0] === 'e' && t[1]);
  return { by: note.pubkey, inner, innerId: inner?.id ?? eTag?.[1] ?? null };
}

// ─── Long-form (kind 30023) ──────────────────────────────────────

export interface LongFormMeta {
  title: string;
  summary: string;
  image: string | null;
  publishedAt: number;
  /** Plain-text excerpt of the body with the markdown noise stripped. */
  excerpt: string;
}

function stripMarkdown(md: string): string {
  return md
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')     // images
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')  // links -> text
    .replace(/^#{1,6}\s+/gm, '')              // headings
    .replace(/[*_`>~]+/g, '')                 // emphasis, code, quotes
    .replace(/\s+/g, ' ')
    .trim();
}

export function longFormMeta(note: FeedNote): LongFormMeta {
  const tag = (name: string) => note.tags.find((t) => t[0] === name && t[1])?.[1] ?? '';
  const body = stripMarkdown(note.content ?? '');
  const published = parseInt(tag('published_at'), 10);
  return {
    title: tag('title') || body.slice(0, 80) || 'Untitled',
    summary: tag('summary'),
    image: tag('image') || null,
    publishedAt: Number.isFinite(published) && published > 0 ? published : note.created_at,
    excerpt: body.length > 260 ? body.slice(0, 260).replace(/\s+\S*$/, '') + '…' : body,
  };
}

export function isLongForm(note: FeedNote): boolean {
  return note.kind === KIND_LONG_FORM;
}

// ─── Engagement (replies, reposts, reactions, zaps) ──────────────

export interface Engagement {
  replies: number;
  reposts: number;
  reactions: number;
  zapSats: number;
}

export const EMPTY_ENGAGEMENT: Engagement = { replies: 0, reposts: 0, reactions: 0, zapSats: 0 };

/** Sats paid by a kind 9735 zap receipt (0 when it cannot be read). */
export function zapReceiptSats(event: NostrEvent): number {
  let amount = 0;
  const descTag = event.tags.find((t) => t[0] === 'description');
  if (descTag && descTag[1]) {
    try {
      const zapReq = JSON.parse(descTag[1]);
      const amountTag = zapReq.tags?.find((t: string[]) => t[0] === 'amount');
      if (amountTag) amount = Math.floor(parseInt(amountTag[1], 10) / 1000);
    } catch { /* fall through to bolt11 */ }
  }
  if (amount === 0) {
    const bolt11Tag = event.tags.find((t) => t[0] === 'bolt11');
    if (bolt11Tag && bolt11Tag[1]) {
      const match = bolt11Tag[1].match(/lnbc(\d+)([munp]?)/i);
      if (match) {
        const value = parseInt(match[1], 10);
        const unit = match[2];
        if (unit === 'm') amount = value * 100_000;
        else if (unit === 'u') amount = value * 100;
        else if (unit === 'n') amount = Math.floor(value / 10);
        else if (unit === 'p') amount = Math.floor(value / 10_000);
        else amount = value * 100_000_000;
      }
    }
  }
  return Number.isFinite(amount) && amount > 0 ? amount : 0;
}

/**
 * The note a reply / repost / reaction / zap points at. For replies that is
 * the "reply" marked e tag, else the last e tag (NIP-10); for everything
 * else the last e tag.
 */
export function engagementTarget(event: NostrEvent): string | null {
  const eTags = event.tags.filter((t) => t[0] === 'e' && t[1]);
  if (eTags.length === 0) return null;
  if (event.kind === 1) {
    const marked = eTags.find((t) => t[3] === 'reply') ?? eTags.find((t) => t[3] === 'root');
    return (marked ?? eTags[eTags.length - 1])[1];
  }
  return eTags[eTags.length - 1][1];
}

/** Fold one interaction event into the tally map (mutates `into`). */
export function tallyEngagement(event: NostrEvent, into: Map<string, Engagement>): boolean {
  const target = engagementTarget(event);
  if (!target) return false;
  const entry = into.get(target);
  if (!entry) return false;
  if (event.kind === 1) entry.replies += 1;
  else if (event.kind === KIND_REPOST) entry.reposts += 1;
  else if (event.kind === 7) entry.reactions += 1;
  else if (event.kind === 9735) entry.zapSats += zapReceiptSats(event);
  else return false;
  return true;
}

// ─── Feed tab memory ─────────────────────────────────────────────

const TAB_KEY = 'feed_tab_v2';
const HASHTAG_KEY = 'feed_hashtag_v2';

export function loadFeedTab(): FeedMode {
  try {
    const v = localStorage.getItem(TAB_KEY);
    if (v === 'following' || v === 'global' || v === 'onchain' || v === 'hashtag') return v;
  } catch { /* storage unavailable */ }
  return 'following';
}

export function saveFeedTab(mode: FeedMode): void {
  try { localStorage.setItem(TAB_KEY, mode); } catch { /* ignore */ }
}

export function loadFeedHashtag(): string {
  try { return localStorage.getItem(HASHTAG_KEY) ?? ''; } catch { return ''; }
}

export function saveFeedHashtag(tag: string): void {
  try { localStorage.setItem(HASHTAG_KEY, tag); } catch { /* ignore */ }
}

/** Merge, dedupe by id, newest first, dropping muted authors. */
export function mergeNotes(existing: FeedNote[], incoming: FeedNote[], muted: Set<string>): FeedNote[] {
  const byId = new Map<string, FeedNote>();
  for (const n of existing) if (!muted.has(n.pubkey)) byId.set(n.id, n);
  for (const n of incoming) if (!muted.has(n.pubkey)) byId.set(n.id, n);
  return Array.from(byId.values()).sort((a, b) => b.created_at - a.created_at);
}
