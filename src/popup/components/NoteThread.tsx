import { useState, useEffect, useRef } from 'react';
import { subscribeEvents, type FeedNote, type NostrEvent } from '@/lib/nostr/feed';
import { type ProfileMetadata } from '@/lib/nostr/social';
import { loadRelayList, getReadRelays } from '@/lib/nostr/relays';
import { getCachedProfile } from '@/lib/nostr/cache';
import { NoteCard } from './NoteCard';
import { X, Loader2 } from 'lucide-react';

interface Props {
  note: FeedNote;
  profiles: Map<string, ProfileMetadata>;
  onClose: () => void;
  onViewProfile?: (pubkey: string) => void;
}

/** NIP-10: find immediate parent and thread anchor for reply threading. */
function getThreadContext(note: FeedNote): { parentId: string | null; threadId: string } {
  const eTags = note.tags.filter((t) => t[0] === 'e' && t[1]);

  const replyTag = eTags.find((t) => t[3] === 'reply') || eTags.find((t) => !t[3] || t[3] === '');
  const rootTag = eTags.find((t) => t[3] === 'root');

  const parentId = replyTag?.[1] || null;
  const threadId = rootTag?.[1] || parentId || note.id;

  return { parentId, threadId };
}

export function NoteThread({ note, profiles, onClose, onViewProfile }: Props) {
  const { parentId, threadId } = getThreadContext(note);
  const isReply = !!parentId && parentId !== note.id;

  const [parent, setParent] = useState<FeedNote | null>(null);
  const [replies, setReplies] = useState<FeedNote[]>([]);
  const [loadingReplies, setLoadingReplies] = useState(true);
  const [threadProfiles, setThreadProfiles] = useState<Map<string, ProfileMetadata>>(new Map(profiles));
  const overlayRef = useRef<HTMLDivElement>(null);

  // Thread anchor: parent note for replies, otherwise the opened note
  const anchorId = isReply ? parentId! : note.id;

  useEffect(() => {
    let cancelled = false;
    const cleanups: (() => void)[] = [];

    async function loadThread() {
      const relayList = await loadRelayList();
      const relays = getReadRelays(relayList);
      const relayUrls = relays.length > 0
        ? relays.slice(0, 3)
        : ['wss://relay.damus.io', 'wss://nos.lol'];

      if (isReply && parentId) {
        const cleanup = subscribeEvents(
          relayUrls,
          { kinds: [1], ids: [parentId], limit: 1 },
          (event: NostrEvent) => {
            if (cancelled) return;
            setParent({
              id: event.id,
              pubkey: event.pubkey,
              content: event.content,
              created_at: event.created_at,
              tags: event.tags,
              kind: event.kind,
            });
            resolveThreadProfile(event.pubkey);
          },
        );
        cleanups.push(cleanup);
      }

      const replyMap = new Map<string, FeedNote>();

      const cleanup = subscribeEvents(
        relayUrls,
        { kinds: [1], '#e': [anchorId], limit: 100 },
        (event: NostrEvent) => {
          if (cancelled) return;
          replyMap.set(event.id, {
            id: event.id,
            pubkey: event.pubkey,
            content: event.content,
            created_at: event.created_at,
            tags: event.tags,
            kind: event.kind,
          });
          const sorted = Array.from(replyMap.values()).sort((a, b) => a.created_at - b.created_at);
          setReplies(sorted);
          resolveThreadProfile(event.pubkey);
        },
        () => {
          if (!cancelled) setLoadingReplies(false);
        },
      );
      cleanups.push(cleanup);

      setTimeout(() => {
        if (!cancelled) setLoadingReplies(false);
      }, 10000);
    }

    loadThread();

    return () => {
      cancelled = true;
      cleanups.forEach((fn) => fn());
    };
  }, [note.id, anchorId, isReply, parentId]);

  async function resolveThreadProfile(pubkey: string) {
    if (threadProfiles.has(pubkey)) return;
    const cached = await getCachedProfile(pubkey);
    if (cached) {
      setThreadProfiles((prev) => {
        const next = new Map(prev);
        next.set(pubkey, cached);
        return next;
      });
    }
  }

  function handleOverlayClick(e: React.MouseEvent) {
    if (e.target === overlayRef.current) {
      onClose();
    }
  }

  const visibleReplies = isReply
    ? replies.filter((r) => r.id !== parent?.id)
    : replies.filter((r) => r.id !== note.id);

  return (
    <div
      ref={overlayRef}
      onClick={handleOverlayClick}
      className="fixed inset-0 z-[70] bg-black/80 backdrop-blur-sm overflow-y-auto"
    >
      <div className="max-w-lg mx-auto p-4 pt-8 pb-24 min-h-full">
        <button
          onClick={onClose}
          className="fixed top-4 right-4 z-[71] p-2 rounded-full bg-surface-800 text-gray-400 hover:text-white hover:bg-surface-700 transition-colors"
        >
          <X className="w-5 h-5" />
        </button>

        {parent && (
          <div className="relative">
            <div className="absolute left-6 top-full w-0.5 h-4 bg-surface-200/20" />
            <NoteCard
              note={parent}
              profile={threadProfiles.get(parent.pubkey)}
              onViewProfile={onViewProfile}
              compact
            />
          </div>
        )}

        {parent && (
          <div className="flex justify-start pl-6 -my-1">
            <div className="w-0.5 h-4 bg-surface-200/20" />
          </div>
        )}

        <NoteCard
          note={note}
          profile={threadProfiles.get(note.pubkey) || profiles.get(note.pubkey)}
          onViewProfile={onViewProfile}
          highlighted
        />

        {(visibleReplies.length > 0 || loadingReplies) && (
          <div className="mt-1">
            {visibleReplies.length > 0 && (
              <p className="text-xs text-gray-500 mb-2 px-1">
                {visibleReplies.length} {visibleReplies.length === 1 ? 'comment' : 'comments'}
              </p>
            )}

            {visibleReplies.map((reply, i) => (
              <div key={reply.id} className="relative">
                {i < visibleReplies.length - 1 && (
                  <div className="absolute left-6 top-full w-0.5 h-3 bg-surface-200/10" />
                )}
                <NoteCard
                  note={reply}
                  profile={threadProfiles.get(reply.pubkey)}
                  onViewProfile={onViewProfile}
                  compact
                />
              </div>
            ))}

            {loadingReplies && (
              <div className="flex items-center justify-center py-4">
                <Loader2 className="w-5 h-5 text-nostr animate-spin" />
                <span className="text-xs text-gray-500 ml-2">Loading comments...</span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
