import { useState } from 'react';
import { Send, Loader2 } from 'lucide-react';
import { useAuth } from '@/popup/context/AuthContext';
import { createMessageId } from '@/shared/messages';
import { publishEvent } from '@/lib/nostr/discovery';

interface Props {
  onPublished?: () => void;
}

export function ComposeNote({ onPublished }: Props) {
  const { publicKey, myProfile } = useAuth();
  const [content, setContent] = useState('');
  const [publishing, setPublishing] = useState(false);

  async function handlePublish() {
    if (!content.trim() || publishing) return;

    setPublishing(true);
    try {
      const event = {
        kind: 1,
        pubkey: publicKey,
        created_at: Math.floor(Date.now() / 1000),
        tags: [],
        content: content.trim(),
      };

      const response = await chrome.runtime.sendMessage({
        type: 'nip07:signEvent',
        payload: { event },
        id: createMessageId(),
      });

      if (response.error) {
        throw new Error(response.error);
      }

      await publishEvent(response.result);
      setContent('');
      onPublished?.();
    } catch (err) {
      console.error('Failed to publish note:', err);
    } finally {
      setPublishing(false);
    }
  }

  const displayName = myProfile?.displayName || myProfile?.name || 'Anonymous';

  return (
    <div className="p-3 border border-surface-200/10 rounded-xl bg-surface-800/50">
      <div className="flex items-start gap-3">
        {myProfile?.picture ? (
          <img src={myProfile.picture} alt="" className="w-8 h-8 rounded-full object-cover flex-shrink-0" />
        ) : (
          <div className="w-8 h-8 rounded-full bg-gradient-to-br from-bitcoin/30 to-nostr/30 flex items-center justify-center flex-shrink-0">
            <span className="text-xs font-bold text-white/70">{displayName[0].toUpperCase()}</span>
          </div>
        )}
        <div className="flex-1 min-w-0">
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="What's happening?"
            rows={3}
            className="w-full bg-transparent border-none outline-none resize-none text-sm text-white placeholder-gray-500"
          />
          <div className="flex items-center justify-between pt-2 border-t border-surface-200/10">
            <span className="text-[10px] text-gray-500">
              {content.length > 0 && `${content.length} chars`}
            </span>
            <button
              onClick={handlePublish}
              disabled={!content.trim() || publishing}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-bitcoin text-white rounded-lg text-xs font-medium disabled:opacity-50 hover:bg-bitcoin/90 transition-colors"
            >
              {publishing ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : (
                <Send className="w-3 h-3" />
              )}
              Post
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
