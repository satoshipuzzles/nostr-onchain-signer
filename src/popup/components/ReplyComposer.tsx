import { useState, useRef, useEffect, useCallback } from 'react';
import { Send, Loader2, Search } from 'lucide-react';
import { useAuth } from '@/popup/context/AuthContext';
import { createMessageId } from '@/shared/messages';
import { loadRelayList, getWriteRelays } from '@/lib/nostr/relays';
import { type FeedNote } from '@/lib/nostr/feed';
import { searchMentions, mentionLabel, type MentionSearchResult } from '@/lib/nostr/mention-search';
import { publishWithFeedback } from '@/lib/ui/publish-feedback';
import { toast } from 'sonner';

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
  const [mentionedPubkeys, setMentionedPubkeys] = useState<Map<string, string>>(new Map());
  const [mentionQuery, setMentionQuery] = useState('');
  const [mentionResults, setMentionResults] = useState<MentionSearchResult[]>([]);
  const [mentionLoading, setMentionLoading] = useState(false);
  const [showMentionDropdown, setShowMentionDropdown] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  const runMentionSearch = useCallback(async (query: string) => {
    if (!query.trim()) {
      setMentionResults([]);
      setShowMentionDropdown(false);
      return;
    }
    setMentionLoading(true);
    const results = await searchMentions(query, publicKey);
    setMentionResults(results);
    setShowMentionDropdown(results.length > 0);
    setMentionLoading(false);
  }, [publicKey]);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!mentionQuery) {
      setMentionResults([]);
      setShowMentionDropdown(false);
      return;
    }
    debounceRef.current = setTimeout(() => runMentionSearch(mentionQuery), 250);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [mentionQuery, runMentionSearch]);

  function detectMentionQuery(value: string, cursor: number): string | null {
    const before = value.slice(0, cursor);
    const match = before.match(/@([a-zA-Z0-9_.@-]*)$/);
    return match ? match[1] : null;
  }

  function handleContentChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const value = e.target.value;
    const cursor = e.target.selectionStart ?? value.length;
    setContent(value);
    const query = detectMentionQuery(value, cursor);
    setMentionQuery(query ?? '');
    if (!query) setShowMentionDropdown(false);
  }

  function selectMention(result: MentionSearchResult) {
    const label = mentionLabel(result);
    const textarea = textareaRef.current;
    if (!textarea) return;
    const cursor = textarea.selectionStart ?? content.length;
    const before = content.slice(0, cursor);
    const after = content.slice(cursor);
    const atIndex = before.lastIndexOf('@');
    if (atIndex === -1) return;
    const newContent = `${before.slice(0, atIndex)}@${label} ${after}`;
    setContent(newContent);
    setMentionQuery('');
    setShowMentionDropdown(false);
    setMentionedPubkeys((prev) => {
      const next = new Map(prev);
      next.set(result.pubkey, label);
      return next;
    });
  }

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

      for (const pubkey of mentionedPubkeys.keys()) {
        if (!tags.some((t) => t[0] === 'p' && t[1] === pubkey)) {
          tags.push(['p', pubkey]);
        }
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
      await publishWithFeedback(response.result, mode === 'reply' ? 'Reply published!' : 'Quote published!');
      setContent('');
      onPublished?.();
      onClose();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to publish';
      setError(message);
      if (!message.includes('Could not reach any relay')) {
        toast.error(message);
      }
    } finally {
      setPublishing(false);
    }
  }

  const displayName = myProfile?.displayName || myProfile?.name || 'You';
  const placeholder = mode === 'reply' ? 'Write a reply... Use @ to mention' : 'Add a comment... Use @ to mention';

  return (
    <div className="mt-3 pt-3 border-t border-surface-200/10">
      <div className="flex items-start gap-2">
        {myProfile?.picture ? (
          <img src={myProfile.picture} alt="" className="w-7 h-7 rounded-full object-cover flex-shrink-0" />
        ) : (
          <div className="w-7 h-7 rounded-full bg-gradient-to-br from-bitcoin/30 to-nostr/30 flex items-center justify-center flex-shrink-0">
            <span className="text-[10px] font-bold text-white/70">{displayName[0].toUpperCase()}</span>
          </div>
        )}
        <div className="flex-1 min-w-0 relative">
          <textarea
            ref={textareaRef}
            value={content}
            onChange={handleContentChange}
            placeholder={placeholder}
            rows={2}
            className="w-full bg-surface-700/50 border border-surface-200/10 rounded-xl px-3 py-2 text-sm text-white placeholder-gray-500 outline-none focus:border-white/30 resize-none"
          />
          {showMentionDropdown && (
            <div className="absolute left-0 right-0 top-full mt-1 z-20 bg-surface-700 border border-surface-200/20 rounded-xl shadow-xl max-h-40 overflow-y-auto">
              {mentionLoading ? (
                <div className="flex items-center gap-2 px-3 py-2 text-xs text-gray-400">
                  <Search className="w-3 h-3 animate-pulse" /> Searching...
                </div>
              ) : (
                mentionResults.map((result) => (
                  <button
                    key={result.pubkey}
                    type="button"
                    onClick={() => selectMention(result)}
                    className="w-full flex items-center gap-2 px-3 py-2 hover:bg-surface-600 text-left"
                  >
                    <span className="text-xs text-white truncate">{mentionLabel(result)}</span>
                  </button>
                ))
              )}
            </div>
          )}
          {error && <p className="text-xs text-red-400 mt-1">{error}</p>}
          <div className="flex items-center justify-end gap-2 mt-2">
            <button onClick={onClose} className="text-xs text-gray-500 hover:text-gray-300 px-2 py-1 min-h-[36px]">
              Cancel
            </button>
            <button
              onClick={handlePublish}
              disabled={!content.trim() || publishing}
              className="flex items-center gap-1 px-3 py-1.5 bg-bitcoin text-white rounded-lg text-xs font-medium disabled:opacity-50 min-h-[36px]"
            >
              {publishing ? <Loader2 className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />}
              {mode === 'reply' ? 'Reply' : 'Quote'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
