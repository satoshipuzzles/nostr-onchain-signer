/**
 * Notifications: what other people did to you on Nostr, read straight from relays.
 *
 * Everything that tags the viewer with a "p" tag, from their inbox relays (NIP-65 read
 * relays, where others are expected to tag them), their write relays and the defaults:
 *
 *   kind 1 / 1111   a reply to one of your notes, or a mention
 *   kind 6 / 16     a repost of your note
 *   kind 7          a reaction (like / emoji)
 *   kind 9735       a zap receipt (the sender is in the embedded zap request)
 *   kind 9802       a highlight of your writing
 *   kind 3          a contact list that just added you (you are among its last entries)
 *
 * Reactions, reposts and zaps on the same note are grouped into one row. "Unread" is
 * anything newer than the last time the page was opened, kept per account on the device.
 */
import { useEffect, useState } from 'react';
import { relaysForAuthor, streamQuery, type NEvent } from './query';
import { subscribeEvents } from './feed';
import { mutedNow } from './mute';
import { parseZapReceipt } from './zap';

export type NotifType = 'reply' | 'mention' | 'repost' | 'reaction' | 'zap' | 'highlight' | 'follow';

export interface NotifActor {
  pubkey: string;
  at: number;
  /** the reaction's emoji, the zap's amount */
  emoji?: string;
  sats?: number;
  comment?: string;
  anonymous?: boolean;
}

export interface Notif {
  /** grouping key: "<type>:<target>" for grouped kinds, else the event id */
  key: string;
  type: NotifType;
  /** newest activity in the group */
  at: number;
  /** your note this is about (reactions, reposts, zaps, replies) */
  target?: string;
  /** the event itself, for replies / mentions / highlights */
  event?: NEvent;
  actors: NotifActor[];
  totalSats: number;
}

const DAY = 86400;
const now = () => Math.floor(Date.now() / 1000);
const isHex = (s: string) => /^[0-9a-f]{64}$/.test(s);

const SEEN_KEY = (pk: string) => `nostronchain_notifs_seen_v1_${pk}`;
const seenListeners = new Set<() => void>();

export function lastSeen(pubkey: string): number {
  try { return Number(localStorage.getItem(SEEN_KEY(pubkey))) || 0; } catch { return 0; }
}
export function markSeen(pubkey: string, at = now()) {
  try { localStorage.setItem(SEEN_KEY(pubkey), String(at)); } catch { /* blocked storage */ }
  for (const fn of seenListeners) fn();
}

/** The note a reply / reaction / repost / zap points at (NIP-10 reply marker, else the last e tag). */
function targetOf(e: NEvent): string | undefined {
  const es = e.tags.filter((t) => (t[0] === 'e' || t[0] === 'E') && isHex(t[1] || ''));
  if (!es.length) return undefined;
  return (es.find((t) => t[3] === 'reply') ?? es.find((t) => t[3] === 'root') ?? es[es.length - 1])[1];
}

export function classify(e: NEvent, me: string): { type: NotifType; target?: string; actor: NotifActor } | null {
  if (e.pubkey === me && e.kind !== 9735) return null;
  const actor: NotifActor = { pubkey: e.pubkey, at: e.created_at };
  switch (e.kind) {
    case 1:
    case 1111: {
      const target = targetOf(e);
      return { type: target ? 'reply' : 'mention', target, actor };
    }
    case 6:
    case 16:
      return { type: 'repost', target: targetOf(e), actor };
    case 7:
      return { type: 'reaction', target: targetOf(e), actor: { ...actor, emoji: !e.content || e.content === '+' ? '❤️' : e.content === '-' ? '👎' : e.content.slice(0, 16) } };
    case 9802:
      return { type: 'highlight', target: targetOf(e), actor };
    case 3: {
      // A contact list re-tags you every time its owner changes it, so only count it as a
      // new follow when you are near the end (clients append new follows)
      const ps = e.tags.filter((t) => t[0] === 'p').map((t) => t[1]);
      return ps.slice(-3).includes(me) ? { type: 'follow', actor } : null;
    }
    case 9735: {
      const z = parseZapReceipt(e);
      if (!z || z.recipient !== me || z.sender === me) return null;
      return {
        type: 'zap', target: z.eventId ?? undefined,
        actor: { pubkey: z.anonymous ? '' : z.sender, at: e.created_at, sats: z.amountSats, comment: z.comment, anonymous: z.anonymous },
      };
    }
    default:
      return null;
  }
}

const GROUPED: NotifType[] = ['reaction', 'repost', 'zap'];

/** Turn a pile of events into rows, newest first. */
export function groupNotifs(events: NEvent[], me: string, myNoteIds?: Set<string>): Notif[] {
  const muted = mutedNow();
  const rows = new Map<string, Notif>();
  const followers = new Set<string>();
  for (const e of [...events].sort((a, b) => b.created_at - a.created_at)) {
    if (muted.has(e.pubkey)) continue;
    const c = classify(e, me);
    if (!c) continue;
    // a reply in a thread you're only tagged in is a mention, not a reply to you
    if (c.type === 'reply' && myNoteIds && c.target && !myNoteIds.has(c.target)) c.type = 'mention';
    if (c.type === 'follow') {
      // a contact list is replaceable: only the newest per person, once
      if (followers.has(e.pubkey)) continue;
      followers.add(e.pubkey);
    }
    const grouped = GROUPED.includes(c.type);
    const key = grouped ? `${c.type}:${c.target ?? 'profile'}` : c.type === 'follow' ? `follow:${e.pubkey}` : e.id;
    let row = rows.get(key);
    if (!row) {
      row = { key, type: c.type, at: e.created_at, target: c.target, event: grouped || c.type === 'follow' ? undefined : e, actors: [], totalSats: 0 };
      rows.set(key, row);
    }
    if (!row.actors.some((a) => a.pubkey && a.pubkey === c.actor.pubkey && c.type !== 'zap')) row.actors.push(c.actor);
    row.totalSats += c.actor.sats ?? 0;
  }
  return [...rows.values()].sort((a, b) => b.at - a.at);
}

export interface NotifState {
  rows: Notif[];
  events: NEvent[];
  done: boolean;
}

function filtersFor(me: string, since: number) {
  return [
    { kinds: [1, 1111, 6, 16, 7, 9802], '#p': [me], since, limit: 400 },
    { kinds: [9735], '#p': [me], since, limit: 200 },
    { kinds: [3], '#p': [me], since, limit: 60 },
  ];
}

/**
 * Stream your notifications from the last `days`, then keep listening for new ones.
 * Returns a cancel.
 */
export function streamNotifications(me: string, onUpdate: (s: NotifState) => void, days = 30): () => void {
  let cancelled = false;
  const byId = new Map<string, NEvent>();
  const myNotes = new Set<string>();
  let done = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const closers: (() => void)[] = [];
  const emit = () => {
    if (cancelled) return;
    const events = [...byId.values()];
    onUpdate({ rows: groupNotifs(events, me, myNotes), events, done });
  };
  const soon = () => { if (!timer) timer = setTimeout(() => { timer = null; emit(); }, 250); };
  const add = (e: NEvent) => { if (!byId.has(e.id)) { byId.set(e.id, e); soon(); } };

  (async () => {
    const relays = await relaysForAuthor(me, { inbox: true }).catch(() => [] as string[]);
    if (cancelled) return;
    const since = now() - days * DAY;
    // your own recent notes, so a reply to you can be told from a mention in someone else's thread
    closers.push(streamQuery({
      relays, filters: [{ kinds: [1, 20, 21, 22, 30023, 1111], authors: [me], since, limit: 500 }], timeoutMs: 8000,
      onEvent: (e) => { myNotes.add(e.id); soon(); },
    }));
    closers.push(streamQuery({
      relays, filters: filtersFor(me, since), timeoutMs: 9000,
      onEvent: add,
      onDone: () => {
        if (cancelled) return;
        done = true;
        emit();
        // live from here on
        for (const f of filtersFor(me, now() - 60)) {
          closers.push(subscribeEvents(relays, f as Parameters<typeof subscribeEvents>[1], (e) => add(e as unknown as NEvent)));
        }
      },
    }));
  })();
  return () => {
    cancelled = true;
    if (timer) clearTimeout(timer);
    for (const c of closers) { try { c(); } catch { /* closed */ } }
  };
}

/**
 * How many notifications arrived since you last looked, for the badge on the nav.
 * Keeps one live subscription per account; nothing is fetched for guests.
 */
export function useUnreadNotifications(me: string): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (!me) { setCount(0); return; }
    let latest: NEvent[] = [];
    const recount = () => {
      const seen = lastSeen(me);
      setCount(groupNotifs(latest.filter((e) => e.created_at > seen), me).length);
    };
    seenListeners.add(recount);
    const stop = streamNotifications(me, (s) => { latest = s.events; recount(); }, 7);
    return () => { seenListeners.delete(recount); stop(); };
  }, [me]);
  return count;
}
