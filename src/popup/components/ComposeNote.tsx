import { useState, useRef } from 'react';
import { Send, Loader2, ImageIcon, X } from 'lucide-react';
import { useAuth } from '@/popup/context/AuthContext';
import { createMessageId } from '@/shared/messages';
import { publishEvent } from '@/lib/nostr/discovery';
import { uploadImageToNostrBuild } from '@/lib/nostr/image-upload';

interface Props {
  onPublished?: () => void;
}

export function ComposeNote({ onPublished }: Props) {
  const { publicKey, myProfile } = useAuth();
  const [content, setContent] = useState('');
  const [publishing, setPublishing] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [imageUrls, setImageUrls] = useState<string[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function handleImageUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploading(true);
    try {
      const url = await uploadImageToNostrBuild(file);
      setImageUrls((prev) => [...prev, url]);
    } catch (err) {
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

      await publishEvent(response.result);
      setContent('');
      setImageUrls([]);
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
          <div className="flex items-center justify-between pt-2 border-t border-surface-200/10">
            <div className="flex items-center gap-2">
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
                className="flex items-center gap-1 text-gray-400 hover:text-nostr transition-colors disabled:opacity-50"
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
              <span className="text-[10px] text-gray-500">
                {content.length > 0 && `${content.length} chars`}
              </span>
            </div>
            <button
              onClick={handlePublish}
              disabled={(!content.trim() && imageUrls.length === 0) || publishing}
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
