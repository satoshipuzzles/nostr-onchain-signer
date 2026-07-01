import { useState, useMemo } from 'react';
import { type FeedNote } from '@/lib/nostr/feed';
import { type ProfileMetadata } from '@/lib/nostr/social';
import { safeImageUrl } from '@/lib/utils';
import { Image, Clock } from 'lucide-react';

interface Props {
  note: FeedNote;
  profile?: ProfileMetadata | null;
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
  return new Date(timestamp * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function extractHashtags(tags: string[][]): string[] {
  return tags
    .filter((t) => t[0] === 't' && t[1])
    .map((t) => t[1]);
}

function extractImages(content: string): string[] {
  const matches = content.match(IMAGE_REGEX);
  return matches ? [...new Set(matches)] : [];
}

function renderContent(content: string, expanded: boolean): string {
  let text = content.replace(IMAGE_REGEX, '').trim();
  if (!expanded && text.length > MAX_CONTENT_LENGTH) {
    text = text.slice(0, MAX_CONTENT_LENGTH);
  }
  return text;
}

export function NoteCard({ note, profile }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [imageError, setImageError] = useState<Set<string>>(new Set());

  const displayName = profile?.displayName || profile?.name || note.pubkey.slice(0, 12);
  const hashtags = useMemo(() => extractHashtags(note.tags), [note.tags]);
  const images = useMemo(() => extractImages(note.content), [note.content]);
  const textContent = useMemo(() => renderContent(note.content, expanded), [note.content, expanded]);
  const isLong = note.content.replace(IMAGE_REGEX, '').trim().length > MAX_CONTENT_LENGTH;

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
          <p className="text-sm font-medium text-white truncate">{displayName}</p>
          {profile?.nip05 && (
            <p className="text-[10px] text-gray-500 truncate">{profile.nip05}</p>
          )}
        </div>
        <div className="flex items-center gap-1 text-gray-500 flex-shrink-0">
          <Clock className="w-3 h-3" />
          <span className="text-[11px]">{formatTimeAgo(note.created_at)}</span>
        </div>
      </div>

      {/* Content */}
      {textContent && (
        <p className="text-sm text-gray-200 leading-relaxed whitespace-pre-wrap break-words mb-2">
          {textContent}
          {!expanded && isLong && '...'}
        </p>
      )}

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
          {images.filter((url) => !imageError.has(url)).map((url) => (
            <img
              key={url}
              src={url}
              alt=""
              className="w-full rounded-xl object-cover max-h-64 bg-surface-700"
              loading="lazy"
              onError={() => setImageError((prev) => new Set(prev).add(url))}
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
    </div>
  );
}
