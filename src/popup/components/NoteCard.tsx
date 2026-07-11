import { useState, useMemo, useRef, useEffect, type ReactNode } from 'react';
import { type FeedNote, type NostrEvent, subscribeEvents } from '@/lib/nostr/feed';
import { type ProfileMetadata } from '@/lib/nostr/social';
import { safeImageUrl } from '@/lib/utils';
import {
  Clock, MessageCircle, Repeat2, Heart, Zap, Link2, Check, Loader2,
  MoreHorizontal, Copy, ExternalLink, Flag,
} from 'lucide-react';
import { useAuth } from '@/popup/context/AuthContext';
import { createMessageId } from '@/shared/messages';
import { publishEvent } from '@/lib/nostr/discovery';
import { KIND, type SignedEvent } from '@/lib/nostr/events';
import { loadRelayList, getWriteRelays, getReadRelays } from '@/lib/nostr/relays';
import { ReplyComposer } from './ReplyComposer';
import { ZapDialog } from './ZapDialog';
import { bech32 } from '@scure/base';
import { hexToBytes } from '@noble/hashes/utils';
import { getCachedProfile } from '@/lib/nostr/cache';
import { useProfilePopup } from '@/popup/context/ProfilePopupContext';
import { ClickableAvatar } from './ClickableAvatar';

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
const URL_SPLIT_REGEX = /(https?:\/\/[^\s]+)/g;

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

function renderRichContent(
  content: string,
  expanded: boolean,
): { textParts: ReactNode[]; images: string[] } {
  let text = content.replace(IMAGE_REGEX, '').trim();
  if (!expanded && text.length > MAX_CONTENT_LENGTH) {
    text = text.slice(0, MAX_CONTENT_LENGTH);
  }

  const images: string[] = [];
  const rawImages = content.match(IMAGE_REGEX);
  if (rawImages) {
    for (const url of rawImages) {
      if (!images.includes(url)) images.push(url);
    }
  }

  const parts = text.split(URL_SPLIT_REGEX);
  const rendered: ReactNode[] = [];

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part) continue;
    if (/^https?:\/\//.test(part)) {
      rendered.push(
        <a
          key={i}
          href={part}
          target="_blank"
          rel="noopener noreferrer"
          className="text-blue-400 hover:underline break-all"
        >
          {part}
        </a>,
      );
    } else {
      rendered.push(<span key={i}>{part}</span>);
    }
  }

  return { textParts: rendered, images };
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
  pubkey: string;
  amount: number;
  timestamp: number;
  profile?: ProfileMetadata | null;
}

interface ReactionGroup {
  emoji: string;
  count: number;
  pubkeys: string[];
}

export function NoteCard({ note, profile, engagement, onNotePublished, onSelectNote, onViewProfile, highlighted, compact }: Props) {
  const { publicKey } = useAuth();
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
    const cleanups: (() => void)[] = [];

    async function fetchMetadata() {
      const relayList = await loadRelayList();
      const relays = getReadRelays(relayList);
      const relayUrls = relays.length > 0
        ? relays.slice(0, 3)
        : ['wss://relay.damus.io', 'wss://nos.lol'];

      // Fetch reactions (kind 7) for this note
      const reactionMap = new Map<string, { count: number; pubkeys: string[] }>();
      const cleanup1 = subscribeEvents(
        relayUrls,
        { kinds: [7], '#e': [note.id], limit: 100 },
        (event: NostrEvent) => {
          if (cancelled) return;
          const emoji = event.content || '+';
          const normalized = emoji === '+' || emoji === '' ? '❤️' : emoji;
          const existing = reactionMap.get(normalized);
          if (existing) {
            existing.count++;
            existing.pubkeys.push(event.pubkey);
          } else {
            reactionMap.set(normalized, { count: 1, pubkeys: [event.pubkey] });
          }
          if (event.pubkey === publicKey) {
            setUserReacted(true);
            setLiked(true);
          }
          const groups: ReactionGroup[] = Array.from(reactionMap.entries())
            .map(([emoji, data]) => ({ emoji, count: data.count, pubkeys: data.pubkeys }))
            .sort((a, b) => b.count - a.count);
          setReactions(groups);
          setTotalReactions(groups.reduce((sum, g) => sum + g.count, 0));
        },
      );
      cleanups.push(cleanup1);

      // Fetch zaps (kind 9735) for this note
      const zapList: ZapperInfo[] = [];
      const cleanup2 = subscribeEvents(
        relayUrls,
        { kinds: [9735], '#e': [note.id], limit: 50 },
        (event: NostrEvent) => {
          if (cancelled) return;
          let amount = 0;
          let zapperPubkey = '';

          // Parse bolt11 amount from description tag or content
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

          // Try bolt11 tag for amount
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

          if (amount > 0 || zapperPubkey) {
            zapList.push({
              pubkey: zapperPubkey,
              amount,
              timestamp: event.created_at,
            });
            setZappers([...zapList].sort((a, b) => b.amount - a.amount));
            setZapTotal(zapList.reduce((sum, z) => sum + z.amount, 0));
          }
        },
      );
      cleanups.push(cleanup2);
    }

    fetchMetadata();

    return () => {
      cancelled = true;
      cleanups.forEach((fn) => fn());
    };
  }, [note.id, publicKey]);

  // Resolve zapper profiles
  useEffect(() => {
    async function resolveZapperProfiles() {
      const updated = [...zappers];
      let changed = false;
      for (const zapper of updated) {
        if (zapper.pubkey && !zapper.profile) {
          const p = await getCachedProfile(zapper.pubkey);
          if (p) {
            zapper.profile = p;
            changed = true;
          }
        }
      }
      if (changed) setZappers([...updated]);
    }
    if (zappers.length > 0) resolveZapperProfiles();
  }, [zappers.length]);

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
  const { textParts, images } = useMemo(
    () => renderRichContent(note.content, expanded),
    [note.content, expanded],
  );
  const isLong =
    note.content.replace(IMAGE_REGEX, '').trim().length > MAX_CONTENT_LENGTH;

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
    } finally {
      setActionPending(null);
    }
  }

  async function handleRepost() {
    if (boosted || actionPending === 'boost') return;
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
    } finally {
      setActionPending(null);
      setShowBoostMenu(false);
    }
  }

  function handleQuoteBoost() {
    setShowBoostMenu(false);
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
        {textParts.length > 0 && (
          <p className="text-sm text-gray-200 leading-relaxed whitespace-pre-wrap break-words mb-2">
            {textParts}
            {!expanded && isLong && '...'}
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
                src={url}
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
                {zappers.slice(0, 10).map((z, i) => (
                  <div
                    key={`${z.pubkey}-${i}`}
                    onClick={() => {
                      if (z.pubkey) viewProfile(z.pubkey);
                      setShowZappers(false);
                    }}
                    className="flex items-center gap-2 w-full text-left hover:bg-surface-600 rounded-lg px-1.5 py-1 transition-colors cursor-pointer"
                  >
                    {z.pubkey ? (
                      <ClickableAvatar
                        pubkey={z.pubkey}
                        picture={z.profile?.picture}
                        name={z.profile?.displayName || z.profile?.name}
                        size="xs"
                      />
                    ) : (
                      <div className="w-5 h-5 rounded-full bg-surface-600" />
                    )}
                    <span className="text-[11px] text-gray-300 truncate flex-1">
                      {z.profile?.displayName || z.profile?.name || z.pubkey?.slice(0, 8) || 'anon'}
                    </span>
                    <span className="text-[11px] text-yellow-500 font-medium">
                      {formatSats(z.amount)}
                    </span>
                  </div>
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
  );
}
