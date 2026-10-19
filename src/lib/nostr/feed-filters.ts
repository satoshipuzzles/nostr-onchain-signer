/**
 * What the reader wants to see in feeds and the relay explorer: show only one kind of
 * media, hide replies / reposts / hashtag spam / content warnings / muted words / bots,
 * and whether media plays inline. Applied on the client to whatever has loaded.
 */
import { useEffect, useState } from 'react';
import { mediaKinds } from './embeds';
import type { FeedNote } from './feed';
import type { ProfileMetadata } from './social';

export type ShowOnly = 'all' | 'images' | 'video' | 'audio' | 'links' | 'text';

export interface FeedFilterPrefs {
  only: ShowOnly;
  hideReplies: boolean;
  hideReposts: boolean;
  hideHashtags: boolean;
  /** hide notes with more than this many hashtags; 0 = off */
  maxHashtags: number;
  hideNsfw: boolean;
  hideBots: boolean;
  mutedWords: string[];
  /** show images, players and embeds in the note (off = links only) */
  mediaInline: boolean;
}

export const DEFAULT_FILTERS: FeedFilterPrefs = {
  only: 'all', hideReplies: false, hideReposts: false, hideHashtags: false, maxHashtags: 0,
  hideNsfw: false, hideBots: false, mutedWords: [], mediaInline: true,
};

const KEY = 'nostronchain_feed_filters_v1';

export function loadFilters(): FeedFilterPrefs {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (v && typeof v === 'object') return { ...DEFAULT_FILTERS, ...v, mutedWords: Array.isArray(v.mutedWords) ? v.mutedWords.filter((w: unknown) => typeof w === 'string') : [] };
  } catch { /* blocked storage */ }
  return { ...DEFAULT_FILTERS };
}

const listeners = new Set<(p: FeedFilterPrefs) => void>();
export function saveFilters(p: Partial<FeedFilterPrefs>): FeedFilterPrefs {
  const next = { ...loadFilters(), ...p };
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* blocked storage */ }
  for (const fn of listeners) fn(next);
  return next;
}
export function resetFilters(): FeedFilterPrefs {
  return saveFilters({ ...DEFAULT_FILTERS });
}

/** How many settings differ from the defaults (shown as a badge). */
export function activeFilterCount(p: FeedFilterPrefs): number {
  let n = 0;
  if (p.only !== 'all') n++;
  if (p.hideReplies) n++;
  if (p.hideReposts) n++;
  if (p.hideHashtags) n++;
  if (p.maxHashtags > 0) n++;
  if (p.hideNsfw) n++;
  if (p.hideBots) n++;
  if (p.mutedWords.length) n++;
  if (!p.mediaInline) n++;
  return n;
}

export function useFeedFilters(): { prefs: FeedFilterPrefs; set: (p: Partial<FeedFilterPrefs>) => void; reset: () => void } {
  const [prefs, setPrefs] = useState(loadFilters);
  useEffect(() => {
    const fn = (p: FeedFilterPrefs) => setPrefs(p);
    listeners.add(fn);
    return () => { listeners.delete(fn); };
  }, []);
  return { prefs, set: (p) => setPrefs(saveFilters(p)), reset: () => setPrefs(resetFilters()) };
}

// ─── Notes / Notes & replies, chosen per feed and shown right on it ───

export type ReplyMode = 'notes' | 'both';
const RKEY = 'nostronchain_feed_replies_v1';
const replyListeners = new Set<() => void>();

function loadReplyModes(): Record<string, ReplyMode> {
  try { const v = JSON.parse(localStorage.getItem(RKEY) || 'null'); if (v && typeof v === 'object') return v; } catch { /* blocked storage */ }
  return {};
}
export function replyModeFor(feed: string): ReplyMode {
  return loadReplyModes()[feed] === 'notes' ? 'notes' : 'both';
}
export function setReplyMode(feed: string, m: ReplyMode) {
  const all = loadReplyModes();
  all[feed] = m;
  try { localStorage.setItem(RKEY, JSON.stringify(all)); } catch { /* blocked storage */ }
  for (const fn of replyListeners) fn();
}
/** The feed's choice (default: notes and replies), re-rendering when it changes. */
export function useReplyMode(feed: string): [ReplyMode, (m: ReplyMode) => void] {
  const [m, setM] = useState(() => replyModeFor(feed));
  useEffect(() => {
    setM(replyModeFor(feed));
    const fn = () => setM(replyModeFor(feed));
    replyListeners.add(fn);
    return () => { replyListeners.delete(fn); };
  }, [feed]);
  return [m, (next) => setReplyMode(feed, next)];
}

export function isReply(n: FeedNote): boolean {
  return n.kind === 1111 || (n.kind === 1 && n.tags.some((t) => t[0] === 'e' && t[3] !== 'mention'));
}
function hashtagCount(n: FeedNote): number {
  const tags = new Set(n.tags.filter((t) => t[0] === 't' && t[1]).map((t) => t[1].toLowerCase()));
  for (const m of n.content.match(/(^|\s)#[\p{L}\p{N}_]{2,}/gu) || []) tags.add(m.trim().slice(1).toLowerCase());
  return tags.size;
}

/**
 * Whether a note passes. For a repost, `inner` is the reposted note: media and text
 * filters look at it, while "hide reposts" looks at the wrapper.
 */
export function passesFilters(note: FeedNote, p: FeedFilterPrefs, opts: { inner?: FeedNote | null; profile?: ProfileMetadata } = {}): boolean {
  const isRepost = note.kind === 6 || note.kind === 16;
  if (isRepost && p.hideReposts) return false;
  const n = (isRepost ? opts.inner : note) || note;
  if (p.hideReplies && isReply(n)) return false;
  if (p.hideBots && opts.profile?.bot) return false;
  if (p.hideNsfw && n.tags.some((t) => t[0] === 'content-warning' || (t[0] === 'L' && /nsfw/i.test(t[1] || '')) || (t[0] === 't' && /^nsfw$/i.test(t[1] || '')))) return false;
  if (p.hideHashtags || p.maxHashtags > 0) {
    const c = hashtagCount(n);
    if (p.hideHashtags && c > 0) return false;
    if (p.maxHashtags > 0 && c > p.maxHashtags) return false;
  }
  if (p.mutedWords.length) {
    const text = n.content.toLowerCase();
    if (p.mutedWords.some((w) => w && text.includes(w.toLowerCase()))) return false;
  }
  if (p.only !== 'all') {
    const m = mediaKinds(n);
    if (p.only === 'images' && !m.has('image')) return false;
    if (p.only === 'video' && !m.has('video')) return false;
    if (p.only === 'audio' && !m.has('audio')) return false;
    if (p.only === 'links' && !m.has('link')) return false;
    if (p.only === 'text' && (m.size > 0 || /https?:\/\//.test(n.content))) return false;
  }
  return true;
}
