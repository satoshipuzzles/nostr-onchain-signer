import { useState, useRef, useEffect, useCallback } from 'react';
import { Send, Loader2, Search, ImageIcon, X } from 'lucide-react';
import { uploadImageToNostrBuild } from '@/lib/nostr/image-upload';
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
  const [imageUrls, setImageUrls] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
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

  async function uploadFiles(files: File[]) {
    const images = files.filter((f) => f.type.startsWith('image/'));
    if (!images.length) return;
    setUploading(true);
    setError('');
    try {
      for (const file of images) {
        const url = await uploadImageToNostrBuild(file);
        setImageUrls((prev) => [...prev, url]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  function handlePaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const files = [...e.clipboardData.files].filter((f) => f.type.startsWith('image/'));
    if (files.length) { e.preventDefault(); uploadFiles(files); }
  }

  async function handlePublish() {
    if ((!content.trim() && !imageUrls.length) || publishing || uploading) return;

    setPublishing(true);
    setError('');
    try {
      const relayList = await loadRelayList();
      const relays = getWriteRelays(relayList);
      const relayUrl = relays[0] || '';

      const body = [content.trim(), ...imageUrls].filter(Boolean).join('\n');
      let eventContent = body;
      let tags: string[][] = [];

      if (mode === 'reply') {
        tags = [
          ['e', parentNote.id, relayUrl, 'reply'],
          ['p', parentNote.pubkey],
        ];
      } else {
        eventContent = `${body}\n${noteRef}`;
        tags = [
          ['q', parentNote.id],
          ['p', parentNote.pubkey],
        ];
      }

      for (const url of imageUrls) tags.push(['image', url]);
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
      setImageUrls([]);
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
            onPaste={handlePaste}
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
          {imageUrls.length > 0 && (
            <div className="flex gap-2 flex-wrap mt-2">
              {imageUrls.map((url) => (
                <div key={url} className="relative w-14 h-14 rounded-lg overflow-hidden bg-surface-700">
                  <img src={url} alt="" className="w-full h-full object-cover" />
                  <button
                    type="button"
                    onClick={() => setImageUrls((prev) => prev.filter((u) => u !== url))}
                    className="absolute top-0.5 right-0.5 w-5 h-5 bg-black/70 rounded-full flex items-center justify-center"
                    aria-label="Remove image"
                  >
                    <X className="w-3 h-3 text-white" />
                  </button>
                </div>
              ))}
            </div>
          )}
          {error && <p className="text-xs text-red-400 mt-1">{error}</p>}
          <div className="flex items-center gap-2 mt-2">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              className="flex items-center justify-center text-gray-400 hover:text-nostr disabled:opacity-50 min-w-[36px] min-h-[36px]"
              title="Add image"
              aria-label="Add image"
            >
              {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <ImageIcon className="w-4 h-4" />}
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              onChange={(e) => uploadFiles([...(e.target.files || [])])}
              className="hidden"
            />
            <span className="flex-1" />
            <button onClick={onClose} className="text-xs text-gray-500 hover:text-gray-300 px-2 py-1 min-h-[36px]">
              Cancel
            </button>
            <button
              onClick={handlePublish}
              disabled={(!content.trim() && !imageUrls.length) || publishing || uploading}
              className="flex items-center gap-1 px-3 py-1.5 bg-bitcoin text-black rounded-lg text-xs font-medium disabled:opacity-50 min-h-[36px]"
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
