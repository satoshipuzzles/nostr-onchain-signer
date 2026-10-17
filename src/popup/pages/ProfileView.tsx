import { useState, useEffect, useMemo } from 'react';
import { ArrowLeft, Copy, Check, BadgeCheck, Zap, Globe, Loader2, MessageCircle } from 'lucide-react';
import { pubkeyToNpub } from '@/lib/nostr/keys';
import { type DiscoveredUser } from '@/lib/nostr/discovery';
import { type FeedNote } from '@/lib/nostr/feed';
import { type ProfileMetadata } from '@/lib/nostr/social';
import { streamQuery, relaysForAuthor, type NEvent } from '@/lib/nostr/query';
import { parseZapReceipt, type ZapReceiptInfo } from '@/lib/nostr/zap';
import { parentOf } from '@/lib/nostr/thread';
import { primeEvent, primeProfiles, profileName } from '@/lib/nostr/nostr-store';
import { NoteCard } from '@/popup/components/NoteCard';
import { NoteThread } from '@/popup/components/NoteThread';
import { ComposeNote } from '@/popup/components/ComposeNote';
import { ZapDialog } from '@/popup/components/ZapDialog';
import { NoteContent, QuotedNote, SelectNoteContext } from '@/popup/components/NoteContent';
import { safeImageUrl, safeHttpUrl } from '@/lib/utils';
import { useProfilePopup } from '@/popup/context/ProfilePopupContext';
import { ClickableAvatar } from '@/popup/components/ClickableAvatar';
import { useProfile, useEngagement } from '@/popup/hooks/useNostr';

interface Props {
  user: DiscoveredUser;
  isFollowing: boolean;
  onFollow: () => void;
  onUnfollow: () => void;
  onBack: () => void;
  onViewProfile?: (pubkey: string) => void;
  /** Read-only view (public page, nobody signed in). */
  guest?: boolean;
}

type ProfileTab = 'notes' | 'replies' | 'reactions' | 'zaps';

interface ReactionEntry {
  eventId: string;
  emoji: string;
  timestamp: number;
  targetNoteId: string;
  targetAuthor?: string;
  relayHint?: string;
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

function toNote(e: NEvent): FeedNote {
  return { id: e.id, pubkey: e.pubkey, content: e.content, created_at: e.created_at, tags: e.tags, kind: e.kind };
}

function ZapRow({ z, onOpen }: { z: ZapReceiptInfo; onOpen: (pk: string) => void }) {
  const sender = z.anonymous ? '' : z.sender;
  const p = useProfile(sender || null);
  return (
    <div className="card w-full text-left">
      <div
        onClick={() => { if (sender) onOpen(sender); }}
        className={`flex items-center gap-3 ${sender ? 'cursor-pointer' : ''}`}
      >
        {sender ? (
          <ClickableAvatar pubkey={sender} picture={p?.picture} name={p?.displayName || p?.name} size="md" />
        ) : (
          <div className="w-9 h-9 rounded-full bg-gradient-to-br from-yellow-500/30 to-bitcoin/30 flex items-center justify-center">
            <Zap className="w-3.5 h-3.5 text-yellow-500" />
          </div>
        )}
        <div className="flex-1 min-w-0">
          <p className="text-sm text-gray-200 truncate">{sender ? profileName(p, sender) : 'Anonymous'}</p>
          <p className="text-[10px] text-gray-500">
            {formatTimeAgo(z.createdAt)}
            {z.eventId ? ' · on a note' : ' · on the profile'}
          </p>
        </div>
        <span className={`text-[9px] font-semibold px-1.5 py-0.5 rounded ${z.chain === 'xbt' ? 'text-purple-300 bg-purple-500/15' : 'text-bitcoin bg-bitcoin/15'}`}>
          {z.chain.toUpperCase()}
        </span>
        <span className="text-sm font-semibold text-yellow-500 flex items-center gap-1">
          <Zap className="w-3 h-3" /> {formatSats(z.amountSats)}
        </span>
      </div>
      {z.comment && (
        <p className="text-xs text-gray-300 mt-2 whitespace-pre-wrap break-words">
          <NoteContent content={z.comment} depth={1} />
        </p>
      )}
    </div>
  );
}

export function ProfileView({ user, isFollowing, onFollow, onUnfollow, onBack, onViewProfile, guest }: Props) {
  const { openProfile } = useProfilePopup();
  const viewProfile = (pubkey: string) => {
    openProfile(pubkey);
    onViewProfile?.(pubkey);
  };
  const [copied, setCopied] = useState('');
  const [activeTab, setActiveTab] = useState<ProfileTab>('notes');
  const [relays, setRelays] = useState<string[] | null>(null);
  const [notes, setNotes] = useState<FeedNote[]>([]);
  const [replies, setReplies] = useState<FeedNote[]>([]);
  const [reactions, setReactions] = useState<ReactionEntry[]>([]);
  const [zaps, setZaps] = useState<ZapReceiptInfo[]>([]);
  const [zapsLoading, setZapsLoading] = useState(true);
  const [loading, setLoading] = useState(true);
  const [selectedNote, setSelectedNote] = useState<FeedNote | null>(null);
  const [showZapDialog, setShowZapDialog] = useState(false);

  const npub = pubkeyToNpub(user.pubkey);
  const storeProfile = useProfile(user.pubkey);
  const profile: ProfileMetadata | undefined = (storeProfile?.name || storeProfile?.displayName) ? storeProfile : (user.profile ?? storeProfile);

  useEffect(() => { if (user.profile) primeProfiles([user.profile]); }, [user.profile]);

  async function copy(text: string, label: string) {
    await navigator.clipboard.writeText(text);
    setCopied(label);
    setTimeout(() => setCopied(''), 2000);
  }

  // Outbox model: their write relays (posts) + read relays (replies, zaps to them)
  useEffect(() => {
    let live = true;
    setRelays(null);
    relaysForAuthor(user.pubkey, { inbox: true }).then((r) => { if (live) setRelays(r); });
    return () => { live = false; };
  }, [user.pubkey]);

  // Zap receipts load with the profile so the total shows in the header
  useEffect(() => {
    if (!relays) return;
    setZaps([]);
    setZapsLoading(true);
    const byId = new Map<string, ZapReceiptInfo>();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => { timer = null; setZaps([...byId.values()].sort((a, b) => b.createdAt - a.createdAt)); };
    return streamQuery({
      relays,
      filters: [{ kinds: [9735], '#p': [user.pubkey], limit: 300 }],
      timeoutMs: 9000,
      onEvent: (e) => {
        const z = parseZapReceipt(e);
        if (!z || z.recipient !== user.pubkey) return;
        byId.set(z.id, z);
        if (!timer) timer = setTimeout(flush, 250);
      },
      onDone: () => { if (timer) clearTimeout(timer); flush(); setZapsLoading(false); },
    });
  }, [relays, user.pubkey]);

  // Notes / replies / reactions: stream per tab
  useEffect(() => {
    if (!relays) return;
    if (activeTab === 'zaps') { setLoading(false); return; }
    setLoading(true);
    const found = new Map<string, NEvent>();
    let timer: ReturnType<typeof setTimeout> | null = null;

    const flush = () => {
      timer = null;
      const list = [...found.values()].sort((a, b) => b.created_at - a.created_at);
      if (activeTab === 'notes') setNotes(list.map(toNote));
      else if (activeTab === 'replies') setReplies(list.map(toNote));
      else if (activeTab === 'reactions') {
        setReactions(list.map((e) => {
          const eTags = e.tags.filter((t) => t[0] === 'e');
          const target = eTags[eTags.length - 1];
          return {
            eventId: e.id,
            emoji: e.content || '❤️',
            timestamp: e.created_at,
            targetNoteId: target?.[1] || '',
            relayHint: target?.[2],
            targetAuthor: e.tags.filter((t) => t[0] === 'p').pop()?.[1],
          };
        }));
      }
    };

    const filter = activeTab === 'reactions'
      ? { kinds: [7], authors: [user.pubkey], limit: 100 }
      : { kinds: activeTab === 'replies' ? [1, 1111] : [1], authors: [user.pubkey], limit: 80 };

    return streamQuery({
      relays,
      filters: [filter],
      timeoutMs: 9000,
      onEvent: (e) => {
        if (e.pubkey !== user.pubkey) return;
        if (activeTab === 'notes' && parentOf(e)) return;
        if (activeTab === 'replies' && !parentOf(e)) return;
        if (activeTab !== 'reactions') primeEvent(e);
        found.set(e.id, e);
        if (!timer) timer = setTimeout(flush, 200);
        setLoading(false);
      },
      onDone: () => { if (timer) clearTimeout(timer); flush(); setLoading(false); },
    });
  }, [activeTab, relays, user.pubkey]);

  const listed = activeTab === 'notes' ? notes : activeTab === 'replies' ? replies : [];
  const listedIds = useMemo(() => listed.map((n) => n.id).slice(0, 100), [listed]);
  const engagement = useEngagement(loading ? [] : listedIds, relays);

  const zapTotal = useMemo(() => zaps.reduce((s, z) => s + z.amountSats, 0), [zaps]);
  const zapByChain = useMemo(() => {
    const t = { xbt: 0, btc: 0 };
    for (const z of zaps) t[z.chain] += z.amountSats;
    return t;
  }, [zaps]);

  const TABS: { id: ProfileTab; label: string }[] = [
    { id: 'notes', label: 'Notes' },
    { id: 'replies', label: 'Replies' },
    { id: 'reactions', label: 'Reactions' },
    { id: 'zaps', label: zaps.length ? `Zaps (${zaps.length})` : 'Zaps' },
  ];

  const showSpinner = (activeTab === 'zaps' ? zapsLoading && zaps.length === 0 : loading && listed.length === 0 && (activeTab !== 'reactions' || reactions.length === 0));

  return (
    <SelectNoteContext.Provider value={setSelectedNote}>
    <div className="h-full flex flex-col overflow-y-auto pb-24">
      {/* Banner / Header */}
      <div className="relative">
        {profile?.banner ? (
          <img src={safeImageUrl(profile.banner)} alt="" className="w-full h-24 object-cover" />
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
            src={safeImageUrl(profile.picture)}
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
          <p className="text-sm text-gray-400 mb-3 leading-relaxed whitespace-pre-wrap break-words">
            <NoteContent content={profile.about} depth={1} stripImages={false} />
          </p>
        )}

        {/* Zap total from receipts */}
        {zapTotal > 0 && (
          <button
            onClick={() => setActiveTab('zaps')}
            className="flex items-center gap-1.5 mb-3 text-xs text-yellow-500 hover:text-yellow-400"
          >
            <Zap className="w-3.5 h-3.5" />
            <span className="font-semibold">{formatSats(zapTotal)} sats</span>
            <span className="text-gray-500">received in {zaps.length} zaps</span>
            {zapByChain.xbt > 0 && <span className="text-purple-300">· XBT {formatSats(zapByChain.xbt)}</span>}
            {zapByChain.btc > 0 && <span className="text-bitcoin">· BTC {formatSats(zapByChain.btc)}</span>}
          </button>
        )}

        {/* Metadata pills */}
        <div className="flex flex-wrap gap-2 mb-4">
          {profile?.lud16Xbt && (
            <span className="flex items-center gap-1 text-xs bg-purple-500/10 text-purple-300 px-2 py-1 rounded-full">
              <Zap className="w-3 h-3" /> XBT {profile.lud16Xbt}
            </span>
          )}
          {profile?.lud16 && (
            <span className="flex items-center gap-1 text-xs bg-yellow-500/10 text-yellow-400 px-2 py-1 rounded-full">
              <Zap className="w-3 h-3" /> {profile.lud16}
            </span>
          )}
          {profile?.website && (
            <a
              href={safeHttpUrl(profile.website)}
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

        {/* Follow + Zap */}
        <div className="flex gap-2 mb-4">
          {!guest && (
            <button
              onClick={isFollowing ? onUnfollow : onFollow}
              className={`flex-1 py-2.5 rounded-lg font-medium text-sm transition-colors ${
                isFollowing
                  ? 'bg-surface-700 text-gray-300 hover:bg-red-500/20 hover:text-red-400'
                  : 'btn-nostr'
              }`}
            >
              {isFollowing ? 'Unfollow' : 'Follow'}
            </button>
          )}
          <button
            onClick={() => setShowZapDialog(true)}
            className={`${guest ? 'flex-1 justify-center' : ''} px-4 py-2.5 rounded-lg font-medium text-sm bg-bitcoin/15 text-bitcoin hover:bg-bitcoin/25 transition-colors flex items-center gap-1.5`}
          >
            <Zap className="w-4 h-4" /> Zap / Tip
          </button>
        </div>

        {/* Comment on profile */}
        {!guest && (
          <div className="mb-4">
            <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-2 flex items-center gap-1">
              <MessageCircle className="w-3 h-3" /> Comment
            </p>
            <ComposeNote
              mentionPubkey={user.pubkey}
              placeholder={`Comment on ${profile?.displayName || profile?.name || 'this profile'}...`}
              onPublished={() => setActiveTab('notes')}
            />
          </div>
        )}
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
        {showSpinner && (
          <div className="flex flex-col items-center justify-center py-8">
            <Loader2 className="w-6 h-6 text-nostr animate-spin mb-2" />
            <p className="text-xs text-gray-400">Loading from their relays...</p>
          </div>
        )}

        {/* Notes / Replies Tabs */}
        {!showSpinner && (activeTab === 'notes' || activeTab === 'replies') && (
          <div>
            {listed.length === 0 ? (
              <p className="text-xs text-gray-500 text-center py-8">
                {activeTab === 'notes' ? 'No notes found' : 'No replies found'}
              </p>
            ) : (
              listed.map((note) => (
                <div key={note.id} className="py-2 border-b border-white/5">
                  <NoteCard
                    note={note}
                    profile={profile}
                    engagement={engagement.get(note.id)}
                    onViewProfile={viewProfile}
                    onSelectNote={setSelectedNote}
                  />
                </div>
              ))
            )}
          </div>
        )}

        {/* Reactions Tab */}
        {!showSpinner && activeTab === 'reactions' && (
          <div>
            {reactions.length === 0 ? (
              <p className="text-xs text-gray-500 text-center py-8">No reactions found</p>
            ) : (
              <div className="space-y-2">
                {reactions.slice(0, 60).map((r) => (
                  <div key={r.eventId} className="card">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-lg">{r.emoji === '+' || r.emoji === '' ? '❤️' : r.emoji === '-' ? '👎' : r.emoji.startsWith(':') ? '✨' : r.emoji}</span>
                      <p className="text-xs text-gray-400 flex-1">Reacted</p>
                      <span className="text-[10px] text-gray-500">{formatTimeAgo(r.timestamp)}</span>
                    </div>
                    {r.targetNoteId && /^[0-9a-f]{64}$/.test(r.targetNoteId) && (
                      <QuotedNote
                        pointer={{ type: 'id', id: r.targetNoteId, author: r.targetAuthor, relays: r.relayHint ? [r.relayHint] : [] }}
                      />
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Zaps Tab */}
        {!showSpinner && activeTab === 'zaps' && (
          <div>
            {zapTotal > 0 && (
              <div className="card mb-3 flex flex-col items-center justify-center gap-1 py-4">
                <div className="flex items-center gap-2">
                  <Zap className="w-5 h-5 text-yellow-500" />
                  <span className="text-lg font-bold text-yellow-500">{formatSats(zapTotal)}</span>
                  <span className="text-sm text-gray-400">sats received</span>
                </div>
                <p className="text-[11px] text-gray-500">
                  {zaps.length} zaps
                  {zapByChain.xbt > 0 && <> · XBT Lightning {formatSats(zapByChain.xbt)}</>}
                  {zapByChain.btc > 0 && <> · BTC Lightning {formatSats(zapByChain.btc)}</>}
                </p>
              </div>
            )}

            {zaps.length === 0 ? (
              <p className="text-xs text-gray-500 text-center py-8">No zaps found</p>
            ) : (
              <div className="space-y-2">
                {zaps.map((z) => <ZapRow key={z.id} z={z} onOpen={viewProfile} />)}
              </div>
            )}
          </div>
        )}

        {!showSpinner && (activeTab === 'zaps' ? zapsLoading : loading) && (
          <div className="flex items-center justify-center py-3 text-[11px] text-gray-500 gap-2">
            <Loader2 className="w-3.5 h-3.5 animate-spin" /> Still loading…
          </div>
        )}
      </div>

      {selectedNote && (
        <NoteThread
          note={selectedNote}
          profiles={new Map(profile ? [[user.pubkey, profile]] : [])}
          onClose={() => setSelectedNote(null)}
          onViewProfile={viewProfile}
        />
      )}

      {showZapDialog && (
        <ZapDialog
          recipientPubkey={user.pubkey}
          profile={profile}
          onClose={() => setShowZapDialog(false)}
        />
      )}
    </div>
    </SelectNoteContext.Provider>
  );
}
