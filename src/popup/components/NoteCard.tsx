import { useState, useMemo, useRef, useEffect, useContext, memo } from 'react';
import { toast } from 'sonner';
import { type FeedNote } from '@/lib/nostr/feed';
import { type ProfileMetadata } from '@/lib/nostr/social';
import { safeImageUrl } from '@/lib/utils';
import {
  Clock, MessageCircle, Repeat2, Heart, Zap, Link2, Check, Loader2,
  MoreHorizontal, Copy, ExternalLink, Flag,
} from 'lucide-react';
import { AuthContext } from '@/popup/context/AuthContext';
import { createMessageId } from '@/shared/messages';
import { publishEvent } from '@/lib/nostr/discovery';
import { KIND, type SignedEvent } from '@/lib/nostr/events';
import { loadRelayList, getWriteRelays } from '@/lib/nostr/relays';
import { ReplyComposer } from './ReplyComposer';
import { ZapDialog } from './ZapDialog';
import { bech32 } from '@scure/base';
import { hexToBytes } from '@noble/hashes/utils';
import { useProfilePopup } from '@/popup/context/ProfilePopupContext';
import { ClickableAvatar } from './ClickableAvatar';
import { NoteContent, SelectNoteContext, contentIsLong } from './NoteContent';
import { useProfile } from '@/popup/hooks/useNostr';
import { streamQuery, relaysForAuthor } from '@/lib/nostr/query';
import { parseZapReceipt } from '@/lib/nostr/zap';
import { eventRelayHints } from '@/lib/nostr/thread';
import { profileName } from '@/lib/nostr/nostr-store';

export interface NoteEngagement {
  replies: number;
  reposts: number;
  reactions: number;
  zapSats: number;
}

interface Props {
  note: FeedNote;
  profile?: ProfileMetadata | null;
  engagement?: NoteEngagement;
  onNotePublished?: () => void;
  onSelectNote?: (note: FeedNote) => void;
  onViewProfile?: (pubkey: string) => void;
  highlighted?: boolean;
  compact?: boolean;
}

const IMAGE_REGEX = /https?:\/\/\S+\.(jpg|jpeg|png|gif|webp)(\?\S*)?/gi;
const MAX_CONTENT_LENGTH = 280;

function formatTimeAgo(timestamp: number): string {
  const now = Math.floor(Date.now() / 1000);
  const diff = now - timestamp;

  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d`;
  return new Date(timestamp * 1000).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });
}

function extractHashtags(tags: string[][]): string[] {
  return tags.filter((t) => t[0] === 't' && t[1]).map((t) => t[1]);
}

function encodeNoteId(eventId: string): string {
  const bytes = hexToBytes(eventId);
  const words = bech32.toWords(bytes);
  return bech32.encode('note', words, 1000);
}

function formatSats(amount: number): string {
  if (amount >= 1_000_000) return `${(amount / 1_000_000).toFixed(1)}M`;
  if (amount >= 1_000) return `${(amount / 1_000).toFixed(amount >= 10_000 ? 0 : 1)}k`;
  return amount.toString();
}

interface ZapperInfo {
  id: string;
  pubkey: string;
  amount: number;
  timestamp: number;
  comment: string;
  chain: 'xbt' | 'btc';
}

function ZapperRow({ z, onOpen }: { z: ZapperInfo; onOpen: (pubkey: string) => void }) {
  const p = useProfile(z.pubkey || null);
  return (
    <div
      onClick={() => { if (z.pubkey) onOpen(z.pubkey); }}
      className="flex items-center gap-2 w-full text-left hover:bg-surface-600 rounded-lg px-1.5 py-1 transition-colors cursor-pointer"
    >
      {z.pubkey ? (
        <ClickableAvatar pubkey={z.pubkey} picture={p?.picture} name={p?.displayName || p?.name} size="xs" />
      ) : (
        <div className="w-5 h-5 rounded-full bg-surface-600" />
      )}
      <span className="text-[11px] text-gray-300 truncate flex-1" title={z.comment || undefined}>
        {z.pubkey ? profileName(p, z.pubkey) : 'anon'}
        {z.comment && <span className="text-gray-500"> · {z.comment}</span>}
      </span>
      <span className={`text-[9px] font-semibold px-1 rounded ${z.chain === 'xbt' ? 'text-purple-300 bg-purple-500/15' : 'text-bitcoin bg-bitcoin/15'}`}>
        {z.chain.toUpperCase()}
      </span>
      <span className="text-[11px] text-yellow-500 font-medium">{formatSats(z.amount)}</span>
    </div>
  );
}

interface ReactionGroup {
  emoji: string;
  count: number;
  pubkeys: string[];
}

// Memoized: the feed re-renders frequently as engagement counts stream in,
// and re-rendering every card each time is the main scroll-jank source
export const NoteCard = memo(function NoteCard({ note, profile: profileProp, engagement, onNotePublished, onSelectNote, onViewProfile, highlighted, compact }: Props) {
  const auth = useContext(AuthContext);
  const publicKey = auth?.publicKey ?? '';
  // Fall back to the shared profile store when the page didn't pass one
  const storeProfile = useProfile(profileProp ? null : note.pubkey);
  const profile = profileProp ?? storeProfile;
  const { openProfile } = useProfilePopup();
  const viewProfile = (pubkey: string) => {
    openProfile(pubkey);
    onViewProfile?.(pubkey);
  };
  const [expanded, setExpanded] = useState(false);
  const [imageError, setImageError] = useState<Set<string>>(new Set());

  const [liked, setLiked] = useState(false);
  const [boosted, setBoosted] = useState(false);
  const [showReply, setShowReply] = useState(false);
  const [replyMode, setReplyMode] = useState<'reply' | 'quote'>('reply');
  const [showZapDialog, setShowZapDialog] = useState(false);
  const [showBoostMenu, setShowBoostMenu] = useState(false);
  const [copied, setCopied] = useState(false);
  const [actionPending, setActionPending] = useState<string | null>(null);

  // Three-dot menu
  const [showMoreMenu, setShowMoreMenu] = useState(false);
  const [menuToast, setMenuToast] = useState('');
  const moreMenuRef = useRef<HTMLDivElement>(null);

  // Reactions
  const [reactions, setReactions] = useState<ReactionGroup[]>([]);
  const [totalReactions, setTotalReactions] = useState(0);
  const [userReacted, setUserReacted] = useState(false);

  // Zap tallies
  const [zapTotal, setZapTotal] = useState(0);
  const [zappers, setZappers] = useState<ZapperInfo[]>([]);
  const [showZappers, setShowZappers] = useState(false);
  const zappersRef = useRef<HTMLDivElement>(null);

  const boostMenuRef = useRef<HTMLDivElement>(null);

  // Fetch reactions and zaps — only in thread view (highlighted).
  // In feed lists this would open hundreds of relay subscriptions;
  // the feed provides batched counts via the `engagement` prop instead.
  useEffect(() => {
    if (!highlighted) return;
    let cancelled = false;
    let cancel: (() => void) | null = null;
    const reactionMap = new Map<string, { count: number; pubkeys: string[] }>();
    const zapList: ZapperInfo[] = [];
    const seen = new Set<string>();
    let timer: ReturnType<typeof setTimeout> | null = null;

    const flush = () => {
      timer = null;
      if (cancelled) return;
      const groups: ReactionGroup[] = Array.from(reactionMap.entries())
        .map(([emoji, data]) => ({ emoji, count: data.count, pubkeys: data.pubkeys }))
        .sort((a, b) => b.count - a.count);
      setReactions(groups);
      setTotalReactions(groups.reduce((sum, g) => sum + g.count, 0));
      setZappers([...zapList].sort((a, b) => b.amount - a.amount));
      setZapTotal(zapList.reduce((sum, z) => sum + z.amount, 0));
    };

    relaysForAuthor(note.pubkey, { inbox: true, hints: eventRelayHints(note) }).then((relays) => {
      if (cancelled) return;
      cancel = streamQuery({
        relays,
        filters: [
          { kinds: [7], '#e': [note.id], limit: 300 },
          { kinds: [9735], '#e': [note.id], limit: 300 },
        ],
        timeoutMs: 9000,
        onEvent: (event) => {
          if (cancelled || seen.has(event.id)) return;
          seen.add(event.id);
          if (event.kind === 7) {
            // Only reactions aimed at this note (last e tag), not at a reply that tags it
            const eTags = event.tags.filter((t) => t[0] === 'e');
            if (eTags.length && eTags[eTags.length - 1][1] !== note.id) return;
            const emoji = event.content || '+';
            const normalized = emoji === '+' || emoji === '' ? '❤️' : emoji === '-' ? '👎' : emoji;
            const existing = reactionMap.get(normalized);
            if (existing) {
              existing.count++;
              existing.pubkeys.push(event.pubkey);
            } else {
              reactionMap.set(normalized, { count: 1, pubkeys: [event.pubkey] });
            }
            if (publicKey && event.pubkey === publicKey) {
              setUserReacted(true);
              setLiked(true);
            }
          } else if (event.kind === 9735) {
            const z = parseZapReceipt(event);
            if (!z || z.eventId !== note.id) return;
            zapList.push({
              id: z.id, pubkey: z.anonymous ? '' : z.sender, amount: z.amountSats,
              timestamp: z.createdAt, comment: z.comment, chain: z.chain,
            });
          }
          if (!timer) timer = setTimeout(flush, 250);
        },
        onDone: () => { if (timer) clearTimeout(timer); flush(); },
      });
    });

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      cancel?.();
    };
  }, [note.id, publicKey, highlighted]);

  useEffect(() => {
    if (!showBoostMenu) return;
    function handleClickOutside(e: MouseEvent) {
      if (
        boostMenuRef.current &&
        !boostMenuRef.current.contains(e.target as Node)
      ) {
        setShowBoostMenu(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showBoostMenu]);

  useEffect(() => {
    if (!showMoreMenu) return;
    function handleClickOutside(e: MouseEvent) {
      if (moreMenuRef.current && !moreMenuRef.current.contains(e.target as Node)) {
        setShowMoreMenu(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showMoreMenu]);

  useEffect(() => {
    if (!showZappers) return;
    function handleClickOutside(e: MouseEvent) {
      if (zappersRef.current && !zappersRef.current.contains(e.target as Node)) {
        setShowZappers(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showZappers]);

  const displayName =
    profile?.displayName || profile?.name || note.pubkey.slice(0, 12);
  const hashtags = useMemo(() => extractHashtags(note.tags), [note.tags]);
  const images = useMemo(() => [...new Set(note.content.match(IMAGE_REGEX) ?? [])], [note.content]);
  const hasText = useMemo(() => note.content.replace(IMAGE_REGEX, '').trim().length > 0, [note.content]);
  const isLong = useMemo(() => contentIsLong(note.content, note.tags, MAX_CONTENT_LENGTH), [note.content, note.tags]);

  function requireLogin(action: string): boolean {
    if (publicKey) return true;
    toast.info(`Open the app and sign in to ${action}`);
    return false;
  }

  async function signAndPublish(
    event: Record<string, unknown>,
  ): Promise<SignedEvent> {
    const response = await chrome.runtime.sendMessage({
      type: 'nip07:signEvent',
      payload: { event },
      id: createMessageId(),
    });
    if (response.error) throw new Error(response.error);
    await publishEvent(response.result);
    return response.result;
  }

  async function handleLike() {
    if (liked || actionPending === 'like') return;
    if (!requireLogin('react')) return;
    setActionPending('like');
    try {
      await signAndPublish({
        kind: KIND.REACTION,
        pubkey: publicKey,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['e', note.id],
          ['p', note.pubkey],
        ],
        content: '+',
      });
      setLiked(true);
      setUserReacted(true);
      setTotalReactions((prev) => prev + 1);
    } catch (err) {
      console.error('Failed to like:', err);
      toast.error('Failed to publish reaction');
    } finally {
      setActionPending(null);
    }
  }

  async function handleRepost() {
    if (boosted || actionPending === 'boost') return;
    if (!requireLogin('repost')) return;
    setActionPending('boost');
    try {
      const relayList = await loadRelayList();
      const relays = getWriteRelays(relayList);
      const relayUrl = relays[0] || '';

      await signAndPublish({
        kind: KIND.REPOST,
        pubkey: publicKey,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['e', note.id, relayUrl],
          ['p', note.pubkey],
        ],
        content: JSON.stringify({
          id: note.id,
          pubkey: note.pubkey,
          content: note.content,
          created_at: note.created_at,
          tags: note.tags,
          kind: note.kind,
        }),
      });
      setBoosted(true);
    } catch (err) {
      console.error('Failed to repost:', err);
      toast.error('Failed to publish repost');
    } finally {
      setActionPending(null);
      setShowBoostMenu(false);
    }
  }

  function handleQuoteBoost() {
    setShowBoostMenu(false);
    if (!requireLogin('quote')) return;
    setReplyMode('quote');
    setShowReply(true);
  }

  function handleCopyLink() {
    try {
      const noteId = encodeNoteId(note.id);
      navigator.clipboard.writeText(`nostr:${noteId}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  }

  // Three-dot menu actions
  function handleCopyEventId() {
    navigator.clipboard.writeText(note.id);
    setMenuToast('Event ID copied');
    setShowMoreMenu(false);
    setTimeout(() => setMenuToast(''), 2000);
  }

  function handleCopyNoteUrl() {
    const noteId = encodeNoteId(note.id);
    navigator.clipboard.writeText(`https://njump.me/${noteId}`);
    setMenuToast('Note URL copied');
    setShowMoreMenu(false);
    setTimeout(() => setMenuToast(''), 2000);
  }

  function handleCopyEventJson() {
    const json = JSON.stringify({
      id: note.id,
      pubkey: note.pubkey,
      content: note.content,
      created_at: note.created_at,
      tags: note.tags,
      kind: note.kind,
    }, null, 2);
    navigator.clipboard.writeText(json);
    setMenuToast('Event JSON copied');
    setShowMoreMenu(false);
    setTimeout(() => setMenuToast(''), 2000);
  }

  function handleViewOnNjump() {
    const noteId = encodeNoteId(note.id);
    window.open(`https://njump.me/${noteId}`, '_blank');
    setShowMoreMenu(false);
  }

  function handleReport() {
    setMenuToast('Reported');
    setShowMoreMenu(false);
    setTimeout(() => setMenuToast(''), 2000);
  }

  const noteRef = `nostr:${encodeNoteId(note.id)}`;

  return (
    <SelectNoteContext.Provider value={onSelectNote ?? null}>
    <div className={`relative ${highlighted ? 'bg-purple-500/5 ring-1 ring-purple-500/20 rounded-xl px-1' : ''} ${compact ? 'py-1' : ''}`}>
      {/* Three-dot menu */}
      <div className="absolute top-2 right-2 z-10" ref={moreMenuRef}>
        <button
          onClick={() => setShowMoreMenu(!showMoreMenu)}
          className="p-1.5 rounded-lg text-gray-500 hover:text-white hover:bg-surface-700 transition-colors"
        >
          <MoreHorizontal className="w-4 h-4" />
        </button>

        {showMoreMenu && (
          <div className="absolute top-full right-0 mt-1 bg-surface-700 rounded-xl shadow-xl border border-surface-200/10 overflow-hidden min-w-[180px] z-20">
            <button
              onClick={handleCopyEventId}
              className="w-full text-left px-3 py-2.5 text-xs text-gray-300 hover:bg-surface-600 hover:text-white transition-colors flex items-center gap-2"
            >
              <Copy className="w-3.5 h-3.5" /> Copy Event ID
            </button>
            <button
              onClick={handleCopyNoteUrl}
              className="w-full text-left px-3 py-2.5 text-xs text-gray-300 hover:bg-surface-600 hover:text-white transition-colors flex items-center gap-2 border-t border-surface-200/10"
            >
              <Link2 className="w-3.5 h-3.5" /> Copy Note URL
            </button>
            <button
              onClick={handleCopyEventJson}
              className="w-full text-left px-3 py-2.5 text-xs text-gray-300 hover:bg-surface-600 hover:text-white transition-colors flex items-center gap-2 border-t border-surface-200/10"
            >
              <Copy className="w-3.5 h-3.5" /> Copy Event JSON
            </button>
            <button
              onClick={handleViewOnNjump}
              className="w-full text-left px-3 py-2.5 text-xs text-gray-300 hover:bg-surface-600 hover:text-white transition-colors flex items-center gap-2 border-t border-surface-200/10"
            >
              <ExternalLink className="w-3.5 h-3.5" /> View on njump.me
            </button>
            <button
              onClick={handleReport}
              className="w-full text-left px-3 py-2.5 text-xs text-red-400 hover:bg-red-500/10 transition-colors flex items-center gap-2 border-t border-surface-200/10"
            >
              <Flag className="w-3.5 h-3.5" /> Report
            </button>
          </div>
        )}
      </div>

      {/* Toast */}
      {menuToast && (
        <div className="absolute top-2 left-1/2 -translate-x-1/2 bg-green-500/20 text-green-400 text-xs font-medium px-3 py-1.5 rounded-lg border border-green-500/30 z-20">
          {menuToast}
        </div>
      )}

      {/* Jumble-style layout: avatar column left, content column right */}
      <div className="flex gap-3">
        <div className="flex-shrink-0 pt-0.5">
          <ClickableAvatar
            pubkey={note.pubkey}
            picture={profile?.picture}
            name={displayName}
            size="lg"
          />
        </div>

        <div className="flex-1 min-w-0">
      {/* Author header */}
      <div className="flex items-center gap-1.5 mb-1 pr-8">
        <button
          onClick={() => viewProfile(note.pubkey)}
          className="min-w-0 flex items-baseline gap-1.5 text-left"
        >
          <span className="text-sm font-semibold text-white truncate">
            {displayName}
          </span>
          {profile?.nip05 && (
            <span className="text-[10px] text-gray-500 truncate hidden sm:inline">
              {profile.nip05}
            </span>
          )}
        </button>
        <span className="text-gray-600 text-[11px]">·</span>
        <div className="flex items-center gap-1 text-gray-500 flex-shrink-0">
          <Clock className="w-3 h-3" />
          <span className="text-[11px]">{formatTimeAgo(note.created_at)}</span>
        </div>
      </div>

      {/* Content */}
      <div
        className={`${isLong && !expanded ? 'cursor-pointer' : ''} ${onSelectNote ? 'cursor-pointer' : ''}`}
        onClick={() => {
          if (isLong && !expanded) {
            setExpanded(true);
          } else if (onSelectNote) {
            onSelectNote(note);
          }
        }}
      >
        {hasText && (
          <p className="text-sm text-gray-200 leading-relaxed whitespace-pre-wrap break-words mb-2">
            <NoteContent
              content={note.content}
              tags={note.tags}
              maxLength={expanded ? undefined : MAX_CONTENT_LENGTH}
            />
          </p>
        )}
      </div>

      {/* Show more / less */}
      {isLong && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="text-xs text-nostr hover:text-nostr/80 font-medium mb-2"
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}

      {/* Inline Images */}
      {images.length > 0 && (
        <div className={`mt-2 ${images.filter((url) => !imageError.has(url)).length > 1 ? 'grid grid-cols-2 gap-2' : 'space-y-2'}`}>
          {images
            .filter((url) => !imageError.has(url))
            .map((url) => (
              <img
                key={url}
                src={safeImageUrl(url)}
                alt=""
                className="w-full h-auto rounded-xl mt-2 max-h-[400px] object-contain bg-surface-700"
                loading="lazy"
                onError={() =>
                  setImageError((prev) => new Set(prev).add(url))
                }
              />
            ))}
        </div>
      )}

      {/* Hashtags */}
      {hashtags.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mt-2.5">
          {hashtags.map((tag) => (
            <span
              key={tag}
              className="px-2 py-0.5 text-[10px] font-medium rounded-full bg-nostr/15 text-nostr border border-nostr/20"
            >
              #{tag}
            </span>
          ))}
        </div>
      )}

      {/* Emoji Reactions Display */}
      {reactions.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mt-2.5">
          {reactions.slice(0, 8).map((group) => (
            <span
              key={group.emoji}
              className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] rounded-full bg-surface-700/80 text-gray-300 border border-surface-200/10"
            >
              {group.emoji} <span className="text-gray-400">{group.count}</span>
            </span>
          ))}
        </div>
      )}

      {/* Action Buttons */}
      <div className="flex items-center justify-between mt-3 pt-2.5 border-t border-surface-200/10">
        {/* Reply */}
        <button
          onClick={() => {
            if (!requireLogin('reply')) return;
            setReplyMode('reply');
            setShowReply(!showReply);
          }}
          className={`flex items-center gap-1 px-2 py-1 rounded-lg text-xs transition-colors ${
            showReply && replyMode === 'reply'
              ? 'text-blue-400'
              : 'text-gray-500 hover:text-blue-400 hover:bg-blue-400/10'
          }`}
        >
          <MessageCircle className="w-4 h-4" />
          {(engagement?.replies ?? 0) > 0 && (
            <span className="text-[11px]">{engagement!.replies}</span>
          )}
        </button>

        {/* Boost / Repost */}
        <div className="relative" ref={boostMenuRef}>
          <button
            onClick={() => setShowBoostMenu(!showBoostMenu)}
            disabled={actionPending === 'boost'}
            className={`flex items-center gap-1 px-2 py-1 rounded-lg text-xs transition-colors ${
              boosted
                ? 'text-green-400'
                : 'text-gray-500 hover:text-green-400 hover:bg-green-400/10'
            }`}
          >
            {actionPending === 'boost' ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Repeat2 className="w-4 h-4" />
            )}
            {(engagement?.reposts ?? 0) > 0 && (
              <span className="text-[11px]">{engagement!.reposts}</span>
            )}
          </button>

          {showBoostMenu && (
            <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 bg-surface-700 rounded-lg border border-surface-200/10 shadow-xl overflow-hidden z-10 min-w-[120px]">
              <button
                onClick={handleRepost}
                disabled={boosted}
                className="w-full text-left px-3 py-2 text-xs text-gray-300 hover:bg-surface-600 hover:text-white transition-colors flex items-center gap-2 disabled:opacity-50"
              >
                <Repeat2 className="w-3.5 h-3.5" />
                Repost
              </button>
              <button
                onClick={handleQuoteBoost}
                className="w-full text-left px-3 py-2 text-xs text-gray-300 hover:bg-surface-600 hover:text-white transition-colors flex items-center gap-2 border-t border-surface-200/10"
              >
                <MessageCircle className="w-3.5 h-3.5" />
                Quote
              </button>
            </div>
          )}
        </div>

        {/* Like */}
        <button
          onClick={handleLike}
          disabled={liked || actionPending === 'like'}
          className={`flex items-center gap-1 px-2 py-1 rounded-lg text-xs transition-colors ${
            liked || userReacted
              ? 'text-red-400'
              : 'text-gray-500 hover:text-red-400 hover:bg-red-400/10'
          }`}
        >
          {actionPending === 'like' ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Heart className={`w-4 h-4 ${liked || userReacted ? 'fill-current' : ''}`} />
          )}
          {(totalReactions > 0 || (engagement?.reactions ?? 0) > 0) && (
            <span className="text-[11px]">{Math.max(totalReactions, engagement?.reactions ?? 0)}</span>
          )}
        </button>

        {/* Zap with tally */}
        <div className="relative" ref={zappersRef}>
          <button
            onClick={() => {
              if (zappers.length > 0) {
                setShowZappers(!showZappers);
              } else {
                setShowZapDialog(true);
              }
            }}
            className="flex items-center gap-1 px-2 py-1 rounded-lg text-xs text-gray-500 hover:text-bitcoin hover:bg-bitcoin/10 transition-colors"
          >
            <Zap className={`w-4 h-4 ${(zapTotal > 0 || (engagement?.zapSats ?? 0) > 0) ? 'text-yellow-500' : ''}`} />
            {(zapTotal > 0 || (engagement?.zapSats ?? 0) > 0) && (
              <span className="text-[11px] text-yellow-500 font-medium">
                {formatSats(Math.max(zapTotal, engagement?.zapSats ?? 0))}
              </span>
            )}
          </button>

          {/* Zappers popup */}
          {showZappers && zappers.length > 0 && (
            <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 bg-surface-700 rounded-xl shadow-xl border border-surface-200/10 p-3 min-w-[220px] max-h-[200px] overflow-y-auto z-20">
              <div className="flex items-center justify-between mb-2">
                <p className="text-xs font-semibold text-yellow-500 flex items-center gap-1">
                  <Zap className="w-3 h-3" /> {formatSats(zapTotal)} sats
                </p>
                <button
                  onClick={() => setShowZapDialog(true)}
                  className="text-[10px] text-bitcoin hover:text-bitcoin/80 font-medium"
                >
                  Zap
                </button>
              </div>
              <div className="space-y-1.5">
                {zappers.slice(0, 20).map((z) => (
                  <ZapperRow key={z.id} z={z} onOpen={(pk) => { viewProfile(pk); setShowZappers(false); }} />
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Copy Link */}
        <button
          onClick={handleCopyLink}
          className={`flex items-center gap-1 px-2 py-1 rounded-lg text-xs transition-colors ${
            copied
              ? 'text-green-400'
              : 'text-gray-500 hover:text-nostr hover:bg-nostr/10'
          }`}
        >
          {copied ? (
            <Check className="w-4 h-4" />
          ) : (
            <Link2 className="w-4 h-4" />
          )}
        </button>
      </div>

      {/* Inline Reply / Quote Composer */}
      {showReply && (
        <ReplyComposer
          parentNote={note}
          mode={replyMode}
          noteRef={replyMode === 'quote' ? noteRef : undefined}
          onClose={() => {
            setShowReply(false);
            setReplyMode('reply');
          }}
          onPublished={onNotePublished}
        />
      )}
        </div>
      </div>

      {/* Zap Dialog */}
      {showZapDialog && (
        <ZapDialog
          note={note}
          recipientPubkey={note.pubkey}
          profile={profile}
          onClose={() => setShowZapDialog(false)}
        />
      )}
    </div>
    </SelectNoteContext.Provider>
  );
});
