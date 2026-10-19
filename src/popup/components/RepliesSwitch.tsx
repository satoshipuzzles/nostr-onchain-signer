import { useReplyMode } from '@/lib/nostr/feed-filters';

/** Two-way switch at the top of a feed: only notes, or notes and replies. Remembered per feed. */
export function RepliesSwitch({ feed }: { feed: string }) {
  const [mode, setMode] = useReplyMode(feed);
  const seg = (on: boolean) => `flex-1 px-3 py-1.5 rounded-full text-[13px] font-medium transition-colors ${on ? 'bg-white text-black' : 'text-gray-400 hover:text-white'}`;
  return (
    <div className="flex rounded-full bg-white/5 border border-white/10 p-0.5 w-full max-w-[280px]" role="radiogroup" aria-label="Show replies" data-testid="replies-switch" data-mode={mode}>
      <button type="button" role="radio" aria-checked={mode === 'notes'} onClick={() => setMode('notes')} className={seg(mode === 'notes')} data-reply-mode="notes">Notes</button>
      <button type="button" role="radio" aria-checked={mode === 'both'} onClick={() => setMode('both')} className={seg(mode === 'both')} data-reply-mode="both">Notes &amp; replies</button>
    </div>
  );
}
