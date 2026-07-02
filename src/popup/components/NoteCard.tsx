import { useState, useMemo, useRef, useEffect, type ReactNode } from 'react';
import { type FeedNote } from '@/lib/nostr/feed';
import { type ProfileMetadata } from '@/lib/nostr/social';
import { safeImageUrl } from '@/lib/utils';
import {
  Clock, MessageCircle, Repeat2, Heart, Zap, Link2, Check, Loader2,
} from 'lucide-react';
import { useAuth } from '@/popup/context/AuthContext';
import { createMessageId } from '@/shared/messages';
import { publishEvent } from '@/lib/nostr/discovery';
import { KIND, type SignedEvent } from '@/lib/nostr/events';
import { loadRelayList, getWriteRelays } from '@/lib/nostr/relays';
import { ReplyComposer } from './ReplyComposer';
import { ZapDialog } from './ZapDialog';
import { bech32 } from '@scure/base';
import { hexToBytes } from '@noble/hashes/utils';

interface Props {
  note: FeedNote;
  profile?: ProfileMetadata | null;
  onNotePublished?: () => void;
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

export function NoteCard({ note, profile, onNotePublished }: Props) {
  const { publicKey } = useAuth();
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

  const boostMenuRef = useRef<HTMLDivElement>(null);

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

  const noteRef = `nostr:${encodeNoteId(note.id)}`;

  return (
    <div className="card mb-3">
      {/* Author Header */}
      <div className="flex items-center gap-2.5 mb-2.5">
        {profile?.picture ? (
          <img
            src={safeImageUrl(profile.picture)}
            alt=""
            className="w-9 h-9 rounded-full object-cover bg-surface-700 flex-shrink-0"
          />
        ) : (
          <div className="w-9 h-9 rounded-full bg-gradient-to-br from-nostr/40 to-bitcoin/30 flex items-center justify-center flex-shrink-0">
            <span className="text-xs font-bold text-white/80">
              {displayName.charAt(0).toUpperCase()}
            </span>
          </div>
        )}
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-white truncate">
            {displayName}
          </p>
          {profile?.nip05 && (
            <p className="text-[10px] text-gray-500 truncate">
              {profile.nip05}
            </p>
          )}
        </div>
        <div className="flex items-center gap-1 text-gray-500 flex-shrink-0">
          <Clock className="w-3 h-3" />
          <span className="text-[11px]">{formatTimeAgo(note.created_at)}</span>
        </div>
      </div>

      {/* Content */}
      <div
        className={isLong && !expanded ? 'cursor-pointer' : ''}
        onClick={() => {
          if (isLong && !expanded) setExpanded(true);
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
        <div className="mt-2 space-y-2">
          {images
            .filter((url) => !imageError.has(url))
            .map((url) => (
              <img
                key={url}
                src={url}
                alt=""
                className="w-full rounded-xl object-cover max-h-64 bg-surface-700"
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
            liked
              ? 'text-red-400'
              : 'text-gray-500 hover:text-red-400 hover:bg-red-400/10'
          }`}
        >
          {actionPending === 'like' ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Heart className={`w-4 h-4 ${liked ? 'fill-current' : ''}`} />
          )}
        </button>

        {/* Zap */}
        <button
          onClick={() => setShowZapDialog(true)}
          className="flex items-center gap-1 px-2 py-1 rounded-lg text-xs text-gray-500 hover:text-bitcoin hover:bg-bitcoin/10 transition-colors"
        >
          <Zap className="w-4 h-4" />
        </button>

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

      {/* Zap Dialog */}
      {showZapDialog && (
        <ZapDialog
          note={note}
          profile={profile}
          onClose={() => setShowZapDialog(false)}
        />
      )}
    </div>
  );
}
