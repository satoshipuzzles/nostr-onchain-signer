import { useState, useRef, useEffect, useCallback } from 'react';
import { Send, Loader2, ImageIcon, X, Search } from 'lucide-react';
import { useAuth } from '@/popup/context/AuthContext';
import { createMessageId } from '@/shared/messages';
import { publishEvent } from '@/lib/nostr/discovery';
import { uploadImageToNostrBuild } from '@/lib/nostr/image-upload';
import { searchMentions, mentionLabel, type MentionSearchResult } from '@/lib/nostr/mention-search';
import { publishWithFeedback } from '@/lib/ui/publish-feedback';
import { toast } from 'sonner';

interface Props {
  onPublished?: () => void;
  mentionPubkey?: string;
  placeholder?: string;
}

export function ComposeNote({ onPublished, mentionPubkey, placeholder }: Props) {
  const { publicKey, myProfile } = useAuth();
  const [content, setContent] = useState('');
  const [publishing, setPublishing] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [imageUrls, setImageUrls] = useState<string[]>([]);
  const [uploadError, setUploadError] = useState('');
  const [mentionedPubkeys, setMentionedPubkeys] = useState<Map<string, string>>(new Map());
  const [mentionQuery, setMentionQuery] = useState('');
  const [mentionResults, setMentionResults] = useState<MentionSearchResult[]>([]);
  const [mentionLoading, setMentionLoading] = useState(false);
  const [showMentionDropdown, setShowMentionDropdown] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    if (mentionPubkey) {
      setMentionedPubkeys((prev) => {
        const next = new Map(prev);
        if (!next.has(mentionPubkey)) next.set(mentionPubkey, 'user');
        return next;
      });
    }
  }, [mentionPubkey]);

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

    requestAnimationFrame(() => {
      const pos = atIndex + label.length + 2;
      textarea.focus();
      textarea.setSelectionRange(pos, pos);
    });
  }

  async function handleImageUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploading(true);
    setUploadError('');
    try {
      const url = await uploadImageToNostrBuild(file);
      setImageUrls((prev) => [...prev, url]);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Upload failed';
      setUploadError(message);
      console.error('Image upload failed:', err);
    } finally {
      setUploading(false);
      e.target.value = '';
    }
  }

  async function handlePublish() {
    if ((!content.trim() && imageUrls.length === 0) || publishing) return;

    setPublishing(true);
    try {
      let fullContent = content.trim();
      if (imageUrls.length > 0) {
        fullContent += (fullContent ? '\n' : '') + imageUrls.join('\n');
      }

      const tags: string[][] = imageUrls.map((url) => ['image', url]);
      const seenPubkeys = new Set<string>();
      for (const pubkey of mentionedPubkeys.keys()) {
        if (!seenPubkeys.has(pubkey)) {
          seenPubkeys.add(pubkey);
          tags.push(['p', pubkey]);
        }
      }
      if (mentionPubkey && !seenPubkeys.has(mentionPubkey)) {
        tags.push(['p', mentionPubkey]);
      }

      const event = {
        kind: 1,
        pubkey: publicKey,
        created_at: Math.floor(Date.now() / 1000),
        tags,
        content: fullContent,
      };

      const response = await chrome.runtime.sendMessage({
        type: 'nip07:signEvent',
        payload: { event },
        id: createMessageId(),
      });

      if (response.error) {
        throw new Error(response.error);
      }

      await publishWithFeedback(response.result, 'Note published!');
      setContent('');
      setImageUrls([]);
      setMentionedPubkeys(new Map());
      onPublished?.();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to publish note';
      toast.error(message);
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
        <div className="flex-1 min-w-0 relative">
          <textarea
            ref={textareaRef}
            value={content}
            onChange={handleContentChange}
            placeholder={placeholder || (mentionPubkey ? 'Post a comment...' : "What's happening? Use @ to mention")}
            rows={3}
            className="w-full bg-transparent border-none outline-none resize-none text-sm text-white placeholder-gray-500"
          />

          {showMentionDropdown && (
            <div className="absolute left-0 right-0 top-full mt-1 z-20 bg-surface-700 border border-surface-200/20 rounded-xl shadow-xl max-h-48 overflow-y-auto">
              {mentionLoading ? (
                <div className="flex items-center gap-2 px-3 py-2 text-xs text-gray-400">
                  <Search className="w-3 h-3 animate-pulse" />
                  Searching...
                </div>
              ) : (
                mentionResults.map((result) => (
                  <button
                    key={result.pubkey}
                    type="button"
                    onClick={() => selectMention(result)}
                    className="w-full flex items-center gap-2 px-3 py-2 hover:bg-surface-600 text-left transition-colors"
                  >
                    {result.picture ? (
                      <img src={result.picture} alt="" className="w-6 h-6 rounded-full object-cover" />
                    ) : (
                      <div className="w-6 h-6 rounded-full bg-surface-500 flex items-center justify-center text-[10px]">
                        {(result.displayName || '?')[0]}
                      </div>
                    )}
                    <div className="min-w-0">
                      <p className="text-xs text-white truncate">{mentionLabel(result)}</p>
                      {result.nip05 && (
                        <p className="text-[10px] text-gray-500 truncate">{result.nip05}</p>
                      )}
                    </div>
                  </button>
                ))
              )}
            </div>
          )}

          {imageUrls.length > 0 && (
            <div className="flex gap-2 flex-wrap mb-2">
              {imageUrls.map((url) => (
                <div key={url} className="relative w-12 h-12 rounded-lg overflow-hidden bg-surface-700">
                  <img src={url} alt="" className="w-full h-full object-cover" />
                  <button
                    onClick={() => setImageUrls((prev) => prev.filter((u) => u !== url))}
                    className="absolute top-0 right-0 w-4 h-4 bg-red-500 rounded-full flex items-center justify-center"
                  >
                    <X className="w-2 h-2 text-white" />
                  </button>
                </div>
              ))}
            </div>
          )}
          {uploadError && (
            <p className="text-xs text-red-400 mb-2 px-1">{uploadError}</p>
          )}
          <div className="flex items-center justify-between pt-2 border-t border-surface-200/10 gap-2 pb-safe">
            <div className="flex items-center gap-2 min-w-0">
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
                className="flex items-center gap-1 text-gray-400 hover:text-nostr transition-colors disabled:opacity-50 flex-shrink-0"
                title="Upload image"
              >
                {uploading ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <ImageIcon className="w-4 h-4" />
                )}
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                onChange={handleImageUpload}
                className="hidden"
              />
              <span className="text-[10px] text-gray-500 truncate">
                {content.length > 0 && `${content.length} chars`}
              </span>
            </div>
            <button
              onClick={handlePublish}
              disabled={(!content.trim() && imageUrls.length === 0) || publishing}
              className="flex items-center gap-1.5 px-4 py-2 bg-bitcoin text-white rounded-lg text-xs font-medium disabled:opacity-50 hover:bg-bitcoin/90 transition-colors flex-shrink-0 min-h-[44px]"
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
