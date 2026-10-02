import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  subscribeFeed, subscribeEvents, mergeNotes, parseRepost, longFormMeta, isLongForm,
  tallyEngagement, loadFeedTab, saveFeedTab, loadFeedHashtag, saveFeedHashtag,
  PRESET_HASHTAGS, FEED_MAX_NOTES, FEED_PAGE_SIZE, KIND_REPOST, EMPTY_ENGAGEMENT,
  type FeedNote, type FeedMode, type FeedFilter, type Engagement,
} from '@/lib/nostr/feed';
import { DEFAULT_READ_RELAYS, relayConnectionStatus } from '@/lib/nostr/relay-subscribe';
import { loadRelayList, getReadRelays } from '@/lib/nostr/relays';
import { loadCache, cacheProfiles, sanitizeProfile } from '@/lib/nostr/cache';
import { loadMutedPubkeys } from '@/lib/nostr/mute';
import { type ProfileMetadata } from '@/lib/nostr/social';
import { NoteCard } from '@/popup/components/NoteCard';
import { NoteThread } from '@/popup/components/NoteThread';
import { ComposeNote } from '@/popup/components/ComposeNote';
import { ClickableAvatar } from '@/popup/components/ClickableAvatar';
import { SkeletonFeed } from '@/popup/components/Skeleton';
import { Globe, Users, Bitcoin, Hash, Loader2, Inbox, Repeat2, ArrowUp, RefreshCw, PenLine, BookOpen, Radio } from 'lucide-react';

interface Props {
  publicKey: string;
  followingPubkeys: Set<string>;
  onBack?: () => void;
  onViewProfile?: (pubkey: string) => void;
  /** Bump to re-fetch the feed without remounting the component */
  refreshToken?: number;
}

const TABS: { mode: FeedMode; label: string; icon: typeof Globe }[] = [
  { mode: 'following', label: 'Following', icon: Users },
  { mode: 'global', label: 'Global', icon: Globe },
  { mode: 'onchain', label: 'On-chain', icon: Bitcoin },
  { mode: 'hashtag', label: '#Tags', icon: Hash },
];

/** How often the page quietly asks the relays for anything newer. */
const LIVE_POLL_MS = 45_000;
/** Engagement is fetched for notes as they scroll into view, in batches. */
const ENGAGEMENT_BATCH = 40;

export type { Engagement };

// Relays that aggregate kind-0 profiles for everyone, so names resolve even
// when the author's own relays are not in the read list.
const PROFILE_RELAYS = ['wss://purplepag.es', 'wss://relay.nostr.band'];

// Kind-0 lookup over the shared read pool: one subscription across relays,
// newest profile per pubkey wins, settles at EOSE or after 6 seconds.
function fetchProfilesViaPool(
  pubkeys: string[],
  relays: string[],
  onProfile?: (pubkey: string, profile: ProfileMetadata) => void,
): Promise<Map<string, ProfileMetadata>> {
  return new Promise((resolve) => {
    const newest = new Map<string, { created_at: number; profile: ProfileMetadata }>();
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { close(); } catch { /* already closed */ }
      const out = new Map<string, ProfileMetadata>();
      for (const [pk, v] of newest) out.set(pk, v.profile);
      resolve(out);
    };
    const timer = setTimeout(finish, 6000);
    const close = subscribeEvents(
      relays,
      { kinds: [0], authors: pubkeys },
      (ev) => {
        if (ev.kind !== 0) return;
        const prev = newest.get(ev.pubkey);
        if (prev && prev.created_at >= ev.created_at) return;
        try {
          const profile = sanitizeProfile(JSON.parse(ev.content), ev.pubkey);
          newest.set(ev.pubkey, { created_at: ev.created_at, profile });
          onProfile?.(ev.pubkey, profile);
        } catch { /* unparsable profile */ }
      },
      finish,
    );
  });
}

function displayNameOf(profile: ProfileMetadata | undefined, pubkey: string): string {
  return profile?.displayName || profile?.name || `${pubkey.slice(0, 8)}…${pubkey.slice(-4)}`;
}

function timeAgo(ts: number): string {
  const diff = Math.floor(Date.now() / 1000) - ts;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d`;
  return new Date(ts * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function Feed({ publicKey, followingPubkeys, onViewProfile, refreshToken }: Props) {
  const [activeMode, setActiveMode] = useState<FeedMode>(() => loadFeedTab());
  const [notes, setNotes] = useState<FeedNote[]>([]);
  const [pendingNew, setPendingNew] = useState<FeedNote[]>([]);
  const [profiles, setProfiles] = useState<Map<string, ProfileMetadata>>(new Map());
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [exhausted, setExhausted] = useState(false);
  const [hashtag, setHashtag] = useState(() => loadFeedHashtag());
  const [hashtagSubmitted, setHashtagSubmitted] = useState(() => loadFeedHashtag());
  const [selectedNote, setSelectedNote] = useState<FeedNote | null>(null);
  const [engagement, setEngagement] = useState<Map<string, Engagement>>(new Map());
  const [showComposer, setShowComposer] = useState(false);
  const [relayStatus, setRelayStatus] = useState<{ up: number; total: number }>({ up: 0, total: 0 });
  const [loadError, setLoadError] = useState('');

  const cleanupRef = useRef<(() => void) | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const listTopRef = useRef<HTMLDivElement>(null);
  const mutedRef = useRef<Set<string>>(new Set());
  const notesRef = useRef<FeedNote[]>([]);
  notesRef.current = notes;
  const relayUrlsRef = useRef<string[]>([]);
  const loadGenRef = useRef(0);

  // ─── Mute list ────────────────────────────────────────────────
  useEffect(() => {
    loadMutedPubkeys()
      .then((m) => {
        mutedRef.current = m;
        // Anything that slipped in before the list arrived
        setNotes((prev) => prev.filter((n) => !m.has(n.pubkey)));
      })
      .catch(() => {});
  }, []);

  // ─── Relays ───────────────────────────────────────────────────
  const getRelayUrls = useCallback(async () => {
    if (relayUrlsRef.current.length > 0) return relayUrlsRef.current;
    const relayList = await loadRelayList();
    const relays = getReadRelays(relayList);
    relayUrlsRef.current = [...new Set([...relays, ...DEFAULT_READ_RELAYS])].slice(0, 8);
    return relayUrlsRef.current;
  }, []);

  useEffect(() => {
    const tick = () => {
      const status = relayConnectionStatus();
      const wanted = relayUrlsRef.current;
      if (wanted.length === 0) return;
      let up = 0;
      for (const url of wanted) {
        const key = url.replace(/\/+$/, '');
        for (const [u, ok] of status) {
          if (ok && u.replace(/\/+$/, '') === key) { up += 1; break; }
        }
      }
      setRelayStatus({ up, total: wanted.length });
    };
    const t = setInterval(tick, 3000);
    tick();
    return () => clearInterval(t);
  }, []);

  // ─── Profiles (batched, cached) ───────────────────────────────
  const profilesRef = useRef<Map<string, ProfileMetadata>>(new Map());
  profilesRef.current = profiles;
  const profileFetchingRef = useRef<Set<string>>(new Set());
  const pendingProfileRef = useRef<Set<string>>(new Set());
  const profileFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const resolveProfile = useCallback((pubkey: string) => {
    if (profilesRef.current.has(pubkey) || profileFetchingRef.current.has(pubkey)) return;
    profileFetchingRef.current.add(pubkey);
    pendingProfileRef.current.add(pubkey);
    if (profileFlushTimerRef.current) return;
    profileFlushTimerRef.current = setTimeout(async () => {
      profileFlushTimerRef.current = null;
      const batch = Array.from(pendingProfileRef.current);
      pendingProfileRef.current.clear();
      if (batch.length === 0) return;
      try {
        const uncached: string[] = [];
        const found = new Map<string, ProfileMetadata>();
        // One cache read for the whole batch. The discovery cache holds
        // placeholder entries with no name for pubkeys it has merely seen;
        // those must still be fetched.
        const cache = await loadCache();
        for (const pk of batch) {
          const cached = cache.profiles[pk]?.profile;
          if (cached && (cached.name || cached.displayName || cached.picture)) found.set(pk, cached);
          else uncached.push(pk);
        }
        const paint = (entries: Map<string, ProfileMetadata>) => {
          if (entries.size === 0) return;
          setProfiles((prev) => {
            const next = new Map(prev);
            for (const [pk, profile] of entries) next.set(pk, profile);
            return next;
          });
        };
        paint(found);
        if (uncached.length > 0) {
          const relays = [...new Set([...(await getRelayUrls()).slice(0, 4), ...PROFILE_RELAYS])];
          // Paint names as they arrive rather than when the whole batch settles.
          let pending = new Map<string, ProfileMetadata>();
          let paintTimer: ReturnType<typeof setTimeout> | null = null;
          const resolved = await fetchProfilesViaPool(uncached, relays, (pk, profile) => {
            pending.set(pk, profile);
            if (!paintTimer) paintTimer = setTimeout(() => { paintTimer = null; const p = pending; pending = new Map(); paint(p); }, 200);
          });
          if (paintTimer) { clearTimeout(paintTimer); paintTimer = null; }
          paint(pending);
          for (const [pk, profile] of resolved) found.set(pk, profile);
          if (resolved.size > 0) cacheProfiles(resolved).catch(() => {});
        }
        for (const pk of batch) if (!found.has(pk)) profileFetchingRef.current.delete(pk);
      } catch {
        for (const pk of batch) profileFetchingRef.current.delete(pk);
      }
    }, 250);
  }, [getRelayUrls]);

  useEffect(() => () => {
    if (profileFlushTimerRef.current) clearTimeout(profileFlushTimerRef.current);
  }, []);

  // ─── Filter for the current tab ───────────────────────────────
  const followingKey = Array.from(followingPubkeys).sort().join(',');

  const buildFilter = useCallback((mode: FeedMode): FeedFilter | null => {
    const filter: FeedFilter = { mode, limit: FEED_PAGE_SIZE };
    if (mode === 'following') {
      if (followingPubkeys.size === 0) return null;
      filter.pubkeys = [...new Set([publicKey, ...Array.from(followingPubkeys)])];
    }
    if (mode === 'hashtag') {
      if (!hashtagSubmitted.trim()) return null;
      filter.hashtag = hashtagSubmitted.trim();
    }
    return filter;
  }, [followingKey, hashtagSubmitted, publicKey]);

  const hydrate = useCallback((list: FeedNote[]) => {
    for (const n of list) {
      resolveProfile(n.pubkey);
      const rp = parseRepost(n);
      if (rp?.inner) resolveProfile(rp.inner.pubkey);
    }
  }, [resolveProfile]);

  // ─── Initial load / tab change ────────────────────────────────
  const loadFeed = useCallback(async (mode: FeedMode) => {
    const gen = ++loadGenRef.current;
    if (cleanupRef.current) { cleanupRef.current(); cleanupRef.current = null; }
    setNotes([]);
    setPendingNew([]);
    setEngagement(new Map());
    setExhausted(false);
    setLoadError('');
    setLoading(true);

    const filter = buildFilter(mode);
    if (!filter) { setLoading(false); return; }

    const relayUrls = await getRelayUrls();
    if (gen !== loadGenRef.current) return;

    const collected: FeedNote[] = [];
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      flushTimer = null;
      if (gen !== loadGenRef.current) return;
      const merged = mergeNotes([], collected, mutedRef.current);
      setNotes(merged);
      hydrate(merged);
    };

    cleanupRef.current = subscribeFeed(
      relayUrls,
      filter,
      (note) => {
        if (mutedRef.current.has(note.pubkey)) return;
        collected.push(note);
        if (!flushTimer) flushTimer = setTimeout(flush, 120);
      },
      () => {
        if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
        if (gen !== loadGenRef.current) return;
        const merged = mergeNotes([], collected, mutedRef.current);
        setNotes(merged);
        hydrate(merged);
        setLoading(false);
        if (merged.length === 0) {
          const status = relayConnectionStatus();
          const anyUp = relayUrls.some((u) => [...status].some(([k, ok]) => ok && k.replace(/\/+$/, '') === u.replace(/\/+$/, '')));
          if (!anyUp) setLoadError('None of your relays answered.');
        }
      },
    );
  }, [buildFilter, getRelayUrls, hydrate]);

  useEffect(() => {
    loadFeed(activeMode);
    return () => { if (cleanupRef.current) cleanupRef.current(); };
  }, [activeMode, loadFeed, refreshToken]);

  // ─── Quiet polling for new notes (buffered, never jumps the list) ──
  useEffect(() => {
    if (pollTimerRef.current) { clearInterval(pollTimerRef.current); pollTimerRef.current = null; }
    const filter = buildFilter(activeMode);
    if (!filter) return;

    pollTimerRef.current = setInterval(async () => {
      if (document.hidden) return;
      const current = notesRef.current;
      const newest = current.length > 0 ? Math.max(...current.map((n) => n.created_at)) : Math.floor(Date.now() / 1000) - 300;
      const relayUrls = await getRelayUrls();
      const found: FeedNote[] = [];
      const close = subscribeFeed(
        relayUrls,
        { ...filter, since: newest + 1, limit: 60 },
        (note) => { if (!mutedRef.current.has(note.pubkey)) found.push(note); },
        () => {
          close();
          if (found.length === 0) return;
          const known = new Set(notesRef.current.map((n) => n.id));
          const fresh = found.filter((n) => !known.has(n.id) && n.pubkey !== publicKey);
          const mine = found.filter((n) => !known.has(n.id) && n.pubkey === publicKey);
          // Your own posts go straight in; other people's wait behind the pill.
          if (mine.length > 0) setNotes((prev) => mergeNotes(prev, mine, mutedRef.current));
          if (fresh.length > 0) {
            setPendingNew((prev) => mergeNotes(prev, fresh, mutedRef.current));
            hydrate(fresh);
          }
        },
      );
    }, LIVE_POLL_MS);

    return () => { if (pollTimerRef.current) clearInterval(pollTimerRef.current); };
  }, [activeMode, buildFilter, getRelayUrls, hydrate, publicKey]);

  function showPending() {
    setNotes((prev) => mergeNotes(prev, pendingNew, mutedRef.current));
    setPendingNew([]);
    listTopRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // ─── Load older ───────────────────────────────────────────────
  async function handleLoadMore() {
    if (loadingMore || exhausted) return;
    const filter = buildFilter(activeMode);
    const current = notesRef.current;
    if (!filter || current.length === 0) return;
    if (current.length >= FEED_MAX_NOTES) { setExhausted(true); return; }
    setLoadingMore(true);
    const oldest = Math.min(...current.map((n) => n.created_at));
    const relayUrls = await getRelayUrls();
    const found: FeedNote[] = [];
    const close = subscribeFeed(
      relayUrls,
      { ...filter, until: oldest - 1 },
      (note) => { if (!mutedRef.current.has(note.pubkey)) found.push(note); },
      () => {
        close();
        const known = new Set(notesRef.current.map((n) => n.id));
        const older = found.filter((n) => !known.has(n.id));
        if (older.length === 0) setExhausted(true);
        else {
          setNotes((prev) => mergeNotes(prev, older, mutedRef.current).slice(0, FEED_MAX_NOTES));
          hydrate(older);
        }
        setLoadingMore(false);
      },
    );
  }

  // ─── Engagement for visible notes only ────────────────────────
  const engagementFetchedRef = useRef<Set<string>>(new Set());
  const visibleRef = useRef<Set<string>>(new Set());
  const engagementTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const engagementClosersRef = useRef<(() => void)[]>([]);
  const engagementMapRef = useRef<Map<string, Engagement>>(new Map());

  useEffect(() => {
    engagementFetchedRef.current = new Set();
    engagementMapRef.current = new Map();
    for (const close of engagementClosersRef.current) close();
    engagementClosersRef.current = [];
  }, [activeMode, refreshToken]);

  const scheduleEngagement = useCallback(() => {
    if (engagementTimerRef.current) return;
    engagementTimerRef.current = setTimeout(async () => {
      engagementTimerRef.current = null;
      const ids: string[] = [];
      for (const id of visibleRef.current) {
        if (!engagementFetchedRef.current.has(id)) ids.push(id);
        if (ids.length >= ENGAGEMENT_BATCH) break;
      }
      if (ids.length === 0) return;
      for (const id of ids) {
        engagementFetchedRef.current.add(id);
        if (!engagementMapRef.current.has(id)) engagementMapRef.current.set(id, { ...EMPTY_ENGAGEMENT });
      }
      const relayUrls = (await getRelayUrls()).slice(0, 4);
      let flush: ReturnType<typeof setTimeout> | null = null;
      const close = subscribeEvents(
        relayUrls,
        { kinds: [1, KIND_REPOST, 7, 9735], '#e': ids, limit: 400 },
        (event) => {
          if (tallyEngagement(event, engagementMapRef.current) && !flush) {
            flush = setTimeout(() => {
              flush = null;
              setEngagement(new Map(engagementMapRef.current));
            }, 300);
          }
        },
        () => setEngagement(new Map(engagementMapRef.current)),
      );
      engagementClosersRef.current.push(close);
      // More may have scrolled into view meanwhile
      if ([...visibleRef.current].some((id) => !engagementFetchedRef.current.has(id))) scheduleEngagement();
    }, 400);
  }, [getRelayUrls]);

  const observerRef = useRef<IntersectionObserver | null>(null);
  useEffect(() => {
    observerRef.current = new IntersectionObserver((entries) => {
      let changed = false;
      for (const entry of entries) {
        const id = (entry.target as HTMLElement).dataset.noteId;
        if (!id) continue;
        if (entry.isIntersecting) { visibleRef.current.add(id); changed = true; }
        else visibleRef.current.delete(id);
      }
      if (changed) scheduleEngagement();
    }, { rootMargin: '300px 0px' });
    return () => {
      observerRef.current?.disconnect();
      if (engagementTimerRef.current) clearTimeout(engagementTimerRef.current);
      for (const close of engagementClosersRef.current) close();
    };
  }, [scheduleEngagement]);

  const observe = useCallback((el: HTMLDivElement | null) => {
    if (el && observerRef.current) observerRef.current.observe(el);
  }, []);

  // ─── Tab handling ─────────────────────────────────────────────
  function handleTabChange(mode: FeedMode) {
    if (mode === activeMode) return;
    setActiveMode(mode);
    saveFeedTab(mode);
    setShowComposer(false);
    listTopRef.current?.scrollIntoView({ block: 'start' });
  }

  function submitHashtag(tag: string) {
    const clean = tag.trim().replace(/^#/, '').toLowerCase();
    setHashtag(clean);
    setHashtagSubmitted(clean);
    saveFeedHashtag(clean);
  }

  function handleHashtagSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (hashtag.trim()) submitHashtag(hashtag);
  }

  // ─── Derived view state ───────────────────────────────────────
  const needsHashtag = activeMode === 'hashtag' && !hashtagSubmitted;
  const noFollows = activeMode === 'following' && followingPubkeys.size === 0;
  const showEmptyState = !loading && notes.length === 0 && !needsHashtag && !noFollows;
  const canCompose = activeMode === 'following' || activeMode === 'global';

  const emptyMessage = useMemo(() => {
    if (loadError) return loadError + ' Check Settings → Relays, or try again.';
    switch (activeMode) {
      case 'following': return 'Nobody you follow has posted in a while.';
      case 'onchain': return 'No on-chain notes found yet — notes tagged #xbt, #onchain or #bip110 and payment invoices show up here.';
      case 'hashtag': return `Nothing tagged #${hashtagSubmitted} on your relays.`;
      default: return 'No notes came back from your relays.';
    }
  }, [activeMode, hashtagSubmitted, loadError]);

  return (
    <div className="flex flex-col min-h-full">
      {/* Sticky tab bar */}
      <div className="sticky top-0 z-20 bg-black/90 backdrop-blur-md border-b border-white/5">
        <div className="flex items-center gap-1 px-3 py-2">
          <div className="flex gap-1 overflow-x-auto scrollbar-none flex-1">
            {TABS.map(({ mode, label, icon: Icon }) => (
              <button
                key={mode}
                onClick={() => handleTabChange(mode)}
                className={`flex items-center gap-1.5 px-3.5 py-2 rounded-full text-[13px] font-medium whitespace-nowrap transition-all ${
                  activeMode === mode
                    ? 'bg-purple-600/20 text-purple-300 border border-purple-500/30'
                    : 'text-gray-400 hover:text-white hover:bg-white/5 border border-transparent'
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                {label}
              </button>
            ))}
          </div>
          <span
            className={`flex items-center gap-1 text-[11px] whitespace-nowrap pl-2 ${
              relayStatus.total === 0 ? 'text-gray-600' : relayStatus.up === 0 ? 'text-red-400' : 'text-gray-500'
            }`}
            title="Relays connected"
          >
            <Radio className="w-3 h-3" />
            {relayStatus.total > 0 ? `${relayStatus.up}/${relayStatus.total} relays` : '…'}
          </span>
        </div>

        {/* Hashtag chips + box */}
        {activeMode === 'hashtag' && (
          <div className="px-3 pb-2.5">
            <div className="flex gap-1.5 flex-wrap mb-2">
              {PRESET_HASHTAGS.map((t) => (
                <button
                  key={t}
                  onClick={() => submitHashtag(t)}
                  className={`px-3 py-1.5 rounded-full text-[13px] font-medium border transition-colors ${
                    hashtagSubmitted === t
                      ? 'bg-purple-600/25 text-purple-200 border-purple-500/40'
                      : 'bg-white/5 text-gray-300 border-white/10 hover:border-white/25'
                  }`}
                >
                  #{t}
                </button>
              ))}
            </div>
            <form onSubmit={handleHashtagSubmit} className="flex gap-2">
              <input
                type="text"
                value={hashtag}
                onChange={(e) => setHashtag(e.target.value)}
                placeholder="any hashtag, e.g. lightning"
                className="flex-1 bg-white/5 border border-white/10 rounded-full px-4 py-2 text-sm outline-none focus:border-purple-500/50"
              />
              <button type="submit" className="px-4 py-2 bg-purple-600 text-white rounded-full text-[13px] font-medium">
                Show
              </button>
            </form>
          </div>
        )}
      </div>

      <div ref={listTopRef} />

      {/* Composer */}
      {canCompose && (
        <div className="px-4 pt-3">
          {showComposer ? (
            <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-3">
              <ComposeNote
                onPublished={() => {
                  setShowComposer(false);
                  // Fetch our own fresh note straight away rather than waiting for the poll
                  setTimeout(async () => {
                    const filter = buildFilter(activeMode);
                    if (!filter) return;
                    const relayUrls = await getRelayUrls();
                    const found: FeedNote[] = [];
                    const close = subscribeFeed(
                      relayUrls,
                      { mode: 'following', pubkeys: [publicKey], limit: 5 },
                      (n) => found.push(n),
                      () => { close(); if (found.length) setNotes((prev) => mergeNotes(prev, found, mutedRef.current)); },
                    );
                  }, 1500);
                }}
              />
              <button onClick={() => setShowComposer(false)} className="mt-2 text-xs text-gray-500 hover:text-gray-300">
                Cancel
              </button>
            </div>
          ) : (
            <button
              onClick={() => setShowComposer(true)}
              className="w-full flex items-center gap-3 rounded-2xl border border-white/10 bg-white/[0.03] hover:bg-white/[0.06] px-4 py-3 text-left transition-colors"
            >
              <PenLine className="w-4 h-4 text-purple-300 flex-shrink-0" />
              <span className="text-[15px] text-gray-400">What's on your mind?</span>
            </button>
          )}
        </div>
      )}

      {/* New notes pill */}
      {pendingNew.length > 0 && (
        <div className="sticky top-[52px] z-10 flex justify-center pt-3 pointer-events-none">
          <button
            onClick={showPending}
            className="pointer-events-auto flex items-center gap-1.5 px-4 py-2 rounded-full bg-purple-600 text-white text-[13px] font-semibold shadow-lg shadow-purple-500/30 hover:bg-purple-500 transition-colors"
          >
            <ArrowUp className="w-3.5 h-3.5" />
            {pendingNew.length} new {pendingNew.length === 1 ? 'note' : 'notes'}
          </button>
        </div>
      )}

      {/* Feed content */}
      <div>
        {loading && notes.length === 0 && <SkeletonFeed count={7} />}

        {!loading && needsHashtag && (
          <div className="flex flex-col items-center justify-center py-16 px-6">
            <Hash className="w-10 h-10 text-gray-700 mb-3" />
            <p className="text-[15px] text-gray-400 text-center">Pick a tag above, or type one, to see what people are saying.</p>
          </div>
        )}

        {!loading && noFollows && (
          <div className="flex flex-col items-center justify-center py-16 px-6">
            <Users className="w-10 h-10 text-gray-700 mb-3" />
            <p className="text-[15px] text-gray-400 text-center">You don't follow anyone yet — find people in Discover, or read Global meanwhile.</p>
            <button onClick={() => handleTabChange('global')} className="mt-4 px-4 py-2 rounded-full bg-white/5 border border-white/10 text-[13px] text-gray-200 hover:bg-white/10">
              Open Global
            </button>
          </div>
        )}

        {showEmptyState && (
          <div className="flex flex-col items-center justify-center py-16 px-6">
            <Inbox className="w-10 h-10 text-gray-700 mb-3" />
            <p className="text-[15px] text-gray-400 text-center">{emptyMessage}</p>
            <button
              onClick={() => loadFeed(activeMode)}
              className="mt-4 flex items-center gap-2 px-4 py-2 rounded-full bg-white/5 border border-white/10 text-[13px] text-gray-200 hover:bg-white/10"
            >
              <RefreshCw className="w-3.5 h-3.5" /> Try again
            </button>
          </div>
        )}

        <div className="divide-y divide-white/5">
          {notes.map((note) => {
            const repost = parseRepost(note);
            if (repost) {
              const byName = displayNameOf(profiles.get(repost.by), repost.by);
              return (
                <div key={note.id} className="px-4 py-3" data-note-id={repost.inner?.id ?? note.id} ref={observe}>
                  <button
                    onClick={() => onViewProfile?.(repost.by)}
                    className="flex items-center gap-1.5 text-[12px] text-gray-500 hover:text-gray-300 mb-2 ml-1"
                  >
                    <Repeat2 className="w-3.5 h-3.5 text-green-500/80" />
                    {byName} reposted · {timeAgo(note.created_at)}
                  </button>
                  {repost.inner ? (
                    <NoteCard
                      note={repost.inner}
                      profile={profiles.get(repost.inner.pubkey)}
                      engagement={engagement.get(repost.inner.id)}
                      onSelectNote={setSelectedNote}
                      onViewProfile={onViewProfile}
                    />
                  ) : (
                    <p className="text-[13px] text-gray-500 ml-1">
                      Reposted a note this relay set doesn't have{repost.innerId ? ` (${repost.innerId.slice(0, 12)}…)` : ''}.
                    </p>
                  )}
                </div>
              );
            }

            if (isLongForm(note)) {
              return (
                <div key={note.id} className="px-4 py-3" data-note-id={note.id} ref={observe}>
                  <LongFormCard
                    note={note}
                    profile={profiles.get(note.pubkey)}
                    engagement={engagement.get(note.id)}
                    onViewProfile={onViewProfile}
                  />
                </div>
              );
            }

            return (
              <div key={note.id} className="px-4 py-3" data-note-id={note.id} ref={observe}>
                <NoteCard
                  note={note}
                  profile={profiles.get(note.pubkey)}
                  engagement={engagement.get(note.id)}
                  onSelectNote={setSelectedNote}
                  onViewProfile={onViewProfile}
                />
              </div>
            );
          })}
        </div>

        {/* Load older */}
        {!loading && notes.length > 0 && (
          <div className="px-4 py-4">
            {exhausted ? (
              <p className="text-center text-[13px] text-gray-600 py-2">
                {notes.length >= FEED_MAX_NOTES ? `Showing the latest ${FEED_MAX_NOTES} notes.` : "That's everything your relays have."}
              </p>
            ) : (
              <button
                onClick={handleLoadMore}
                disabled={loadingMore}
                className="w-full py-3 bg-white/5 hover:bg-white/10 border border-white/10 rounded-xl text-[14px] font-medium text-gray-300 transition-colors flex items-center justify-center gap-2"
              >
                {loadingMore ? (<><Loader2 className="w-4 h-4 animate-spin" /> Loading older notes…</>) : 'Load older'}
              </button>
            )}
          </div>
        )}
      </div>

      {/* Thread Modal */}
      {selectedNote && (
        <NoteThread
          note={selectedNote}
          profiles={profiles}
          onClose={() => setSelectedNote(null)}
          onViewProfile={onViewProfile}
        />
      )}
    </div>
  );
}

// ─── Long-form (kind 30023) card ────────────────────────────────

function LongFormCard({ note, profile, engagement, onViewProfile }: {
  note: FeedNote;
  profile?: ProfileMetadata;
  engagement?: Engagement;
  onViewProfile?: (pubkey: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const meta = useMemo(() => longFormMeta(note), [note]);
  const name = displayNameOf(profile, note.pubkey);

  return (
    <div className="flex gap-3">
      <div className="flex-shrink-0 pt-0.5">
        <ClickableAvatar pubkey={note.pubkey} picture={profile?.picture} name={name} size="lg" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 mb-1.5 text-[13px]">
          <button onClick={() => onViewProfile?.(note.pubkey)} className="font-semibold text-white truncate">{name}</button>
          {profile?.nip05 && <span className="text-gray-500 truncate hidden sm:inline">{profile.nip05}</span>}
          <span className="text-gray-600">· {timeAgo(meta.publishedAt)}</span>
          <span className="ml-auto flex items-center gap-1 text-[11px] text-purple-300/80"><BookOpen className="w-3 h-3" /> Article</span>
        </div>
        <button onClick={() => setOpen((v) => !v)} className="block w-full text-left rounded-xl border border-white/10 bg-white/[0.03] hover:bg-white/[0.05] overflow-hidden transition-colors">
          {meta.image && (
            <img src={meta.image} alt="" className="w-full max-h-48 object-cover" loading="lazy" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
          )}
          <div className="p-3.5">
            <p className="text-[16px] font-semibold text-white leading-snug mb-1">{meta.title}</p>
            <p className="text-[14px] text-gray-400 leading-relaxed whitespace-pre-wrap">
              {open ? note.content : (meta.summary || meta.excerpt)}
            </p>
            <p className="text-[12px] text-purple-300 mt-2">{open ? 'Show less' : 'Read more'}</p>
          </div>
        </button>
        {engagement && (engagement.replies > 0 || engagement.reactions > 0 || engagement.zapSats > 0) && (
          <p className="text-[12px] text-gray-500 mt-2 ml-1">
            {engagement.replies > 0 && `${engagement.replies} replies · `}
            {engagement.reactions > 0 && `${engagement.reactions} reactions · `}
            {engagement.zapSats > 0 && `⚡ ${engagement.zapSats.toLocaleString()} sats`}
          </p>
        )}
      </div>
    </div>
  );
}
