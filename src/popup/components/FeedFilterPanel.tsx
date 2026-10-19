import { useState } from 'react';
import { SlidersHorizontal, X, RotateCcw } from 'lucide-react';
import { useFeedFilters, activeFilterCount, type ShowOnly } from '@/lib/nostr/feed-filters';

const ONLY: { id: ShowOnly; label: string }[] = [
  { id: 'all', label: 'Everything' },
  { id: 'images', label: 'Images' },
  { id: 'video', label: 'Video' },
  { id: 'audio', label: 'Music & audio' },
  { id: 'links', label: 'Links' },
  { id: 'text', label: 'Text only' },
];

/** The "Filters" button plus its panel. `hidden` = how many loaded notes the filters are hiding. */
export function FeedFilterPanel({ hidden = 0 }: { hidden?: number }) {
  const { prefs, set, reset } = useFeedFilters();
  const [open, setOpen] = useState(false);
  const [word, setWord] = useState('');
  const n = activeFilterCount(prefs);

  const chip = (on: boolean) => `px-3 py-1.5 rounded-full text-[13px] font-medium border whitespace-nowrap transition-colors ${
    on ? 'bg-purple-600/25 text-purple-200 border-purple-500/40' : 'bg-white/5 text-gray-300 border-white/10 hover:border-white/25'}`;
  const toggle = (label: string, on: boolean, flip: () => void) => (
    <button type="button" onClick={flip} className={chip(on)} aria-pressed={on}>{label}</button>
  );

  return (
    <div className="px-3 pt-2" data-testid="feed-filters">
      <div className="flex items-center gap-2">
        <button type="button" onClick={() => setOpen((v) => !v)} data-testid="filters-toggle"
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[13px] font-medium border ${n ? 'bg-purple-600/20 text-purple-100 border-purple-500/40' : 'bg-white/5 text-gray-300 border-white/10'}`}>
          <SlidersHorizontal className="w-3.5 h-3.5" /> Filters{n ? <span className="ml-0.5 min-w-[18px] h-[18px] rounded-full bg-purple-500 text-white text-[11px] flex items-center justify-center px-1">{n}</span> : null}
        </button>
        {n > 0 && (
          <>
            <span className="text-[12px] text-gray-500 truncate" data-testid="filters-active">
              {ONLY.find((o) => o.id === prefs.only && o.id !== 'all')?.label || ''}{hidden ? `${prefs.only !== 'all' ? ' · ' : ''}${hidden} hidden` : ''}
            </span>
            <button type="button" onClick={reset} className="ml-auto flex items-center gap-1 text-[12px] text-gray-400 hover:text-white" data-testid="filters-reset">
              <RotateCcw className="w-3 h-3" /> Reset
            </button>
          </>
        )}
      </div>

      {open && (
        <div className="mt-2 rounded-2xl border border-white/10 bg-white/[0.03] p-3 space-y-3" data-testid="filters-panel">
          <div>
            <p className="text-[11px] uppercase tracking-wide text-gray-500 mb-1.5">Show only</p>
            <div className="flex gap-1.5 flex-wrap">
              {ONLY.map((o) => (
                <button key={o.id} type="button" onClick={() => set({ only: o.id })} className={chip(prefs.only === o.id)} data-only={o.id}>{o.label}</button>
              ))}
            </div>
          </div>
          <div>
            <p className="text-[11px] uppercase tracking-wide text-gray-500 mb-1.5">Hide</p>
            <div className="flex gap-1.5 flex-wrap">
              {toggle('Replies', prefs.hideReplies, () => set({ hideReplies: !prefs.hideReplies }))}
              {toggle('Reposts', prefs.hideReposts, () => set({ hideReposts: !prefs.hideReposts }))}
              {toggle('Any hashtags', prefs.hideHashtags, () => set({ hideHashtags: !prefs.hideHashtags }))}
              {toggle('Content warnings', prefs.hideNsfw, () => set({ hideNsfw: !prefs.hideNsfw }))}
              {toggle('Bots', prefs.hideBots, () => set({ hideBots: !prefs.hideBots }))}
            </div>
            <div className="flex items-center gap-2 mt-2 text-[13px] text-gray-300">
              <span>Hashtag spam: hide notes with more than</span>
              <select value={prefs.maxHashtags} onChange={(e) => set({ maxHashtags: +e.target.value })}
                className="bg-white/5 border border-white/10 rounded-lg px-2 py-1 text-[13px]" aria-label="Most hashtags allowed">
                <option value={0}>off</option>
                {[2, 3, 5, 8, 12].map((v) => <option key={v} value={v}>{v}</option>)}
              </select>
            </div>
          </div>
          <div>
            <p className="text-[11px] uppercase tracking-wide text-gray-500 mb-1.5">Muted words</p>
            <form onSubmit={(e) => { e.preventDefault(); const w = word.trim(); if (w && !prefs.mutedWords.includes(w)) set({ mutedWords: [...prefs.mutedWords, w] }); setWord(''); }} className="flex gap-2">
              <input value={word} onChange={(e) => setWord(e.target.value)} placeholder="a word or phrase" className="flex-1 min-w-0 bg-white/5 border border-white/10 rounded-full px-3 py-1.5 text-[14px] outline-none focus:border-purple-500/50" />
              <button type="submit" className="px-3 py-1.5 bg-white/10 rounded-full text-[13px]">Mute</button>
            </form>
            {prefs.mutedWords.length > 0 && (
              <div className="flex gap-1.5 flex-wrap mt-2">
                {prefs.mutedWords.map((w) => (
                  <span key={w} className="flex items-center gap-1 px-2.5 py-1 rounded-full bg-white/5 border border-white/10 text-[12px] text-gray-300">
                    {w}<button type="button" onClick={() => set({ mutedWords: prefs.mutedWords.filter((x) => x !== w) })} aria-label={`Unmute ${w}`}><X className="w-3 h-3" /></button>
                  </span>
                ))}
              </div>
            )}
          </div>
          <div className="flex items-center justify-between gap-3 pt-1 border-t border-white/5">
            <span className="text-[13px] text-gray-300">Show images, video and players in notes</span>
            <button type="button" onClick={() => set({ mediaInline: !prefs.mediaInline })} role="switch" aria-checked={prefs.mediaInline}
              className={`w-11 h-6 rounded-full relative transition-colors flex-shrink-0 ${prefs.mediaInline ? 'bg-purple-600' : 'bg-white/15'}`}>
              <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all ${prefs.mediaInline ? 'left-[22px]' : 'left-0.5'}`} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
