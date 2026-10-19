import { useState, useEffect, useRef, useCallback, useMemo, useContext } from 'react';
import { nip19 } from 'nostr-tools';
import { subscribeEvents, type FeedNote, type NostrEvent } from '@/lib/nostr/feed';
import { loadRelayList, getReadRelays } from '@/lib/nostr/relays';
import { DEFAULT_READ_RELAYS } from '@/lib/nostr/relay-subscribe';
import { normalizeRelay } from '@/lib/nostr/query';
import { sanitizeProfile } from '@/lib/nostr/cache';
import { type ProfileMetadata } from '@/lib/nostr/social';
import { NoteCard } from '@/popup/components/NoteCard';
import { ClickableAvatar } from '@/popup/components/ClickableAvatar';
import { Server, Loader2, Search, X, ChevronDown, ChevronUp, Code2, RefreshCw, Hash, Filter as FilterIcon, KeyRound, AlertTriangle } from 'lucide-react';
import { explorerRelay, needsAuth, needsNarrowerFilter, needsSearch, reasonPrefix, COMMON_KINDS, type QueryResult } from '@/lib/nostr/explorer-relay';
import { SavedChips } from '@/popup/components/SavedChips';
import { FeedFilterPanel } from '@/popup/components/FeedFilterPanel';
import { useFeedFilters, passesFilters, activeFilterCount, useReplyMode } from '@/lib/nostr/feed-filters';
import { useSavedList } from '@/lib/nostr/saved-lists';
import { AuthContext } from '@/popup/context/AuthContext';

// One relay at a time: what it is (NIP-11), which kinds and hashtags it holds,
// and its events filtered by kind, tag, author or NIP-50 search. Events come
// from that relay alone, straight from the browser; only names and pictures
// are also looked up on a profile indexer.

const SAVED_KEY = 'nostronchain_explore_relay';
const SAMPLE_SIZE = 400;
const PAGE = 40;
const PROFILE_RELAYS = ['wss://purplepag.es'];

// Probed 2026-10-19 with the explorer's own queries. Gone: nostr.wine (403 to non-members),
// relay.nostr.band (no longer answers), relay.mostr.pub (redirects), nostr.rocks (expired
// certificate), several hosts that no longer resolve. purplepag.es only serves listed kinds
// and search.nos.today only searches; both are handled, so they stay.
const SUGGESTED = [
  'wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.nostronchain.com', 'wss://relay.snort.social',
  'wss://relay.ditto.pub', 'wss://offchain.pub', 'wss://nostr.bitcoiner.social', 'wss://relay.nos.social',
  'wss://nostr-pub.wellorder.net', 'wss://relay.coinos.io', 'wss://nostr21.com', 'wss://relay.nostrplebs.com',
  'wss://nostr.einundzwanzig.space', 'wss://nostr.mom', 'wss://purplepag.es', 'wss://search.nos.today',
  'wss://pyramid.fiatjaf.com', 'wss://nostr.land', 'wss://relay.utxo.one', 'wss://nostr.data.haus',
];
const DEAD = new Set(['wss://nostr.wine', 'wss://relay.nostr.band', 'wss://relay.mostr.pub', 'wss://nostr.rocks', 'wss://brb.io']);

export const KIND_NAMES: Record<number, string> = {
  0: 'Profile', 1: 'Note', 2: 'Relay rec', 3: 'Follows', 4: 'Encrypted DM', 5: 'Deletion', 6: 'Repost', 7: 'Reaction',
  8: 'Badge award', 9: 'Chat message', 10: 'Group reply', 11: 'Thread', 13: 'Seal', 14: 'DM (NIP-17)', 16: 'Generic repost',
  17: 'Website reaction', 20: 'Picture', 21: 'Video', 22: 'Short video', 40: 'Channel', 41: 'Channel meta', 42: 'Channel msg',
  1018: 'Poll vote', 1059: 'Gift wrap', 1063: 'File', 1068: 'Poll', 1111: 'Comment', 1222: 'Voice note', 1311: 'Live chat',
  1984: 'Report', 1985: 'Label', 4550: 'Community post', 5000: 'DVM request', 6000: 'DVM result', 7000: 'DVM feedback',
  9041: 'Zap goal', 9734: 'Zap request', 9735: 'Zap', 9802: 'Highlight', 10000: 'Mute list', 10001: 'Pin list',
  10002: 'Relay list', 10003: 'Bookmarks', 10050: 'DM relays', 10063: 'Blossom servers', 13194: 'Wallet info',
  22242: 'Relay auth', 23194: 'Wallet request', 23195: 'Wallet response', 24133: 'Nostr Connect', 27235: 'HTTP auth',
  30000: 'Follow set', 30002: 'Relay set', 30003: 'Bookmark set', 30008: 'Profile badges', 30009: 'Badge',
  30017: 'Stall', 30018: 'Product', 30023: 'Article', 30024: 'Draft article', 30078: 'App data', 30311: 'Live event',
  30315: 'Status', 30402: 'Classified', 31922: 'Calendar date', 31923: 'Calendar time', 31989: 'App recommendation',
  31990: 'App handler', 34235: 'Video', 34236: 'Short video', 34550: 'Community', 39000: 'Group meta',
};

export function kindName(k: number): string {
  if (KIND_NAMES[k]) return KIND_NAMES[k];
  if (k >= 20000 && k < 30000) return 'Ephemeral';
  if (k >= 30000 && k < 40000) return 'Addressable';
  if (k >= 10000 && k < 20000) return 'Replaceable';
  return 'Kind ' + k;
}
/** "Reaction 7", or "Kind 7368" when the kind has no name. */
export function kindLabel(k: number): string {
  const n = kindName(k);
  return n === 'Kind ' + k ? n : `${n} ${k}`;
}

interface RelayInfo {
  name?: string; description?: string; pubkey?: string; contact?: string; software?: string; version?: string;
  supported_nips?: number[]; icon?: string; limitation?: Record<string, unknown>; payments_url?: string;
}

type TagKey = '' | 't' | 'p' | 'e' | 'custom';

interface Query {
  kind: number | null;
  tagKey: TagKey;
  customKey: string;
  tagValue: string;
  author: string;
  search: string;
}
const EMPTY_QUERY: Query = { kind: null, tagKey: '', customKey: '', tagValue: '', author: '', search: '' };

function toHttp(url: string): string {
  return url.replace(/^wss:\/\//i, 'https://').replace(/^ws:\/\//i, 'http://');
}

function decodeHexOrBech(s: string, want: 'npub' | 'note'): string | null {
  const t = s.trim().replace(/^nostr:/, '');
  if (/^[0-9a-f]{64}$/i.test(t)) return t.toLowerCase();
  try {
    const d = nip19.decode(t);
    if (want === 'npub' && d.type === 'npub') return d.data as string;
    if (want === 'npub' && d.type === 'nprofile') return (d.data as { pubkey: string }).pubkey;
    if (want === 'note' && d.type === 'note') return d.data as string;
    if (want === 'note' && d.type === 'nevent') return (d.data as { id: string }).id;
  } catch { /* not bech32 */ }
  return null;
}

function timeAgo(ts: number): string {
  const diff = Math.floor(Date.now() / 1000) - ts;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d`;
  return new Date(ts * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** What a relay's refusal means for the reader, in plain words. */
function explain(r: QueryResult): string {
  if (r.connectError) return r.connectError;
  const why = r.closed || r.notices.join(' · ');
  if (!why) return r.timedOut ? 'The relay did not finish answering in time.' : '';
  const p = reasonPrefix(r.closed);
  if (p === 'auth-required') return 'This relay only answers people who log in to it (NIP-42).';
  if (p === 'restricted') return `This relay restricts reads: ${why.replace(/^restricted:\s*/, '')}`;
  if (p === 'rate-limited') return 'The relay is rate-limiting this connection. Wait a moment and try again.';
  if (needsSearch(r)) return 'This relay only answers searches. Type something in the search box.';
  if (needsNarrowerFilter(r)) return `The relay wants narrower questions: “${why}”`;
  return `The relay said: “${why}”`;
}

interface Props {
  onSelectNote: (note: FeedNote) => void;
  onViewProfile?: (pubkey: string) => void;
}

export function RelayExplorer({ onSelectNote, onViewProfile }: Props) {
  const [relay, setRelay] = useState<string>(() => {
    try { return normalizeRelay(localStorage.getItem(SAVED_KEY) || '') || ''; } catch { return ''; }
  });
  const [typed, setTyped] = useState('');
  const [typedError, setTypedError] = useState('');
  const [mine, setMine] = useState<string[]>([]);

  const [info, setInfo] = useState<RelayInfo | null>(null);
  const [infoState, setInfoState] = useState<'idle' | 'loading' | 'ok' | 'none'>('idle');
  const [infoOpen, setInfoOpen] = useState(false);

  const [sample, setSample] = useState<NostrEvent[] | null>(null);
  const [sampleLoading, setSampleLoading] = useState(false);

  const [draft, setDraft] = useState<Query>(EMPTY_QUERY);
  const [query, setQuery] = useState<Query>(EMPTY_QUERY);
  const [kindTyped, setKindTyped] = useState('');
  const [showFilters, setShowFilters] = useState(false);

  const [events, setEvents] = useState<NostrEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [exhausted, setExhausted] = useState(false);
  const [error, setError] = useState('');
  // what the relay said when it gave nothing back, and whether it wants a NIP-42 login
  const [refusal, setRefusal] = useState('');
  const [sampleNote, setSampleNote] = useState('');
  const [authNeeded, setAuthNeeded] = useState(false);
  const [authBusy, setAuthBusy] = useState(false);
  const [authTick, setAuthTick] = useState(0);
  const [searchOnly, setSearchOnly] = useState(false);
  const needsKindRef = useRef(false);
  const [showSuggest, setShowSuggest] = useState(false);
  const [endEl, setEndEl] = useState<HTMLDivElement | null>(null);
  const auth = useContext(AuthContext);
  const saved = useSavedList('relays', auth?.publicKey || '');
  const { prefs: filterPrefs } = useFeedFilters();

  const [profiles, setProfiles] = useState<Map<string, ProfileMetadata>>(new Map());
  const askedRef = useRef<Set<string>>(new Set());
  const genRef = useRef(0);

  // the user's own read relays first, then suggestions
  useEffect(() => {
    loadRelayList()
      .then((l) => setMine(getReadRelays(l).map((u) => normalizeRelay(u)).filter((u): u is string => !!u)))
      .catch(() => setMine([]));
  }, []);
  // suggestions: the user's own read relays first, then known-good ones, minus what is already saved
  const choices = useMemo(() => {
    const all = [...mine, ...DEFAULT_READ_RELAYS, ...SUGGESTED].map((u) => normalizeRelay(u)).filter((u): u is string => !!u && !DEAD.has(u));
    return [...new Set(all)].filter((u) => !saved.items.includes(u));
  }, [mine, saved.items]);

  const supportsSearch = !!info?.supported_nips?.includes(50) || searchOnly;

  function pick(url: string) {
    const n = normalizeRelay(url);
    if (!n) { setTypedError('That is not a wss:// relay address (relay.primal.net is not allowed).'); return; }
    setTypedError('');
    setTyped('');
    setRelay(n);
    setDraft(EMPTY_QUERY);
    setQuery(EMPTY_QUERY);
    setKindTyped('');
    setAuthNeeded(false);
    setSearchOnly(false);
    setRefusal('');
    needsKindRef.current = false;
    try { localStorage.setItem(SAVED_KEY, n); } catch { /* storage blocked */ }
  }

  async function doAuth() {
    if (!auth?.confirmAndSign) return;
    setAuthBusy(true);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res = await explorerRelay(relay).auth((t) => auth.confirmAndSign(t) as any);
      if (res.ok) { setAuthNeeded(false); setRefusal(''); setAuthTick((x) => x + 1); }
      else setRefusal(res.message);
    } catch (e) {
      setRefusal(e instanceof Error ? e.message : 'Could not log in to the relay');
    } finally {
      setAuthBusy(false);
    }
  }

  // ─── NIP-11 ──────────────────────────────────────────────
  useEffect(() => {
    if (!relay) return;
    let live = true;
    setInfo(null);
    setInfoState('loading');
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 7000);
    fetch(toHttp(relay), { headers: { Accept: 'application/nostr+json' }, signal: ctl.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (live) { setInfo(j && typeof j === 'object' ? j : null); setInfoState(j ? 'ok' : 'none'); } })
      .catch(() => { if (live) setInfoState('none'); })
      .finally(() => clearTimeout(t));
    return () => { live = false; ctl.abort(); clearTimeout(t); };
  }, [relay]);

  // ─── Sample: kinds and hashtags this relay holds lately ──
  const loadSample = useCallback(async () => {
    if (!relay) return;
    setSampleLoading(true);
    setSample(null);
    setSampleNote('');
    const conn = explorerRelay(relay);
    let r = await conn.query({ limit: SAMPLE_SIZE }, 9000);
    // some relays refuse a filter with no kind ("filters must specify at least one kind"): ask for common kinds
    if (!r.events.length && needsNarrowerFilter(r)) {
      needsKindRef.current = true;
      r = await conn.query({ kinds: COMMON_KINDS, limit: SAMPLE_SIZE }, 9000);
      if (r.events.length) setSampleNote('This relay wants a kind in every question, so the sample covers the common kinds.');
    }
    if (!r.events.length && needsSearch(r)) { setSearchOnly(true); setShowFilters(true); }
    if (needsAuth(r)) setAuthNeeded(true);
    if (!r.events.length) setSampleNote(explain(r) || 'This relay sent nothing back for recent events.');
    setSample(r.events);
    setSampleLoading(false);
  }, [relay, authTick]);
  useEffect(() => { loadSample(); }, [loadSample]);

  const kindCounts = useMemo(() => {
    const m = new Map<number, number>();
    for (const e of sample || []) m.set(e.kind, (m.get(e.kind) || 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [sample]);
  const topTags = useMemo(() => {
    // relays match tag values exactly, so keep the spelling events actually use
    const m = new Map<string, number>();
    for (const e of sample || []) {
      const seen = new Set<string>();
      for (const t of e.tags || []) if (t[0] === 't' && t[1] && t[1].length <= 40) { const v = t[1]; if (!seen.has(v)) { seen.add(v); m.set(v, (m.get(v) || 0) + 1); } }
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 16);
  }, [sample]);
  const sampleSpan = useMemo(() => {
    if (!sample || sample.length < 2) return '';
    const s = (sample[0].created_at - sample[sample.length - 1].created_at);
    return s < 3600 ? `${Math.max(1, Math.round(s / 60))} min` : s < 172800 ? `${Math.round(s / 3600)} h` : `${Math.round(s / 86400)} days`;
  }, [sample]);

  // ─── The filter actually sent ────────────────────────────
  const buildFilter = useCallback((q: Query): { filter: Record<string, unknown> | null; problem: string } => {
    const f: Record<string, unknown> = { limit: PAGE };
    if (q.kind !== null) f.kinds = [q.kind];
    else if (needsKindRef.current) f.kinds = COMMON_KINDS;
    if (q.tagKey && q.tagValue.trim()) {
      const key = q.tagKey === 'custom' ? q.customKey.trim() : q.tagKey;
      if (!/^[a-zA-Z]$/.test(key)) return { filter: null, problem: 'A tag key is one letter, like t, p, e, a, d or r.' };
      let v = q.tagValue.trim();
      if (key === 't') v = v.replace(/^#/, '');
      if (key === 'p') { const pk = decodeHexOrBech(v, 'npub'); if (!pk) return { filter: null, problem: 'For #p, paste an npub or a 64-character hex key.' }; v = pk; }
      if (key === 'e') { const id = decodeHexOrBech(v, 'note'); if (!id) return { filter: null, problem: 'For #e, paste a note1…, nevent1… or hex event id.' }; v = id; }
      f['#' + key] = key === 't' && v !== v.toLowerCase() ? [v, v.toLowerCase()] : [v];
    }
    if (q.author.trim()) {
      const pk = decodeHexOrBech(q.author, 'npub');
      if (!pk) return { filter: null, problem: 'Author: paste an npub or a 64-character hex key.' };
      f.authors = [pk];
    }
    if (q.search.trim()) f.search = q.search.trim().slice(0, 100);
    return { filter: f, problem: '' };
  }, []);

  // names and pictures for whoever shows up
  const askProfiles = useCallback((list: NostrEvent[]) => {
    if (!relay) return;
    const want = [...new Set(list.map((e) => e.pubkey))].filter((pk) => !askedRef.current.has(pk)).slice(0, 150);
    if (!want.length) return;
    for (const pk of want) askedRef.current.add(pk);
    const newest = new Map<string, { at: number; p: ProfileMetadata }>();
    let paint: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      paint = null;
      setProfiles((prev) => { const next = new Map(prev); for (const [pk, v] of newest) next.set(pk, v.p); return next; });
    };
    const close = subscribeEvents([relay, ...PROFILE_RELAYS], { kinds: [0], authors: want }, (ev) => {
      const prev = newest.get(ev.pubkey);
      if (prev && prev.at >= ev.created_at) return;
      try { newest.set(ev.pubkey, { at: ev.created_at, p: sanitizeProfile(JSON.parse(ev.content), ev.pubkey) }); } catch { return; }
      if (!paint) paint = setTimeout(flush, 250);
    }, () => { if (paint) clearTimeout(paint); flush(); });
    setTimeout(() => { try { close(); } catch { /* closed */ } }, 8000);
  }, [relay]);

  // ─── Run the query ───────────────────────────────────────
  useEffect(() => {
    if (!relay) return;
    const gen = ++genRef.current;
    const { filter, problem } = buildFilter(query);
    setEvents([]);
    setExhausted(false);
    setError(problem);
    setRefusal('');
    if (!filter) return;
    if (searchOnly && !filter.search) { setRefusal('This relay only answers searches. Type something in the search box.'); setExhausted(true); return; }
    setLoading(true);
    const conn = explorerRelay(relay);
    (async () => {
      let r = await conn.query(filter);
      if (!r.events.length && !filter.kinds && needsNarrowerFilter(r)) {
        needsKindRef.current = true;
        r = await conn.query({ ...filter, kinds: COMMON_KINDS });
      }
      if (gen !== genRef.current) return;
      if (needsAuth(r)) setAuthNeeded(true);
      if (!r.events.length && needsSearch(r)) setSearchOnly(true);
      setRefusal(r.events.length ? '' : explain(r));
      setEvents(r.events);
      setLoading(false);
      if (r.events.length < PAGE / 2) setExhausted(true);
      askProfiles(r.events);
    })();
  }, [relay, query, buildFilter, askProfiles, authTick, searchOnly]);

  async function loadOlder() {
    if (loadingMore || exhausted || !events.length) return;
    const { filter } = buildFilter(query);
    if (!filter) return;
    setLoadingMore(true);
    const gen = genRef.current;
    const oldest = events[events.length - 1].created_at;
    // until is inclusive: events from the oldest second come back again and are dropped by id
    const got = (await explorerRelay(relay).query({ ...filter, until: oldest })).events;
    if (gen !== genRef.current) { setLoadingMore(false); return; }
    const known = new Set(events.map((e) => e.id));
    const fresh = got.filter((e) => !known.has(e.id));
    if (!fresh.length) setExhausted(true);
    setEvents((prev) => [...prev, ...fresh].sort((a, b) => b.created_at - a.created_at));
    askProfiles(fresh);
    setLoadingMore(false);
  }

  function apply(next: Partial<Query>) {
    const q = { ...draft, ...next };
    setDraft(q);
    setQuery(q);
  }
  function chooseKind(k: number | null) {
    setKindTyped(k === null ? '' : String(k));
    apply({ kind: k });
  }
  function submitKind(e: React.FormEvent) {
    e.preventDefault();
    const n = kindTyped.trim();
    if (!n) { chooseKind(null); return; }
    if (/^\d{1,5}$/.test(n) && +n <= 65535) chooseKind(+n);
  }
  function submitFilters(e: React.FormEvent) {
    e.preventDefault();
    setQuery({ ...draft });
  }

  // the reader's feed filters apply to notes here too; other kinds only show with "Everything"
  const [replyMode] = useReplyMode('relay');
  const filtering = activeFilterCount(filterPrefs) > 0 || replyMode === 'notes';
  const visibleEvents = useMemo(() => {
    if (!filtering) return events;
    const prefs = replyMode === 'notes' ? { ...filterPrefs, hideReplies: true } : filterPrefs;
    const noteKinds = new Set([1, 6, 16, 20, 21, 22, 1111, 1222, 34235, 34236]);
    return events.filter((e) => (noteKinds.has(e.kind)
      ? passesFilters(e as FeedNote, prefs, { profile: profiles.get(e.pubkey) })
      : prefs.only === 'all'));
  }, [events, filtering, filterPrefs, profiles, replyMode]);

  // older events load as the end comes into view, and keep loading while too few pass the filters
  useEffect(() => {
    if (!endEl) return;
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) loadOlder(); }, { rootMargin: '700px 0px' });
    io.observe(endEl);
    return () => io.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endEl, events.length, exhausted, loadingMore]);
  useEffect(() => {
    if (filtering && !loading && !loadingMore && !exhausted && events.length > 0 && visibleEvents.length < 8) loadOlder();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtering, loading, loadingMore, exhausted, events.length, visibleEvents.length]);

  const activeBits = [
    query.kind !== null && kindLabel(query.kind),
    query.tagKey && query.tagValue && `#${query.tagKey === 'custom' ? query.customKey : query.tagKey}: ${query.tagValue.length > 18 ? query.tagValue.slice(0, 16) + '…' : query.tagValue}`,
    query.author && 'one author',
    query.search && `“${query.search}”`,
  ].filter(Boolean) as string[];

  const chip = (active: boolean) => `px-3 py-1.5 rounded-full text-[13px] font-medium border whitespace-nowrap transition-colors ${
    active ? 'bg-purple-600/25 text-purple-200 border-purple-500/40' : 'bg-white/5 text-gray-300 border-white/10 hover:border-white/25'}`;
  const input = 'bg-white/5 border border-white/10 rounded-full px-4 py-2 text-[15px] outline-none focus:border-purple-500/50 min-w-0';

  // ─── Relay picker ────────────────────────────────────────
  const picker = (
    <div className="px-3 pt-3">
      <form onSubmit={(e) => { e.preventDefault(); if (typed.trim()) pick(typed.trim().match(/^wss?:\/\//i) ? typed.trim() : 'wss://' + typed.trim()); }} className="flex gap-2">
        <input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="wss://any.relay" autoCapitalize="none" autoCorrect="off" spellCheck={false} className={`flex-1 ${input}`} data-testid="relay-input" />
        <button type="submit" className="px-4 py-2 bg-purple-600 text-white rounded-full text-[13px] font-medium">Open</button>
      </form>
      {typedError && <p className="text-[12px] text-red-400 mt-1.5 ml-2">{typedError}</p>}
      <p className="text-[11px] uppercase tracking-wide text-gray-500 mt-2.5 mb-1 ml-1">Your relays to explore</p>
      <SavedChips kind="relays" active={relay} onPick={pick} />
      <button onClick={() => setShowSuggest((v) => !v)} className="flex items-center gap-1 text-[12px] text-gray-500 hover:text-gray-300 mt-1 ml-1">
        More relays {showSuggest ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
      </button>
      {showSuggest && (
        <div className="flex gap-1.5 flex-wrap mt-1.5 pb-1" data-testid="relay-choices">
          {choices.map((u) => (
            <button key={u} onClick={() => pick(u)} className={chip(u === relay)} title={u}>
              {mine.includes(u) && <span className="text-purple-400 mr-1">●</span>}{u.replace(/^wss:\/\//, '')}
            </button>
          ))}
        </div>
      )}
    </div>
  );

  if (!relay) {
    return (
      <div className="flex flex-col">
        {picker}
        <div className="flex flex-col items-center justify-center py-14 px-6">
          <Server className="w-10 h-10 text-gray-700 mb-3" />
          <p className="text-[15px] text-gray-400 text-center">Pick a relay above or type any wss:// address to see what it holds: its kinds, hashtags and events. Save the ones you like with ✎.</p>
        </div>
      </div>
    );
  }

  const lim = info?.limitation || {};
  const limits = ([
    ['auth_required', 'auth required'], ['payment_required', 'paid'], ['restricted_writes', 'restricted writes'],
    ['max_limit', 'max limit'], ['max_subscriptions', 'max subs'], ['max_message_length', 'max message'],
  ] as const).filter(([k]) => lim[k] !== undefined && lim[k] !== false).map(([k, label]) => (lim[k] === true ? label : `${label} ${lim[k]}`));

  return (
    <div className="flex flex-col" data-testid="relay-explorer">
      {picker}

      {/* NIP-11 */}
      <div className="px-3 pt-2">
        <div className="rounded-2xl border border-white/10 bg-white/[0.03] overflow-hidden">
          <button onClick={() => setInfoOpen((v) => !v)} className="w-full flex items-center gap-3 px-3.5 py-3 text-left">
            {info?.icon
              ? <img src={info.icon} alt="" className="w-9 h-9 rounded-lg object-cover flex-shrink-0" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
              : <span className="w-9 h-9 rounded-lg bg-purple-600/15 flex items-center justify-center flex-shrink-0"><Server className="w-4 h-4 text-purple-300" /></span>}
            <div className="flex-1 min-w-0">
              <p className="text-[15px] font-semibold text-white truncate" data-testid="relay-name">{info?.name || relay.replace(/^wss:\/\//, '')}</p>
              <p className="text-[12px] text-gray-500 truncate">
                {infoState === 'loading' ? 'Reading relay info…' : infoState === 'none' ? 'No NIP-11 info document' :
                  [info?.software?.replace(/^(git\+)?https?:\/\/(www\.)?(github\.com\/)?/, '').replace(/\.git$/, ''), info?.version].filter(Boolean).join(' ') || relay}
              </p>
            </div>
            <span className={`text-[11px] px-2 py-0.5 rounded-full border ${supportsSearch ? 'text-green-300 border-green-500/30 bg-green-500/10' : 'text-gray-500 border-white/10'}`}>
              {supportsSearch ? 'search' : 'no search'}
            </span>
            {infoOpen ? <ChevronUp className="w-4 h-4 text-gray-500" /> : <ChevronDown className="w-4 h-4 text-gray-500" />}
          </button>
          {infoOpen && (
            <div className="px-3.5 pb-3.5 text-[13px] text-gray-400 space-y-2 border-t border-white/5 pt-3" data-testid="relay-info">
              <p className="break-all text-gray-500">{relay}</p>
              {info?.description && <p className="whitespace-pre-wrap">{info.description}</p>}
              {info?.supported_nips?.length ? (
                <div className="flex flex-wrap gap-1">
                  {info.supported_nips.map((n) => <span key={n} className={`px-1.5 py-0.5 rounded text-[11px] border ${n === 50 ? 'border-green-500/40 text-green-300' : 'border-white/10 text-gray-400'}`}>NIP-{String(n).padStart(2, '0')}</span>)}
                </div>
              ) : null}
              {limits.length > 0 && <p>{limits.join(' · ')}</p>}
              {info?.contact && <p>Contact: <span className="break-all">{info.contact}</span></p>}
              {info?.pubkey && <button onClick={() => onViewProfile?.(info.pubkey!)} className="text-purple-300 break-all text-left">Operator {(() => { try { return nip19.npubEncode(info.pubkey!).slice(0, 20) + '…'; } catch { return info.pubkey; } })()}</button>}
              {info?.payments_url && <a href={info.payments_url} target="_blank" rel="noreferrer" className="text-purple-300 block">Payments page</a>}
            </div>
          )}
        </div>
      </div>

      {authNeeded && (
        <div className="mx-3 mt-2 rounded-2xl border border-amber-500/30 bg-amber-500/10 px-3.5 py-3 flex items-center gap-3" data-testid="auth-banner">
          <KeyRound className="w-5 h-5 text-amber-300 flex-shrink-0" />
          <p className="flex-1 text-[13px] text-amber-100">This relay asks you to log in (NIP-42) before it shares events.</p>
          {auth?.confirmAndSign
            ? <button onClick={doAuth} disabled={authBusy} className="px-3 py-1.5 rounded-full bg-amber-400 text-black text-[13px] font-semibold disabled:opacity-60 flex items-center gap-1">{authBusy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}Log in</button>
            : <span className="text-[12px] text-amber-200">Sign in to the app first</span>}
        </div>
      )}

      {/* Kinds on this relay */}
      <div className="px-3 pt-3">
        <div className="flex items-center gap-2 mb-1.5 ml-1">
          <p className="text-[12px] uppercase tracking-wide text-gray-500 flex-1">
            Kinds {sample ? `· last ${sample.length} events${sampleSpan ? ` over ${sampleSpan}` : ''}` : ''}
          </p>
          <button onClick={loadSample} className="text-gray-500 hover:text-gray-300" title="Sample again"><RefreshCw className={`w-3.5 h-3.5 ${sampleLoading ? 'animate-spin' : ''}`} /></button>
        </div>
        <div className="flex gap-1.5 overflow-x-auto scrollbar-none pb-1" data-testid="kind-chips">
          <button onClick={() => chooseKind(null)} className={chip(query.kind === null)}>All kinds</button>
          {sampleLoading && <span className="flex items-center text-[12px] text-gray-500 px-2"><Loader2 className="w-3.5 h-3.5 animate-spin mr-1" />sampling…</span>}
          {kindCounts.map(([k, n]) => (
            <button key={k} onClick={() => chooseKind(k)} className={chip(query.kind === k)} data-kind={k}>
              {kindName(k)}{kindName(k) !== 'Kind ' + k && <span className="text-gray-500 ml-1">{k}</span>} <span className="opacity-60">· {n}</span>
            </button>
          ))}
          {query.kind !== null && !kindCounts.some(([k]) => k === query.kind) && (
            <button className={chip(true)}>{kindLabel(query.kind)}</button>
          )}
        </div>
        {sampleNote && !sampleLoading && <p className={`text-[12px] ml-1 mt-1 ${sample && sample.length ? 'text-gray-500' : 'text-amber-300/90'}`} data-testid="sample-note">{sampleNote}</p>}
        <form onSubmit={submitKind} className="flex gap-2 mt-1.5">
          <input value={kindTyped} onChange={(e) => setKindTyped(e.target.value.replace(/\D/g, '').slice(0, 5))} inputMode="numeric" placeholder="any kind number, e.g. 30023" className={`flex-1 ${input}`} data-testid="kind-input" />
          <button type="submit" className="px-4 py-2 bg-white/10 text-gray-200 rounded-full text-[13px] font-medium">Show</button>
        </form>
      </div>

      {/* Hashtags on this relay */}
      {topTags.length > 0 && (
        <div className="px-3 pt-3">
          <p className="text-[12px] uppercase tracking-wide text-gray-500 mb-1.5 ml-1">Hashtags in the sample</p>
          <div className="flex gap-1.5 overflow-x-auto scrollbar-none pb-1" data-testid="tag-chips">
            {topTags.map(([t, n]) => {
              const on = query.tagKey === 't' && query.tagValue === t;
              return (
                <button key={t} onClick={() => apply(on ? { tagKey: '', tagValue: '' } : { tagKey: 't', tagValue: t })} className={chip(on)} data-tag={t}>
                  #{t} <span className="opacity-60">· {n}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* More filters */}
      <div className="px-3 pt-3">
        <button onClick={() => setShowFilters((v) => !v)} className="flex items-center gap-1.5 text-[13px] text-gray-400 hover:text-gray-200 ml-1">
          <FilterIcon className="w-3.5 h-3.5" /> Tag, author{supportsSearch ? ', search' : ''} {showFilters ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
        </button>
        {showFilters && (
          <form onSubmit={submitFilters} className="mt-2 space-y-2 rounded-2xl border border-white/10 bg-white/[0.03] p-3" data-testid="filters">
            <div className="flex gap-1.5 flex-wrap">
              {(['', 't', 'p', 'e', 'custom'] as TagKey[]).map((k) => (
                <button type="button" key={k || 'none'} onClick={() => setDraft({ ...draft, tagKey: k })} className={chip(draft.tagKey === k)}>
                  {k === '' ? 'No tag' : k === 'custom' ? 'Other tag' : k === 't' ? '#t hashtag' : k === 'p' ? '#p person' : '#e event'}
                </button>
              ))}
            </div>
            {draft.tagKey && (
              <div className="flex gap-2">
                {draft.tagKey === 'custom' && (
                  <input value={draft.customKey} onChange={(e) => setDraft({ ...draft, customKey: e.target.value.slice(0, 1) })} placeholder="d" autoCapitalize="none" className={`w-14 text-center ${input}`} />
                )}
                <input value={draft.tagValue} onChange={(e) => setDraft({ ...draft, tagValue: e.target.value })} autoCapitalize="none" autoCorrect="off" spellCheck={false}
                  placeholder={draft.tagKey === 't' ? 'bitcoin' : draft.tagKey === 'p' ? 'npub1… or hex' : draft.tagKey === 'e' ? 'note1… / nevent1… / hex' : 'tag value'}
                  className={`flex-1 ${input}`} data-testid="tag-value" />
              </div>
            )}
            <input value={draft.author} onChange={(e) => setDraft({ ...draft, author: e.target.value })} placeholder="Author: npub1… or hex (optional)" autoCapitalize="none" autoCorrect="off" spellCheck={false} className={`w-full ${input}`} />
            {supportsSearch && (
              <div className="relative">
                <Search className="w-4 h-4 text-gray-500 absolute left-3.5 top-1/2 -translate-y-1/2" />
                <input value={draft.search} onChange={(e) => setDraft({ ...draft, search: e.target.value })} placeholder="Search this relay (NIP-50)" className={`w-full pl-9 ${input}`} />
              </div>
            )}
            <div className="flex gap-2 pt-1">
              <button type="submit" className="flex-1 py-2 bg-purple-600 text-white rounded-full text-[13px] font-medium">Apply</button>
              <button type="button" onClick={() => { setDraft(EMPTY_QUERY); setQuery(EMPTY_QUERY); setKindTyped(''); }} className="px-4 py-2 bg-white/5 border border-white/10 text-gray-300 rounded-full text-[13px]">Clear</button>
            </div>
          </form>
        )}
      </div>

      <FeedFilterPanel hidden={events.length - visibleEvents.length} />

      {/* Active filter summary */}
      <div className="px-4 pt-3 pb-1 flex items-center gap-2 flex-wrap text-[12px] text-gray-500">
        <Hash className="w-3 h-3" />
        <span data-testid="active-filter">{activeBits.length ? activeBits.join(' · ') : 'Everything, newest first'}</span>
        {activeBits.length > 0 && (
          <button onClick={() => { setDraft(EMPTY_QUERY); setQuery(EMPTY_QUERY); setKindTyped(''); }} className="flex items-center gap-0.5 text-gray-400 hover:text-white"><X className="w-3 h-3" />clear</button>
        )}
      </div>

      {/* Events */}
      {error && <p className="px-4 py-3 text-[13px] text-red-400">{error}</p>}
      {loading && <div className="flex items-center justify-center py-10 text-gray-500 text-[13px]"><Loader2 className="w-4 h-4 animate-spin mr-2" />Asking {relay.replace(/^wss:\/\//, '')}…</div>}
      {!loading && !error && events.length === 0 && (
        <div className="px-6 py-10 text-center" data-testid="relay-empty">
          {refusal
            ? <p className="text-[14px] text-amber-200/90 flex items-start justify-center gap-2"><AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" /><span data-testid="relay-refusal">{refusal}</span></p>
            : <p className="text-[14px] text-gray-500">Nothing on this relay matches.{query.search && !supportsSearch ? ' This relay does not support search.' : ''}</p>}
        </div>
      )}
      {!loading && events.length > 0 && visibleEvents.length === 0 && (
        <p className="px-6 py-8 text-center text-[14px] text-gray-500">None of the {events.length} loaded events match your filters{exhausted ? '.' : '. Looking further back…'}</p>
      )}
      <div className="divide-y divide-white/5" data-testid="relay-events">
        {visibleEvents.map((e) => (e.kind === 1 || e.kind === 1111)
          ? (
            <div key={e.id} className="px-4 py-3" data-event-kind={e.kind}>
              <NoteCard note={e as FeedNote} profile={profiles.get(e.pubkey)} onSelectNote={onSelectNote} onViewProfile={onViewProfile} />
            </div>
          )
          : <EventCard key={e.id} ev={e} profile={profiles.get(e.pubkey)} onViewProfile={onViewProfile} onKind={chooseKind} />)}
      </div>
      {!loading && events.length > 0 && (
        <div className="px-4 py-4" ref={setEndEl}>
          {exhausted
            ? <p className="text-center text-[13px] text-gray-600 py-2">Nothing older came back. That's all this relay holds for this filter, or it only keeps recent events.</p>
            : (
              <button onClick={loadOlder} disabled={loadingMore} className="w-full py-3 bg-white/5 hover:bg-white/10 border border-white/10 rounded-xl text-[14px] font-medium text-gray-300 flex items-center justify-center gap-2" data-testid="load-older">
                {loadingMore ? (<><Loader2 className="w-4 h-4 animate-spin" /> Loading older…</>) : 'Load older'}
              </button>
            )}
        </div>
      )}
    </div>
  );
}

// ─── Any other kind: compact card with tags and raw JSON ─────
function EventCard({ ev, profile, onViewProfile, onKind }: {
  ev: NostrEvent; profile?: ProfileMetadata; onViewProfile?: (pk: string) => void; onKind: (k: number) => void;
}) {
  const [raw, setRaw] = useState(false);
  const [allTags, setAllTags] = useState(false);
  // a profile event carries its own name and picture
  if (ev.kind === 0 && !profile) { try { profile = sanitizeProfile(JSON.parse(ev.content), ev.pubkey); } catch { /* bad json */ } }
  const name = profile?.displayName || profile?.name || `${ev.pubkey.slice(0, 8)}…${ev.pubkey.slice(-4)}`;
  const preview = useMemo(() => {
    const c = ev.content || '';
    if (ev.kind === 0) { try { const p = JSON.parse(c); return [p.display_name || p.name, p.nip05, p.about].filter(Boolean).join(' · '); } catch { /* not json */ } }
    if (ev.kind === 4 || ev.kind === 1059 || ev.kind === 13 || ev.kind === 14 || /^[A-Za-z0-9+/=]{60,}(\?iv=.*)?$/.test(c)) return c ? '(encrypted)' : '';
    if (c.startsWith('{')) { try { JSON.parse(c); return '(JSON content)'; } catch { /* plain */ } }
    return c;
  }, [ev]);
  const title = ev.tags.find((t) => t[0] === 'title' || t[0] === 'name' || t[0] === 'subject')?.[1];
  const image = ev.tags.find((t) => (t[0] === 'image' || t[0] === 'thumb') && /^https:/.test(t[1] || ''))?.[1];
  const tags = allTags ? ev.tags : ev.tags.slice(0, 6);

  return (
    <div className="px-4 py-3" data-event-kind={ev.kind}>
      <div className="flex gap-3">
        <div className="flex-shrink-0 pt-0.5"><ClickableAvatar pubkey={ev.pubkey} picture={profile?.picture} name={name} size="lg" /></div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 text-[13px] mb-1">
            <button onClick={() => onViewProfile?.(ev.pubkey)} className="font-semibold text-white truncate">{name}</button>
            <span className="text-gray-600 whitespace-nowrap">· {timeAgo(ev.created_at)}</span>
            <button onClick={() => onKind(ev.kind)} className="ml-auto text-[11px] px-2 py-0.5 rounded-full border border-purple-500/30 text-purple-300 bg-purple-500/10 whitespace-nowrap">{kindLabel(ev.kind)}</button>
          </div>
          {title && <p className="text-[15px] font-semibold text-white leading-snug mb-1 break-words">{title}</p>}
          {image && <img src={image} alt="" className="w-full max-h-44 object-cover rounded-xl mb-1.5" loading="lazy" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />}
          {preview && <p className="text-[14px] text-gray-300 leading-relaxed whitespace-pre-wrap break-words line-clamp-6">{preview}</p>}
          {ev.tags.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {tags.map((t, i) => (
                <span key={i} className="text-[11px] px-1.5 py-0.5 rounded bg-white/5 border border-white/10 text-gray-400 max-w-full truncate" title={t.join(' ')}>
                  <b className="text-gray-300">{t[0]}</b> {(t[1] || '').length > 24 ? t[1].slice(0, 10) + '…' + t[1].slice(-6) : t[1]}
                </span>
              ))}
              {ev.tags.length > 6 && <button onClick={() => setAllTags((v) => !v)} className="text-[11px] text-purple-300">{allTags ? 'fewer' : `+${ev.tags.length - 6} tags`}</button>}
            </div>
          )}
          <button onClick={() => setRaw((v) => !v)} className="mt-1.5 flex items-center gap-1 text-[12px] text-gray-500 hover:text-gray-300" data-testid="raw-toggle">
            <Code2 className="w-3.5 h-3.5" />{raw ? 'Hide JSON' : 'Raw JSON'}
          </button>
          {raw && <pre className="mt-1.5 text-[11px] leading-snug text-gray-400 bg-black/40 border border-white/10 rounded-lg p-2 overflow-x-auto max-h-80 whitespace-pre-wrap break-all">{JSON.stringify(ev, null, 2)}</pre>}
        </div>
      </div>
    </div>
  );
}
