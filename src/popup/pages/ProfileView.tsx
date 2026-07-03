import { useState, useEffect, useRef, useCallback } from 'react';
import { ArrowLeft, Copy, Check, ExternalLink, BadgeCheck, Zap, Globe, Loader2 } from 'lucide-react';
import { pubkeyToNpub } from '@/lib/nostr/keys';
import { type DiscoveredUser } from '@/lib/nostr/discovery';
import { type FeedNote, type NostrEvent, subscribeEvents } from '@/lib/nostr/feed';
import { type ProfileMetadata } from '@/lib/nostr/social';
import { loadRelayList, getReadRelays } from '@/lib/nostr/relays';
import { getCachedProfile } from '@/lib/nostr/cache';
import { NoteCard } from '@/popup/components/NoteCard';
import { safeImageUrl } from '@/lib/utils';

interface Props {
  user: DiscoveredUser;
  isFollowing: boolean;
  onFollow: () => void;
  onUnfollow: () => void;
  onBack: () => void;
  onViewProfile?: (pubkey: string) => void;
}

type ProfileTab = 'notes' | 'replies' | 'reactions' | 'zaps';

interface ZapReceipt {
  zapperPubkey: string;
  amount: number;
  timestamp: number;
  zapperProfile?: ProfileMetadata | null;
}

interface ReactionEntry {
  eventId: string;
  emoji: string;
  timestamp: number;
  targetNoteId: string;
}

function formatSats(amount: number): string {
  if (amount >= 1_000_000) return `${(amount / 1_000_000).toFixed(1)}M`;
  if (amount >= 1_000) return `${(amount / 1_000).toFixed(amount >= 10_000 ? 0 : 1)}k`;
  return amount.toLocaleString();
}

function formatTimeAgo(timestamp: number): string {
  const now = Math.floor(Date.now() / 1000);
  const diff = now - timestamp;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d`;
  return new Date(timestamp * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function ProfileView({ user, isFollowing, onFollow, onUnfollow, onBack, onViewProfile }: Props) {
  const [copied, setCopied] = useState('');
  const [activeTab, setActiveTab] = useState<ProfileTab>('notes');
  const [notes, setNotes] = useState<FeedNote[]>([]);
  const [replies, setReplies] = useState<FeedNote[]>([]);
  const [reactions, setReactions] = useState<ReactionEntry[]>([]);
  const [zaps, setZaps] = useState<ZapReceipt[]>([]);
  const [zapTotal, setZapTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [profiles, setProfiles] = useState<Map<string, ProfileMetadata>>(new Map());
  const cleanupRef = useRef<(() => void)[]>([]);

  const npub = pubkeyToNpub(user.pubkey);
  const profile = user.profile;

  async function copy(text: string, label: string) {
    await navigator.clipboard.writeText(text);
    setCopied(label);
    setTimeout(() => setCopied(''), 2000);
  }

  const resolveProfile = useCallback(async (pubkey: string) => {
    if (profiles.has(pubkey)) return;
    const cached = await getCachedProfile(pubkey);
    if (cached) {
      setProfiles((prev) => {
        const next = new Map(prev);
        next.set(pubkey, cached);
        return next;
      });
    }
  }, [profiles]);

  useEffect(() => {
    return () => {
      cleanupRef.current.forEach((fn) => fn());
      cleanupRef.current = [];
    };
  }, []);

  useEffect(() => {
    cleanupRef.current.forEach((fn) => fn());
    cleanupRef.current = [];
    setLoading(true);

    async function load() {
      const relayList = await loadRelayList();
      const relays = getReadRelays(relayList);
      const relayUrls = relays.length > 0
        ? relays.slice(0, 3)
        : ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.snort.social'];

      if (activeTab === 'notes') {
        const collected: FeedNote[] = [];
        const cleanup = subscribeEvents(
          relayUrls,
          { kinds: [1], authors: [user.pubkey], limit: 50 },
          (event: NostrEvent) => {
            const hasETag = event.tags.some((t) => t[0] === 'e');
            if (!hasETag) {
              collected.push({
                id: event.id,
                pubkey: event.pubkey,
                content: event.content,
                created_at: event.created_at,
                tags: event.tags,
                kind: event.kind,
              });
              setNotes([...collected].sort((a, b) => b.created_at - a.created_at));
            }
          },
          () => setLoading(false),
        );
        cleanupRef.current.push(cleanup);
        setTimeout(() => setLoading(false), 12000);
      } else if (activeTab === 'replies') {
        const collected: FeedNote[] = [];
        const cleanup = subscribeEvents(
          relayUrls,
          { kinds: [1], authors: [user.pubkey], limit: 50 },
          (event: NostrEvent) => {
            const hasETag = event.tags.some((t) => t[0] === 'e');
            if (hasETag) {
              collected.push({
                id: event.id,
                pubkey: event.pubkey,
                content: event.content,
                created_at: event.created_at,
                tags: event.tags,
                kind: event.kind,
              });
              setReplies([...collected].sort((a, b) => b.created_at - a.created_at));
            }
          },
          () => setLoading(false),
        );
        cleanupRef.current.push(cleanup);
        setTimeout(() => setLoading(false), 12000);
      } else if (activeTab === 'reactions') {
        const collected: ReactionEntry[] = [];
        const cleanup = subscribeEvents(
          relayUrls,
          { kinds: [7], authors: [user.pubkey], limit: 100 },
          (event: NostrEvent) => {
            const eTag = event.tags.find((t) => t[0] === 'e');
            collected.push({
              eventId: event.id,
              emoji: event.content || '❤️',
              timestamp: event.created_at,
              targetNoteId: eTag?.[1] || '',
            });
            setReactions([...collected].sort((a, b) => b.timestamp - a.timestamp));
          },
          () => setLoading(false),
        );
        cleanupRef.current.push(cleanup);
        setTimeout(() => setLoading(false), 12000);
      } else if (activeTab === 'zaps') {
        const collected: ZapReceipt[] = [];
        const cleanup = subscribeEvents(
          relayUrls,
          { kinds: [9735], '#p': [user.pubkey], limit: 100 },
          (event: NostrEvent) => {
            let amount = 0;
            let zapperPubkey = '';

            const descTag = event.tags.find((t) => t[0] === 'description');
            if (descTag && descTag[1]) {
              try {
                const zapReq = JSON.parse(descTag[1]);
                zapperPubkey = zapReq.pubkey || '';
                const amountTag = zapReq.tags?.find((t: string[]) => t[0] === 'amount');
                if (amountTag) {
                  amount = Math.floor(parseInt(amountTag[1], 10) / 1000);
                }
              } catch { /* ignore */ }
            }

            if (!zapperPubkey) {
              const pTag = event.tags.find((t) => t[0] === 'P');
              if (pTag) zapperPubkey = pTag[1];
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

            collected.push({
              zapperPubkey,
              amount,
              timestamp: event.created_at,
            });
            const sorted = [...collected].sort((a, b) => b.amount - a.amount);
            setZaps(sorted);
            setZapTotal(sorted.reduce((sum, z) => sum + z.amount, 0));

            if (zapperPubkey) resolveProfile(zapperPubkey);
          },
          () => setLoading(false),
        );
        cleanupRef.current.push(cleanup);
        setTimeout(() => setLoading(false), 12000);
      }
    }

    load();
  }, [activeTab, user.pubkey]);

  // Resolve zapper profiles once loaded
  useEffect(() => {
    async function resolve() {
      let changed = false;
      const updated = [...zaps];
      for (const z of updated) {
        if (z.zapperPubkey && !z.zapperProfile) {
          const p = await getCachedProfile(z.zapperPubkey);
          if (p) {
            z.zapperProfile = p;
            changed = true;
          }
        }
      }
      if (changed) setZaps([...updated]);
    }
    if (zaps.length > 0) resolve();
  }, [zaps.length]);

  const TABS: { id: ProfileTab; label: string }[] = [
    { id: 'notes', label: 'Notes' },
    { id: 'replies', label: 'Replies' },
    { id: 'reactions', label: 'Reactions' },
    { id: 'zaps', label: 'Zaps' },
  ];

  return (
    <div className="h-full flex flex-col overflow-y-auto pb-24">
      {/* Banner / Header */}
      <div className="relative">
        {profile?.banner ? (
          <img src={profile.banner} alt="" className="w-full h-24 object-cover" />
        ) : (
          <div className="w-full h-24 bg-gradient-to-br from-bitcoin/20 to-nostr/20" />
        )}
        <button
          onClick={onBack}
          className="absolute top-3 left-3 btn-back bg-black/60 backdrop-blur"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>
      </div>

      {/* Avatar */}
      <div className="px-4 -mt-8 relative z-10">
        {profile?.picture ? (
          <img
            src={profile.picture}
            alt=""
            className="w-16 h-16 rounded-full object-cover border-4 border-surface-900 bg-surface-700"
          />
        ) : (
          <div className="w-16 h-16 rounded-full border-4 border-surface-900 bg-gradient-to-br from-bitcoin/40 to-nostr/40 flex items-center justify-center">
            <span className="text-xl font-bold text-white/80">
              {(profile?.displayName || profile?.name || '?').charAt(0).toUpperCase()}
            </span>
          </div>
        )}
      </div>

      {/* Info */}
      <div className="px-4 pt-3 pb-4">
        <div className="flex items-center gap-2 mb-1">
          <h2 className="text-lg font-bold">
            {profile?.displayName || profile?.name || 'Unknown'}
          </h2>
          {profile?.nip05 && <BadgeCheck className="w-4 h-4 text-nostr" />}
        </div>

        {profile?.nip05 && (
          <p className="text-sm text-nostr/80 mb-2">{profile.nip05}</p>
        )}

        {profile?.about && (
          <p className="text-sm text-gray-400 mb-3 leading-relaxed">{profile.about}</p>
        )}

        {/* Metadata pills */}
        <div className="flex flex-wrap gap-2 mb-4">
          {profile?.lud16 && (
            <span className="flex items-center gap-1 text-xs bg-yellow-500/10 text-yellow-400 px-2 py-1 rounded-full">
              <Zap className="w-3 h-3" /> {profile.lud16}
            </span>
          )}
          {profile?.website && (
            <a
              href={profile.website}
              target="_blank"
              rel="noopener"
              className="flex items-center gap-1 text-xs bg-surface-700 text-gray-400 px-2 py-1 rounded-full hover:text-white"
            >
              <Globe className="w-3 h-3" /> {profile.website.replace(/^https?:\/\//, '')}
            </a>
          )}
        </div>

        {/* npub */}
        <div className="card mb-3">
          <p className="text-xs text-gray-500 mb-1">npub</p>
          <div className="flex items-center gap-2">
            <code className="text-xs text-gray-300 truncate flex-1 font-mono">
              {npub}
            </code>
            <button onClick={() => copy(npub, 'npub')} className="p-1 hover:bg-surface-700 rounded">
              {copied === 'npub' ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3 text-gray-500" />}
            </button>
          </div>
        </div>

        {/* Hex pubkey */}
        <div className="card mb-4">
          <p className="text-xs text-gray-500 mb-1">Hex Public Key</p>
          <div className="flex items-center gap-2">
            <code className="text-xs text-gray-300 truncate flex-1 font-mono">
              {user.pubkey}
            </code>
            <button onClick={() => copy(user.pubkey, 'hex')} className="p-1 hover:bg-surface-700 rounded">
              {copied === 'hex' ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3 text-gray-500" />}
            </button>
          </div>
        </div>

        {/* Follow/Unfollow */}
        <button
          onClick={isFollowing ? onUnfollow : onFollow}
          className={`w-full py-2.5 rounded-lg font-medium text-sm transition-colors ${
            isFollowing
              ? 'bg-surface-700 text-gray-300 hover:bg-red-500/20 hover:text-red-400'
              : 'btn-nostr'
          }`}
        >
          {isFollowing ? 'Unfollow' : 'Follow'}
        </button>
      </div>

      {/* Profile Tabs */}
      <div className="px-4 border-b border-surface-200/10">
        <div className="flex">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex-1 py-2.5 text-xs font-medium text-center transition-colors relative ${
                activeTab === tab.id
                  ? 'text-white'
                  : 'text-gray-500 hover:text-gray-300'
              }`}
            >
              {tab.label}
              {activeTab === tab.id && (
                <div className="absolute bottom-0 left-2 right-2 h-0.5 bg-nostr rounded-full" />
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Tab Content */}
      <div className="px-4 pt-3 flex-1">
        {loading && (
          <div className="flex flex-col items-center justify-center py-8">
            <Loader2 className="w-6 h-6 text-nostr animate-spin mb-2" />
            <p className="text-xs text-gray-400">Loading...</p>
          </div>
        )}

        {/* Notes Tab */}
        {!loading && activeTab === 'notes' && (
          <div>
            {notes.length === 0 ? (
              <p className="text-xs text-gray-500 text-center py-8">No notes found</p>
            ) : (
              notes.map((note) => (
                <NoteCard
                  key={note.id}
                  note={note}
                  profile={user.profile}
                  onViewProfile={onViewProfile}
                />
              ))
            )}
          </div>
        )}

        {/* Replies Tab */}
        {!loading && activeTab === 'replies' && (
          <div>
            {replies.length === 0 ? (
              <p className="text-xs text-gray-500 text-center py-8">No replies found</p>
            ) : (
              replies.map((note) => (
                <NoteCard
                  key={note.id}
                  note={note}
                  profile={user.profile}
                  onViewProfile={onViewProfile}
                />
              ))
            )}
          </div>
        )}

        {/* Reactions Tab */}
        {!loading && activeTab === 'reactions' && (
          <div>
            {reactions.length === 0 ? (
              <p className="text-xs text-gray-500 text-center py-8">No reactions found</p>
            ) : (
              <div className="space-y-2">
                {reactions.map((r) => (
                  <div
                    key={r.eventId}
                    className="card flex items-center gap-3"
                  >
                    <span className="text-lg">{r.emoji === '+' || r.emoji === '' ? '❤️' : r.emoji}</span>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs text-gray-400 truncate">
                        Reacted to {r.targetNoteId ? r.targetNoteId.slice(0, 12) + '...' : 'a note'}
                      </p>
                    </div>
                    <span className="text-[10px] text-gray-500">{formatTimeAgo(r.timestamp)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Zaps Tab */}
        {!loading && activeTab === 'zaps' && (
          <div>
            {/* Total zaps received */}
            {zapTotal > 0 && (
              <div className="card mb-3 flex items-center justify-center gap-2 py-4">
                <Zap className="w-5 h-5 text-yellow-500" />
                <span className="text-lg font-bold text-yellow-500">{formatSats(zapTotal)}</span>
                <span className="text-sm text-gray-400">sats received</span>
              </div>
            )}

            {zaps.length === 0 ? (
              <p className="text-xs text-gray-500 text-center py-8">No zaps found</p>
            ) : (
              <div className="space-y-2">
                {zaps.map((z, i) => (
                  <button
                    key={`${z.zapperPubkey}-${i}`}
                    onClick={() => {
                      if (z.zapperPubkey) onViewProfile?.(z.zapperPubkey);
                    }}
                    className="card flex items-center gap-3 w-full text-left hover:bg-surface-700/80 transition-colors"
                  >
                    {z.zapperProfile?.picture ? (
                      <img
                        src={safeImageUrl(z.zapperProfile.picture)}
                        alt=""
                        className="w-8 h-8 rounded-full object-cover bg-surface-700"
                      />
                    ) : (
                      <div className="w-8 h-8 rounded-full bg-gradient-to-br from-yellow-500/30 to-bitcoin/30 flex items-center justify-center">
                        <Zap className="w-3.5 h-3.5 text-yellow-500" />
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-gray-200 truncate">
                        {z.zapperProfile?.displayName || z.zapperProfile?.name || z.zapperPubkey?.slice(0, 12) || 'Anonymous'}
                      </p>
                      <p className="text-[10px] text-gray-500">{formatTimeAgo(z.timestamp)}</p>
                    </div>
                    <span className="text-sm font-semibold text-yellow-500 flex items-center gap-1">
                      <Zap className="w-3 h-3" /> {formatSats(z.amount)}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
