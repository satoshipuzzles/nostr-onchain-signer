import { useState, useEffect, useRef, useCallback } from 'react';
import { subscribeFeed, subscribeEvents, type FeedNote, type NostrEvent, type FeedMode, type FeedFilter } from '@/lib/nostr/feed';
import { loadRelayList, getReadRelays } from '@/lib/nostr/relays';
import { getCachedProfile, resolveProfiles } from '@/lib/nostr/cache';
import { type ProfileMetadata } from '@/lib/nostr/social';
import { NoteCard } from '@/popup/components/NoteCard';
import { NoteThread } from '@/popup/components/NoteThread';
import { ArrowLeft, Globe, Users, Image, Bitcoin, Hash, Layers, Loader2, Inbox } from 'lucide-react';

interface Props {
  publicKey: string;
  followingPubkeys: Set<string>;
  onBack: () => void;
  onViewProfile?: (pubkey: string) => void;
}

const TABS: { mode: FeedMode; label: string; icon: typeof Globe }[] = [
  { mode: 'global', label: 'Global', icon: Globe },
  { mode: 'following', label: 'Following', icon: Users },
  { mode: 'media', label: 'Media', icon: Image },
  { mode: 'onchain', label: 'On-Chain', icon: Bitcoin },
  { mode: 'hashtag', label: 'Hashtag', icon: Hash },
  { mode: 'kind', label: 'Kind', icon: Layers },
];

export interface Engagement {
  replies: number;
  reposts: number;
  reactions: number;
  zapSats: number;
}

export function Feed({ publicKey, followingPubkeys, onBack, onViewProfile }: Props) {
  const [activeMode, setActiveMode] = useState<FeedMode>('global');
  const [notes, setNotes] = useState<FeedNote[]>([]);
  const [profiles, setProfiles] = useState<Map<string, ProfileMetadata>>(new Map());
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hashtag, setHashtag] = useState('');
  const [kindInput, setKindInput] = useState('');
  const [hashtagSubmitted, setHashtagSubmitted] = useState('');
  const [kindSubmitted, setKindSubmitted] = useState<number | null>(null);
  const [selectedNote, setSelectedNote] = useState<FeedNote | null>(null);
  const [engagement, setEngagement] = useState<Map<string, Engagement>>(new Map());
  const cleanupRef = useRef<(() => void) | null>(null);
  const engagementCleanupRef = useRef<(() => void) | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const loadFeed = useCallback(async (mode: FeedMode, append = false) => {
    if (cleanupRef.current) {
      cleanupRef.current();
      cleanupRef.current = null;
    }

    if (!append) {
      setNotes([]);
      setLoading(true);
    } else {
      setLoadingMore(true);
    }

    const relayList = await loadRelayList();
    const relays = getReadRelays(relayList);
    const relayUrls = relays.length > 0
      ? relays
      : ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.snort.social'];

    const filter: FeedFilter = {
      mode,
      limit: 50,
    };

    if (mode === 'following') {
      filter.pubkeys = Array.from(followingPubkeys);
    }

    if (mode === 'hashtag') {
      if (!hashtagSubmitted) {
        setLoading(false);
        return;
      }
      filter.hashtag = hashtagSubmitted;
    }

    if (mode === 'kind') {
      if (kindSubmitted === null) {
        setLoading(false);
        return;
      }
      filter.kind = kindSubmitted;
    }

    if (append && notes.length > 0) {
      const oldest = Math.min(...notes.map((n) => n.created_at));
      filter.until = oldest - 1;
    }

    const collected: FeedNote[] = [];

    const cleanup = subscribeFeed(
      relayUrls,
      filter,
      (note) => {
        collected.push(note);
        const sorted = [...collected].sort((a, b) => b.created_at - a.created_at);
        if (append) {
          setNotes((prev) => {
            const ids = new Set(prev.map((n) => n.id));
            const newNotes = sorted.filter((n) => !ids.has(n.id));
            return [...prev, ...newNotes];
          });
        } else {
          setNotes(sorted);
        }
        resolveProfile(note.pubkey);
      },
      () => {
        setLoading(false);
        setLoadingMore(false);
      }
    );

    cleanupRef.current = cleanup;

    setTimeout(() => {
      setLoading(false);
      setLoadingMore(false);
    }, 15000);
  }, [followingPubkeys, hashtagSubmitted, kindSubmitted, notes]);

  const profileFetchingRef = useRef<Set<string>>(new Set());

  const resolveProfile = useCallback(async (pubkey: string) => {
    if (profiles.has(pubkey) || profileFetchingRef.current.has(pubkey)) return;
    profileFetchingRef.current.add(pubkey);

    const cached = await getCachedProfile(pubkey);
    if (cached) {
      setProfiles((prev) => {
        const next = new Map(prev);
        next.set(pubkey, cached);
        return next;
      });
      return;
    }

    // Fetch from relays if not in cache
    const relayList = await loadRelayList();
    const relays = getReadRelays(relayList);
    const relayUrls = relays.length > 0
      ? relays.slice(0, 3)
      : ['wss://relay.damus.io', 'wss://nos.lol', 'wss://purplepag.es'];

    const resolved = await resolveProfiles([pubkey], relayUrls);
    const profile = resolved.get(pubkey);
    if (profile) {
      setProfiles((prev) => {
        const next = new Map(prev);
        next.set(pubkey, profile);
        return next;
      });
    }
  }, [profiles]);

  useEffect(() => {
    loadFeed(activeMode);
    return () => {
      if (cleanupRef.current) {
        cleanupRef.current();
      }
    };
  }, [activeMode, hashtagSubmitted, kindSubmitted]);

  // Batch fetch engagement (replies, reposts, reactions, zaps) for visible notes
  useEffect(() => {
    if (notes.length === 0) return;

    if (engagementCleanupRef.current) {
      engagementCleanupRef.current();
      engagementCleanupRef.current = null;
    }

    const noteIds = notes.map((n) => n.id);
    const engMap = new Map<string, Engagement>();
    for (const id of noteIds) {
      engMap.set(id, { replies: 0, reposts: 0, reactions: 0, zapSats: 0 });
    }

    async function fetchEngagement() {
      const relayList = await loadRelayList();
      const relays = getReadRelays(relayList);
      const relayUrls = relays.length > 0
        ? relays.slice(0, 3)
        : ['wss://relay.damus.io', 'wss://nos.lol'];

      const cleanup = subscribeEvents(
        relayUrls,
        { kinds: [1, 6, 7, 9735], '#e': noteIds, limit: 500 },
        (event: NostrEvent) => {
          const eTag = event.tags.find((t) => t[0] === 'e');
          if (!eTag) return;
          const targetId = eTag[1];
          const entry = engMap.get(targetId);
          if (!entry) return;

          if (event.kind === 1) entry.replies++;
          else if (event.kind === 6) entry.reposts++;
          else if (event.kind === 7) entry.reactions++;
          else if (event.kind === 9735) {
            let amount = 0;
            const descTag = event.tags.find((t) => t[0] === 'description');
            if (descTag && descTag[1]) {
              try {
                const zapReq = JSON.parse(descTag[1]);
                const amountTag = zapReq.tags?.find((t: string[]) => t[0] === 'amount');
                if (amountTag) amount = Math.floor(parseInt(amountTag[1], 10) / 1000);
              } catch { /* ignore */ }
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
            entry.zapSats += amount;
          }

          setEngagement(new Map(engMap));
        },
      );

      engagementCleanupRef.current = cleanup;
    }

    fetchEngagement();

    return () => {
      if (engagementCleanupRef.current) {
        engagementCleanupRef.current();
        engagementCleanupRef.current = null;
      }
    };
  }, [notes.length > 0 ? notes.map(n => n.id).join(',') : '']);

  function handleTabChange(mode: FeedMode) {
    setActiveMode(mode);
    if (scrollRef.current) {
      scrollRef.current.scrollTop = 0;
    }
  }

  function handleHashtagSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (hashtag.trim()) {
      setHashtagSubmitted(hashtag.trim());
    }
  }

  function handleKindSubmit(e: React.FormEvent) {
    e.preventDefault();
    const num = parseInt(kindInput, 10);
    if (!isNaN(num) && num >= 0) {
      setKindSubmitted(num);
    }
  }

  function handleLoadMore() {
    loadFeed(activeMode, true);
  }

  const showEmptyState = !loading && notes.length === 0;
  const needsInput = (activeMode === 'hashtag' && !hashtagSubmitted) ||
                     (activeMode === 'kind' && kindSubmitted === null);

  return (
    <div className="h-full flex flex-col pb-20 md:pb-0">
      {/* Header */}
      <div className="page-header px-4">
        <button onClick={onBack} className="btn-back">
          <ArrowLeft className="w-5 h-5" />
        </button>
        <h1>Feed</h1>
      </div>

      {/* Tabs */}
      <div className="px-4 pb-2">
        <div className="flex gap-1 overflow-x-auto scrollbar-none pb-1">
          {TABS.map(({ mode, label, icon: Icon }) => (
            <button
              key={mode}
              onClick={() => handleTabChange(mode)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-colors ${
                activeMode === mode
                  ? 'bg-nostr/20 text-nostr border border-nostr/30'
                  : 'bg-surface-800 text-gray-400 border border-surface-200/10 hover:text-white'
              }`}
            >
              <Icon className="w-3.5 h-3.5" />
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Hashtag Input */}
      {activeMode === 'hashtag' && (
        <form onSubmit={handleHashtagSubmit} className="px-4 pb-3">
          <div className="flex gap-2">
            <input
              type="text"
              value={hashtag}
              onChange={(e) => setHashtag(e.target.value)}
              placeholder="Enter hashtag (e.g. bitcoin)"
              className="input-field flex-1 !py-2 !min-h-[40px] text-sm"
            />
            <button type="submit" className="btn-nostr !px-3 !py-2 !min-h-[40px] text-sm">
              Search
            </button>
          </div>
        </form>
      )}

      {/* Kind Input */}
      {activeMode === 'kind' && (
        <form onSubmit={handleKindSubmit} className="px-4 pb-3">
          <div className="flex gap-2">
            <input
              type="number"
              value={kindInput}
              onChange={(e) => setKindInput(e.target.value)}
              placeholder="Kind number (e.g. 30023)"
              className="input-field flex-1 !py-2 !min-h-[40px] text-sm"
              min="0"
            />
            <button type="submit" className="btn-nostr !px-3 !py-2 !min-h-[40px] text-sm">
              Search
            </button>
          </div>
        </form>
      )}

      {/* Feed Content */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 pb-24">
        {/* Loading */}
        {loading && (
          <div className="flex flex-col items-center justify-center py-12">
            <Loader2 className="w-8 h-8 text-nostr animate-spin mb-3" />
            <p className="text-sm text-gray-400">Loading notes...</p>
          </div>
        )}

        {/* Empty: needs input */}
        {!loading && needsInput && (
          <div className="flex flex-col items-center justify-center py-12">
            {activeMode === 'hashtag' ? (
              <>
                <Hash className="w-10 h-10 text-gray-600 mb-3" />
                <p className="text-sm text-gray-400 text-center">Enter a hashtag to search for notes</p>
              </>
            ) : (
              <>
                <Layers className="w-10 h-10 text-gray-600 mb-3" />
                <p className="text-sm text-gray-400 text-center">Enter a kind number to search</p>
              </>
            )}
          </div>
        )}

        {/* Empty: no results */}
        {showEmptyState && !needsInput && (
          <div className="flex flex-col items-center justify-center py-12">
            <Inbox className="w-10 h-10 text-gray-600 mb-3" />
            <p className="text-sm text-gray-400 text-center">
              {activeMode === 'following' && followingPubkeys.size === 0
                ? 'Follow some people to see their notes here'
                : 'No notes found for this feed'}
            </p>
          </div>
        )}

        {/* Notes */}
        {notes.map((note) => (
          <NoteCard
            key={note.id}
            note={note}
            profile={profiles.get(note.pubkey)}
            engagement={engagement.get(note.id)}
            onSelectNote={setSelectedNote}
            onViewProfile={onViewProfile}
          />
        ))}

        {/* Load More */}
        {!loading && notes.length > 0 && (
          <button
            onClick={handleLoadMore}
            disabled={loadingMore}
            className="btn-secondary w-full flex items-center justify-center gap-2 mt-2"
          >
            {loadingMore ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Loading...
              </>
            ) : (
              'Load more'
            )}
          </button>
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
