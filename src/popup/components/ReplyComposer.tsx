import { useState } from 'react';
import { Send, Loader2 } from 'lucide-react';
import { useAuth } from '@/popup/context/AuthContext';
import { createMessageId } from '@/shared/messages';
import { publishEvent } from '@/lib/nostr/discovery';
import { loadRelayList, getWriteRelays } from '@/lib/nostr/relays';
import { type FeedNote } from '@/lib/nostr/feed';

interface Props {
  parentNote: FeedNote;
  mode?: 'reply' | 'quote';
  noteRef?: string;
  onClose: () => void;
  onPublished?: () => void;
}

export function ReplyComposer({
  parentNote,
  mode = 'reply',
  noteRef,
  onClose,
  onPublished,
}: Props) {
  const { publicKey, myProfile } = useAuth();
  const [content, setContent] = useState('');
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState('');

  async function handlePublish() {
    if (!content.trim() || publishing) return;

    setPublishing(true);
    setError('');
    try {
      const relayList = await loadRelayList();
      const relays = getWriteRelays(relayList);
      const relayUrl = relays[0] || '';

      let eventContent = content.trim();
      let tags: string[][] = [];

      if (mode === 'reply') {
        tags = [
          ['e', parentNote.id, relayUrl, 'reply'],
          ['p', parentNote.pubkey],
        ];
      } else {
        eventContent = `${content.trim()}\n${noteRef}`;
        tags = [
          ['q', parentNote.id],
          ['p', parentNote.pubkey],
        ];
      }

      const event = {
        kind: 1,
        pubkey: publicKey,
        created_at: Math.floor(Date.now() / 1000),
        tags,
        content: eventContent,
      };

      const response = await chrome.runtime.sendMessage({
        type: 'nip07:signEvent',
        payload: { event },
        id: createMessageId(),
      });

      if (response.error) throw new Error(response.error);
      await publishEvent(response.result);
      setContent('');
      onPublished?.();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to publish');
    } finally {
      setPublishing(false);
    }
  }

  const displayName = myProfile?.displayName || myProfile?.name || 'You';
  const placeholder =
    mode === 'reply' ? 'Write a reply...' : 'Add a comment to your quote...';

  return (
    <div className="mt-3 pt-3 border-t border-surface-200/10">
      <div className="flex items-start gap-2">
        {myProfile?.picture ? (
          <img
            src={myProfile.picture}
            alt=""
            className="w-7 h-7 rounded-full object-cover flex-shrink-0"
          />
        ) : (
          <div className="w-7 h-7 rounded-full bg-gradient-to-br from-bitcoin/30 to-nostr/30 flex items-center justify-center flex-shrink-0">
            <span className="text-[10px] font-bold text-white/70">
              {displayName[0].toUpperCase()}
            </span>
          </div>
        )}
        <div className="flex-1 min-w-0">
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder={placeholder}
            rows={2}
            autoFocus
            className="w-full bg-surface-700/50 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 outline-none resize-none border border-surface-200/10 focus:border-nostr/30"
          />
          {error && <p className="text-xs text-red-400 mt-1">{error}</p>}
          <div className="flex items-center justify-end gap-2 mt-2">
            <button
              onClick={onClose}
              className="text-xs text-gray-400 hover:text-white px-2 py-1 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handlePublish}
              disabled={!content.trim() || publishing}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-nostr text-white rounded-lg text-xs font-medium disabled:opacity-50 hover:bg-nostr/90 transition-colors"
            >
              {publishing ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : (
                <Send className="w-3 h-3" />
              )}
              {mode === 'reply' ? 'Reply' : 'Quote'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
