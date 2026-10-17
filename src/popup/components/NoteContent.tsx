import { useMemo, useContext, createContext, type ReactNode } from 'react';
import { nip19 } from 'nostr-tools';
import { ExternalLink, Loader2 } from 'lucide-react';
import { tokenizeContent, truncateTokens, tokensLength, IMAGE_URL_RE, type ContentToken } from '@/lib/nostr/content';
import { type EventPointer, profileName } from '@/lib/nostr/nostr-store';
import { safeHttpUrl, safeImageUrl } from '@/lib/utils';
import { useProfile, useNostrEvent } from '@/popup/hooks/useNostr';
import { useProfilePopup } from '@/popup/context/ProfilePopupContext';
import type { FeedNote } from '@/lib/nostr/feed';
import { ClickableAvatar } from './ClickableAvatar';

/** Lets an embedded quote open its note in whatever thread view the page has. */
export const SelectNoteContext = createContext<((note: FeedNote) => void) | null>(null);

function timeAgo(ts: number): string {
  const diff = Math.floor(Date.now() / 1000) - ts;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d`;
  return new Date(ts * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** @Name link for a pubkey; opens the profile popup. */
export function Mention({ pubkey, relays }: { pubkey: string; relays?: string[] }) {
  const profile = useProfile(pubkey, relays);
  const { openProfile } = useProfilePopup();
  let fallback = '';
  try { fallback = nip19.npubEncode(pubkey).slice(0, 12) + '…'; } catch { fallback = pubkey.slice(0, 8); }
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); openProfile(pubkey); }}
      className="text-purple-300 hover:text-purple-200 hover:underline font-medium break-all"
      title={profile?.nip05 || undefined}
    >
      @{profileName(profile, pubkey, fallback)}
    </button>
  );
}

function pointerLink(p: EventPointer): string {
  try {
    return p.type === 'id'
      ? nip19.neventEncode({ id: p.id, relays: p.relays?.slice(0, 2), author: p.author })
      : nip19.naddrEncode({ kind: p.kind, pubkey: p.pubkey, identifier: p.identifier, relays: p.relays?.slice(0, 2) });
  } catch {
    return '';
  }
}

/** An embedded, quoted note (NIP-27 note / nevent / naddr). */
export function QuotedNote({ pointer, depth = 1 }: { pointer: EventPointer; depth?: number }) {
  const event = useNostrEvent(pointer);
  const author = event?.pubkey ?? (pointer.type === 'addr' ? pointer.pubkey : pointer.author);
  const profile = useProfile(author);
  const selectNote = useContext(SelectNoteContext);
  const link = pointerLink(pointer);

  if (event === undefined) {
    return (
      <span className="flex items-center gap-2 my-2 px-3 py-2.5 rounded-xl border border-white/10 bg-white/[0.03] text-[11px] text-gray-500">
        <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading quoted note…
      </span>
    );
  }
  if (event === null) {
    return (
      <a
        href={`https://njump.me/${link}`}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => e.stopPropagation()}
        className="flex items-center gap-1.5 my-2 px-3 py-2.5 rounded-xl border border-white/10 bg-white/[0.03] text-[11px] text-gray-500 hover:text-gray-300"
      >
        <ExternalLink className="w-3.5 h-3.5" /> Quoted note not found on your relays. Open on njump
      </a>
    );
  }

  const name = profileName(profile, event.pubkey);
  const title = event.kind === 30023 ? event.tags.find((t) => t[0] === 'title')?.[1] : undefined;
  const note: FeedNote = {
    id: event.id, pubkey: event.pubkey, content: event.content,
    created_at: event.created_at, tags: event.tags, kind: event.kind,
  };
  const images = event.kind === 1 ? [...new Set(event.content.match(IMAGE_URL_RE) ?? [])].slice(0, 1) : [];

  return (
    <span
      role="button"
      tabIndex={0}
      onClick={(e) => {
        e.stopPropagation();
        if (selectNote) selectNote(note);
        else window.open(`https://njump.me/${link}`, '_blank', 'noopener');
      }}
      className="block my-2 px-3 py-2.5 rounded-xl border border-white/10 bg-white/[0.03] hover:bg-white/[0.06] transition-colors cursor-pointer text-left whitespace-normal"
    >
      <span className="flex items-center gap-2 mb-1">
        <ClickableAvatar pubkey={event.pubkey} picture={profile?.picture} name={name} size="xs" />
        <span className="text-xs font-semibold text-white truncate">{name}</span>
        <span className="text-[10px] text-gray-500">· {timeAgo(event.created_at)}</span>
      </span>
      {title && <span className="block text-sm font-semibold text-white mb-1">{title}</span>}
      <span className="block text-[13px] text-gray-300 leading-relaxed whitespace-pre-wrap break-words">
        <NoteContent content={event.kind === 30023 ? event.content.slice(0, 400) : event.content} tags={event.tags} depth={depth} maxLength={320} />
      </span>
      {images.map((url) => (
        <img key={url} src={safeImageUrl(url)} alt="" loading="lazy" className="mt-2 rounded-lg max-h-48 object-cover" />
      ))}
    </span>
  );
}

function renderToken(t: ContentToken, i: number, depth: number): ReactNode {
  switch (t.type) {
    case 'text':
      return <span key={i}>{t.text}</span>;
    case 'url': {
      const href = safeHttpUrl(t.url);
      if (!href) return <span key={i}>{t.url}</span>;
      return (
        <a
          key={i}
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="text-blue-400 hover:underline break-all"
        >
          {t.url}
        </a>
      );
    }
    case 'profile':
      return <Mention key={i} pubkey={t.pubkey} relays={t.relays} />;
    case 'event':
      // One level of quotes; deeper ones stay a compact link
      if (depth >= 1) {
        const link = pointerLink(t.pointer);
        return (
          <a
            key={i}
            href={`https://njump.me/${link}`}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="text-purple-300 hover:underline break-all"
          >
            {link ? `${link.slice(0, 14)}…` : t.raw}
          </a>
        );
      }
      return <QuotedNote key={i} pointer={t.pointer} depth={depth + 1} />;
  }
}

interface NoteContentProps {
  content: string;
  tags?: string[][];
  /** Collapse to this many visible characters (undefined = show all). */
  maxLength?: number;
  depth?: number;
  stripImages?: boolean;
}

/** Note text with links, @mentions and quoted notes rendered (NIP-27, NIP-08). */
export function NoteContent({ content, tags = [], maxLength, depth = 0, stripImages = true }: NoteContentProps) {
  const tokens = useMemo(() => tokenizeContent(content, tags, stripImages), [content, tags, stripImages]);
  const shown = maxLength !== undefined && tokensLength(tokens) > maxLength ? truncateTokens(tokens, maxLength) : tokens;
  const cut = shown !== tokens;
  return (
    <>
      {shown.map((t, i) => renderToken(t, i, depth))}
      {cut && '…'}
    </>
  );
}

/** Whether content would be collapsed at `max` characters. */
export function contentIsLong(content: string, tags: string[][], max: number): boolean {
  return tokensLength(tokenizeContent(content, tags)) > max;
}
