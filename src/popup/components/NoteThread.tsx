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

export function NoteThread({ note, profiles, onClose, onViewProfile }: Props) {
  const [parent, setParent] = useState<FeedNote | null>(null);
  const [replies, setReplies] = useState<FeedNote[]>([]);
  const [loadingReplies, setLoadingReplies] = useState(true);
  const [threadProfiles, setThreadProfiles] = useState<Map<string, ProfileMetadata>>(new Map(profiles));
  const overlayRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    const cleanups: (() => void)[] = [];

    async function loadThread() {
      const relayList = await loadRelayList();
      const relays = getReadRelays(relayList);
      const relayUrls = relays.length > 0
        ? relays.slice(0, 3)
        : ['wss://relay.damus.io', 'wss://nos.lol'];

      // Fetch parent if this note is a reply
      const parentTag = note.tags.find((t) => t[0] === 'e');
      if (parentTag && parentTag[1]) {
        const cleanup = subscribeEvents(
          relayUrls,
          { kinds: [1], ids: [parentTag[1]], limit: 1 },
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

      // Fetch replies
      const replyList: FeedNote[] = [];
      const cleanup = subscribeEvents(
        relayUrls,
        { kinds: [1], '#e': [note.id], limit: 50 },
        (event: NostrEvent) => {
          if (cancelled) return;
          replyList.push({
            id: event.id,
            pubkey: event.pubkey,
            content: event.content,
            created_at: event.created_at,
            tags: event.tags,
            kind: event.kind,
          });
          setReplies([...replyList].sort((a, b) => a.created_at - b.created_at));
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
  }, [note.id]);

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

  return (
    <div
      ref={overlayRef}
      onClick={handleOverlayClick}
      className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm overflow-y-auto"
    >
      <div className="max-w-lg mx-auto p-4 pt-8 pb-24 min-h-full">
        {/* Close button */}
        <button
          onClick={onClose}
          className="fixed top-4 right-4 z-50 p-2 rounded-full bg-surface-800 text-gray-400 hover:text-white hover:bg-surface-700 transition-colors"
        >
          <X className="w-5 h-5" />
        </button>

        {/* Parent note */}
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

        {/* Connecting line from parent */}
        {parent && (
          <div className="flex justify-start pl-6 -my-1">
            <div className="w-0.5 h-4 bg-surface-200/20" />
          </div>
        )}

        {/* Main note (highlighted) */}
        <NoteCard
          note={note}
          profile={threadProfiles.get(note.pubkey) || profiles.get(note.pubkey)}
          onViewProfile={onViewProfile}
          highlighted
        />

        {/* Replies */}
        {(replies.length > 0 || loadingReplies) && (
          <div className="mt-1">
            {replies.length > 0 && (
              <p className="text-xs text-gray-500 mb-2 px-1">
                {replies.length} {replies.length === 1 ? 'reply' : 'replies'}
              </p>
            )}

            {replies.map((reply, i) => (
              <div key={reply.id} className="relative">
                {i < replies.length - 1 && (
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
                <span className="text-xs text-gray-500 ml-2">Loading replies...</span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
