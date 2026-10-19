/**
 * Reliable reads: outbox-model relay selection, streaming queries, and a
 * cloud fallback.
 *
 * - Relays: the author's NIP-65 (kind 10002) relays, the viewer's own read
 *   relays, and a fixed default set.
 * - Streaming: events are handed to the caller as they arrive; the query ends
 *   when every relay has sent EOSE or the timeout passes, whichever is first.
 * - Cloud fallback: the same query goes to /api/nostr-query in parallel and the
 *   results are merged by id. Networks that block some relays at the TCP
 *   level still see their data. Cloud events are signature-checked here.
 */

import { SimplePool } from 'nostr-tools/pool';
import { verifyEvent } from 'nostr-tools/pure';
import type { Filter } from 'nostr-tools/filter';
import type { Event } from 'nostr-tools';
import { loadRelayList, getReadRelays } from './relays';

export interface NEvent {
  id: string;
  pubkey: string;
  content: string;
  created_at: number;
  tags: string[][];
  kind: number;
  sig?: string;
}

/** Defaults for every read. Never relay.primal.net. */
export const DEFAULT_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.snort.social',
  'wss://nostr.mom',
  'wss://relay.nostronchain.com',
];

/** Relays that index kind 0 / kind 10002 widely. */
export const INDEXER_RELAYS = ['wss://purplepag.es', 'wss://relay.damus.io', 'wss://relay.nostronchain.com'];

/** NIP-50 search relays for people search. */
// relay.ditto.pub answers in ~0.5 s; nostr.band was down and noswhere empty on 2026-10-19
export const PEOPLE_SEARCH_RELAYS = ['wss://relay.ditto.pub', 'wss://search.nos.today', 'wss://relay.noswhere.com', 'wss://relay.nostr.band'];

/** Kinds the cloud fallback accepts (mirrors api/nostr-query.js). */
const CLOUD_KINDS = new Set([0, 1, 3, 6, 7, 1111, 9735, 10002]);

export function normalizeRelay(url: string): string | null {
  if (typeof url !== 'string') return null;
  let u = url.trim();
  if (!u) return null;
  if (!/^wss?:\/\//i.test(u)) return null;
  u = u.replace(/\/+$/, '');
  if (/primal\.net/i.test(u)) return null;
  // ws:// only for local relays; public ws:// is blocked as mixed content anyway
  if (u.toLowerCase().startsWith('ws://') && !/^ws:\/\/(localhost|127\.0\.0\.1)/i.test(u)) return null;
  return u.toLowerCase().startsWith('wss://') ? 'wss://' + u.slice(6).replace(/^([^/]+)/, (h) => h.toLowerCase()) : u;
}

export function cleanRelays(list: (string | undefined | null)[], max = 12): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const r of list) {
    const n = r ? normalizeRelay(r) : null;
    if (!n || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
    if (out.length >= max) break;
  }
  return out;
}

// ─── Pool ────────────────────────────────────────────────────────

let pool: SimplePool | null = null;
function getPool(): SimplePool {
  if (!pool) pool = new SimplePool();
  return pool;
}

// ─── Viewer relays ───────────────────────────────────────────────

let viewerRelaysCache: { at: number; relays: string[] } | null = null;

export async function getViewerReadRelays(): Promise<string[]> {
  if (viewerRelaysCache && Date.now() - viewerRelaysCache.at < 30_000) return viewerRelaysCache.relays;
  let relays: string[] = [];
  try {
    relays = cleanRelays(getReadRelays(await loadRelayList()), 6);
  } catch {
    relays = [];
  }
  viewerRelaysCache = { at: Date.now(), relays };
  return relays;
}

// ─── Cloud fallback ──────────────────────────────────────────────

function cloudEndpoint(): string {
  try {
    const { protocol, hostname } = window.location;
    if (protocol.startsWith('http') && (/(^|\.)nostronchain\.com$/.test(hostname) || hostname.endsWith('.vercel.app'))) {
      return '/api/nostr-query';
    }
  } catch { /* not in a browser */ }
  return 'https://nostronchain.com/api/nostr-query';
}

let cloudDisabledUntil = 0;

function cloudFilters(filters: Filter[]): Filter[] | null {
  const ok = filters.filter((f) => Array.isArray(f.kinds) && f.kinds.length > 0 && f.kinds.every((k) => CLOUD_KINDS.has(k)));
  return ok.length ? ok.map((f) => ({ ...f, limit: Math.min(f.limit ?? 200, 500) })) : null;
}

/** Ask the server to read the relays for us. Resolves [] on any failure. */
export async function cloudQuery(relays: string[], filters: Filter[], timeoutMs = 5000, signal?: AbortSignal): Promise<NEvent[]> {
  if (Date.now() < cloudDisabledUntil) return [];
  const fs = cloudFilters(filters);
  const rs = cleanRelays(relays, 10).filter((r) => r.startsWith('wss://'));
  if (!fs || rs.length === 0) return [];
  try {
    const res = await fetch(cloudEndpoint(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ relays: rs, filters: fs, timeoutMs: Math.min(timeoutMs, 8000) }),
      signal,
    });
    if (res.status === 404) {
      // Endpoint not deployed here (local dev without functions): stop asking for a while
      cloudDisabledUntil = Date.now() + 5 * 60_000;
      return [];
    }
    if (!res.ok) return [];
    const data = await res.json() as { events?: Event[] };
    const out: NEvent[] = [];
    for (const e of data.events ?? []) {
      try {
        if (verifyEvent(e)) out.push(e as unknown as NEvent);
      } catch { /* bad event */ }
    }
    return out;
  } catch {
    return [];
  }
}

// ─── Streaming query ─────────────────────────────────────────────

export interface StreamOptions {
  relays: string[];
  filters: Filter[];
  /** Called once per unique event, as soon as it arrives from anywhere. */
  onEvent?: (event: NEvent) => void;
  /** Called once: every relay sent EOSE (and the cloud answered) or the timeout hit. */
  onDone?: (events: NEvent[]) => void;
  /** Hard stop. Default 7 s. */
  timeoutMs?: number;
  /** Also ask /api/nostr-query. Default true. */
  cloud?: boolean;
  /** Relays for the cloud request; defaults to `relays`. */
  cloudRelays?: string[];
}

/**
 * Query relays and stream results. Returns a cancel function.
 */
export function streamQuery(opts: StreamOptions): () => void {
  const { filters, onEvent, onDone } = opts;
  const timeoutMs = opts.timeoutMs ?? 7000;
  const relays = cleanRelays(opts.relays, 14);
  const events = new Map<string, NEvent>();
  let finished = false;
  let browserDone = relays.length === 0 || filters.length === 0;
  let cloudDone = opts.cloud === false || filters.length === 0;
  const abort = new AbortController();

  const add = (e: NEvent) => {
    if (finished || !e?.id || events.has(e.id)) return;
    events.set(e.id, e);
    try { onEvent?.(e); } catch (err) { console.error(err); }
  };

  const finish = () => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    try { closer?.close(); } catch { /* closed */ }
    onDone?.([...events.values()]);
  };
  const maybeFinish = () => { if (browserDone && cloudDone) finish(); };

  const timer = setTimeout(() => {
    abort.abort();
    finish();
  }, timeoutMs);

  let closer: { close: () => void } | null = null;
  if (!browserDone) {
    try {
      const requests = relays.flatMap((url) => filters.map((filter) => ({ url, filter })));
      closer = getPool().subscribeMap(requests, {
        onevent: (e) => add(e as unknown as NEvent),
        oneose: () => { browserDone = true; maybeFinish(); },
        maxWait: Math.max(1000, timeoutMs - 500),
      });
    } catch {
      browserDone = true;
    }
  }

  if (!cloudDone) {
    // The server waits for its slowest relay, so give it well under our own deadline
    cloudQuery(opts.cloudRelays ?? relays, filters, Math.max(1500, Math.min(Math.round(timeoutMs * 0.55), 4500)), abort.signal)
      .then((list) => { for (const e of list) add(e); })
      .finally(() => { cloudDone = true; maybeFinish(); });
  }

  if (browserDone && cloudDone) setTimeout(finish, 0);

  return () => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    abort.abort();
    try { closer?.close(); } catch { /* closed */ }
  };
}

/** Promise form of streamQuery. */
export function queryEvents(relays: string[], filters: Filter[], opts: Partial<StreamOptions> = {}): Promise<NEvent[]> {
  return new Promise((resolve) => {
    streamQuery({ ...opts, relays, filters, onDone: resolve });
  });
}

// ─── NIP-65 relay lists (outbox model) ──────────────────────────

export interface RelayListInfo {
  read: string[];
  write: string[];
  at: number;
}

const NIP65_KEY = 'nip65_cache_v1';
const NIP65_TTL = 6 * 3600_000;
const nip65Mem = new Map<string, RelayListInfo>();
const nip65Inflight = new Map<string, Promise<RelayListInfo>>();

function readNip65Store(): Record<string, RelayListInfo> {
  try { return JSON.parse(localStorage.getItem(NIP65_KEY) || '{}'); } catch { return {}; }
}

function writeNip65Store(pubkey: string, info: RelayListInfo) {
  try {
    const all = readNip65Store();
    all[pubkey] = info;
    const keys = Object.keys(all);
    if (keys.length > 400) {
      keys.sort((a, b) => all[a].at - all[b].at).slice(0, keys.length - 400).forEach((k) => delete all[k]);
    }
    localStorage.setItem(NIP65_KEY, JSON.stringify(all));
  } catch { /* storage full */ }
}

export function parseRelayList(event: NEvent): RelayListInfo {
  const read: string[] = [];
  const write: string[] = [];
  for (const t of event.tags) {
    if (t[0] !== 'r' || !t[1]) continue;
    const url = normalizeRelay(t[1]);
    if (!url) continue;
    if (!t[2] || t[2] === 'read') read.push(url);
    if (!t[2] || t[2] === 'write') write.push(url);
  }
  return { read, write, at: Date.now() };
}

/** An author's NIP-65 relays (cached 6 h). Empty lists when they have none. */
export function getAuthorRelays(pubkey: string): Promise<RelayListInfo> {
  const mem = nip65Mem.get(pubkey);
  if (mem && Date.now() - mem.at < NIP65_TTL) return Promise.resolve(mem);
  const stored = readNip65Store()[pubkey];
  if (stored && Date.now() - stored.at < NIP65_TTL) {
    nip65Mem.set(pubkey, stored);
    return Promise.resolve(stored);
  }
  const inflight = nip65Inflight.get(pubkey);
  if (inflight) return inflight;
  const p = queryEvents(
    [...INDEXER_RELAYS, ...DEFAULT_RELAYS],
    [{ kinds: [10002], authors: [pubkey], limit: 3 }],
    { timeoutMs: 4500 },
  ).then((evs) => {
    const latest = evs.filter((e) => e.kind === 10002 && e.pubkey === pubkey).sort((a, b) => b.created_at - a.created_at)[0];
    const info = latest ? parseRelayList(latest) : { read: [], write: [], at: Date.now() };
    nip65Mem.set(pubkey, info);
    writeNip65Store(pubkey, info);
    return info;
  }).finally(() => nip65Inflight.delete(pubkey));
  nip65Inflight.set(pubkey, p);
  return p;
}

/**
 * Relays to read an author's events or interactions from:
 * their write relays (where they post) and, when `inbox`, their read relays
 * (where others tag them), plus the viewer's relays and the defaults.
 */
export async function relaysForAuthor(pubkey: string, opts: { inbox?: boolean; hints?: string[] } = {}): Promise<string[]> {
  const [author, viewer] = await Promise.all([
    getAuthorRelays(pubkey).catch(() => ({ read: [], write: [], at: 0 })),
    getViewerReadRelays(),
  ]);
  return cleanRelays([
    ...(opts.hints ?? []).slice(0, 3),
    ...author.write.slice(0, 4),
    ...(opts.inbox ? author.read.slice(0, 3) : []),
    ...DEFAULT_RELAYS,
    ...viewer.slice(0, 4),
  ], 14);
}

/** Relays for several authors at once (each contributes up to 2 write relays). */
export async function relaysForAuthors(pubkeys: string[], hints: string[] = []): Promise<string[]> {
  const unique = [...new Set(pubkeys)].slice(0, 8);
  const lists = await Promise.all(unique.map((pk) => getAuthorRelays(pk).catch(() => ({ read: [], write: [], at: 0 }))));
  const viewer = await getViewerReadRelays();
  return cleanRelays([
    ...hints.slice(0, 3),
    ...DEFAULT_RELAYS,
    ...lists.flatMap((l) => l.write.slice(0, 2)),
    ...viewer.slice(0, 4),
  ], 14);
}

/**
 * Outbox: the relays the given people actually post to (their kind-10002 write relays),
 * picked greedily so a few relays cover as many of them as possible. Cached for an hour.
 */
const outboxCache = new Map<string, { at: number; relays: string[] }>();
export function outboxRelaysFor(pubkeys: string[], max = 6): Promise<string[]> {
  const key = [...pubkeys].sort().join(',');
  const hit = outboxCache.get(key);
  if (hit && Date.now() - hit.at < 3600_000) return Promise.resolve(hit.relays);
  return new Promise((resolve) => {
    const latest = new Map<string, NEvent>();
    streamQuery({
      relays: [...INDEXER_RELAYS, 'wss://relay.damus.io', 'wss://relay.ditto.pub'],
      filters: [{ kinds: [10002], authors: pubkeys.slice(0, 500) }],
      timeoutMs: 6000,
      onEvent: (e) => { const p = latest.get(e.pubkey); if (!p || p.created_at < e.created_at) latest.set(e.pubkey, e); },
      onDone: () => {
        const who = new Map<string, Set<string>>();
        for (const [pk, e] of latest) {
          for (const t of e.tags.filter((t) => t[0] === 'r' && t[1] && (!t[2] || t[2] === 'write')).slice(0, 4)) {
            const u = t[1].trim().replace(/\/$/, '');
            if (!/^wss:\/\//.test(u) || /primal\.net/i.test(u)) continue;
            if (!who.has(u)) who.set(u, new Set());
            who.get(u)!.add(pk);
          }
        }
        const left = new Set(latest.keys());
        const picked: string[] = [];
        while (picked.length < max && left.size) {
          let best = '', n = 0;
          for (const [u, set] of who) { if (picked.includes(u)) continue; let c = 0; for (const pk of set) if (left.has(pk)) c++; if (c > n) { n = c; best = u; } }
          if (!best) break;
          picked.push(best);
          for (const pk of who.get(best)!) left.delete(pk);
        }
        outboxCache.set(key, { at: Date.now(), relays: picked });
        resolve(picked);
      },
    });
  });
}

