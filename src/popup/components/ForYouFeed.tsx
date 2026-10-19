import { useEffect, useMemo, useRef, useState } from 'react';
import { Sparkles, SlidersHorizontal, ThumbsDown, Loader2, RefreshCw, X, Zap, Heart, Repeat2, MessageCircle, Users, Bitcoin, Compass, Hash } from 'lucide-react';
import { toast } from 'sonner';
import { NoteCard } from '@/popup/components/NoteCard';
import { useEngagement } from '@/popup/hooks/useNostr';
import { useProfile } from '@/popup/hooks/useNostr';
import { mutedNow, onMutesChanged } from '@/lib/nostr/mute';
import { DEFAULT_RELAYS } from '@/lib/nostr/query';
import { useFeedFilters, passesFilters, useReplyMode } from '@/lib/nostr/feed-filters';
import { runAlgo, loadTune, saveTune, loadLess, saveLess, clearAlgoCache, DEFAULT_TUNE, type Ranked, type AlgoTune, type ShowLess, type WhyKind } from '@/lib/nostr/algo';
import type { FeedNote } from '@/lib/nostr/feed';

interface Props {
  publicKey: string;
  followingPubkeys: Set<string>;
  onSelectNote: (note: FeedNote) => void;
  onViewProfile?: (pubkey: string) => void;
}

const PAGE = 25;
const WHY_ICON: Record<WhyKind, typeof Zap> = {
  zapped: Zap, liked: Heart, reposted: Repeat2, replied: MessageCircle, network: Users, trending: Sparkles,
  fof: Users, follow: Users, onchain: Bitcoin, new: Compass, topic: Hash,
};

function ShowLessMenu({ r, onLess, onClose }: { r: Ranked; onLess: (k: 'author' | 'topic') => void; onClose: () => void }) {
  const p = useProfile(r.note.pubkey);
  const name = p?.displayName || p?.name || 'this person';
  return (
    <div className="absolute right-2 top-8 z-20 w-60 rounded-xl border border-white/15 bg-surface-800 shadow-xl p-1 text-sm" onClick={(e) => e.stopPropagation()}>
      <button onClick={() => onLess('author')} className="w-full text-left px-3 py-2 rounded-lg hover:bg-white/10">Less from {name}</button>
      {r.topic && <button onClick={() => onLess('topic')} className="w-full text-left px-3 py-2 rounded-lg hover:bg-white/10">Less about #{r.topic}</button>}
      <button onClick={onClose} className="w-full text-left px-3 py-2 rounded-lg hover:bg-white/10 text-gray-400">Cancel</button>
      <p className="px-3 pb-2 text-[10px] text-gray-500">Only changes this feed. Nobody is muted.</p>
    </div>
  );
}

export function ForYouFeed({ publicKey, followingPubkeys, onSelectNote, onViewProfile }: Props) {
  const [ranked, setRanked] = useState<Ranked[]>([]);
  const [done, setDone] = useState(false);
  const [shown, setShown] = useState(PAGE);
  const [tune, setTune] = useState<AlgoTune>(() => loadTune());
  const [less, setLess] = useState<ShowLess>(() => loadLess());
  const [tuneOpen, setTuneOpen] = useState(false);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [run, setRun] = useState(0);
  const [muted, setMuted] = useState<Set<string>>(() => new Set(mutedNow()));
  const { prefs } = useFeedFilters();
  const [replyMode] = useReplyMode('foryou');
  const lockedRef = useRef<Ranked[] | null>(null);   // once the user scrolls, the top stays put
  const endRef = useRef<HTMLDivElement | null>(null);

  // a block / mute anywhere drops that author here at once (ranking reads the live set)
  useEffect(() => onMutesChanged((m) => {
    setMuted(new Set(m));
    setRanked((list) => list.filter((r) => !m.has(r.note.pubkey)));
  }), []);
  const followsKey = useMemo(() => [...followingPubkeys].sort().join(','), [followingPubkeys]);

  useEffect(() => {
    setDone(false);
    lockedRef.current = null;
    return runAlgo({
      me: publicKey || '', follows: followingPubkeys, muted, mutedWords: prefs.mutedWords,
      tune, less, includeReplies: replyMode === 'both',
    }, (list, finished) => {
      setRanked((prev) => {
        // keep what has been scrolled past in place; re-rank only below it
        const lock = lockedRef.current;
        if (!lock || !lock.length) return list;
        const ids = new Set(lock.map((r) => r.note.id));
        return [...lock, ...list.filter((r) => !ids.has(r.note.id))];
      });
      if (finished) setDone(true);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [publicKey, followsKey, muted, tune, less, replyMode, run, prefs.mutedWords.join('|')]);

  const visible = useMemo(
    () => ranked.filter((r) => passesFilters(r.note, prefs)).slice(0, shown),
    [ranked, prefs, shown],
  );
  const ids = useMemo(() => visible.map((r) => r.note.id), [visible]);
  const engagement = useEngagement(done ? ids : [], DEFAULT_RELAYS);

  // more as the end comes near (checked against its real position, so an observer that is
  // re-created while notes stream in can't keep adding pages); the top is locked once you scroll
  const rankedRef = useRef(ranked);
  rankedRef.current = ranked;
  const shownRef = useRef(shown);
  shownRef.current = shown;
  const hasList = visible.length > 0;
  useEffect(() => {
    const el = endRef.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => {
      if (!e.isIntersecting) return;
      if (e.boundingClientRect.top > window.innerHeight * 2) return;
      if (shownRef.current >= rankedRef.current.length) return;
      if (!lockedRef.current) lockedRef.current = rankedRef.current.slice(0, shownRef.current);
      setShown((n) => n + PAGE);
    }, { rootMargin: '600px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [hasList]);

  const showLess = (r: Ranked, k: 'author' | 'topic') => {
    const next = k === 'author'
      ? { ...less, authors: [...new Set([...less.authors, r.note.pubkey])] }
      : { ...less, topics: [...new Set([...less.topics, r.topic!])] };
    setLess(saveLess(next));
    setMenuFor(null);
    setRanked((list) => list.filter((x) => (k === 'author' ? x.note.pubkey !== r.note.pubkey : x.topic !== r.topic)));
    toast.success(k === 'author' ? 'You will see less from them here' : `You will see less about #${r.topic}`);
  };

  const updateTune = (t: Partial<AlgoTune>) => setTune(saveTune(t)); // re-ranks the cached pool, no refetch
  const firstLoad = !ranked.length && !done;

  return (
    <div onClick={() => setMenuFor(null)}>
      <div className="px-4 pt-3 pb-1 flex items-center gap-2">
        <Sparkles className="w-4 h-4 text-purple-300" />
        <p className="text-[12px] text-gray-400 flex-1">
          <b className="text-gray-200">Nostr Onchain algorithm</b> · picked from your network{!done && ranked.length ? ' · still tuning…' : ''}
        </p>
        <button onClick={(e) => { e.stopPropagation(); clearAlgoCache(); setRun((n) => n + 1); }} className="p-2 rounded-lg hover:bg-white/10 text-gray-400" aria-label="Refresh" title="Refresh">
          <RefreshCw className={`w-4 h-4 ${!done ? 'animate-spin' : ''}`} />
        </button>
        <button onClick={(e) => { e.stopPropagation(); setTuneOpen(true); }} className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-white/5 border border-white/10 text-[12px] text-gray-200 hover:bg-white/10">
          <SlidersHorizontal className="w-3.5 h-3.5" /> Tune
        </button>
      </div>

      {firstLoad && (
        <div className="flex flex-col items-center py-14 text-gray-500">
          <Loader2 className="w-6 h-6 animate-spin mb-2" />
          <p className="text-sm">Reading your network…</p>
        </div>
      )}
      {done && !visible.length && (
        <p className="px-6 py-12 text-center text-sm text-gray-500">Nothing to recommend right now{prefs.only !== 'all' ? ' with your filters on' : ''}. Try Refresh, or turn discovery up in Tune.</p>
      )}

      <div className="divide-y divide-white/5">
        {visible.map((r) => (
          <div key={r.note.id} className="px-4 py-3 relative" data-algo-note={r.note.id} data-author={r.note.pubkey}>
            <div className="flex items-center gap-1.5 mb-1.5 ml-1 flex-wrap">
              {r.why.map((w) => {
                const Icon = WHY_ICON[w.kind];
                return (
                  <span key={w.kind} data-why={w.kind} className={`inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full border ${w.kind === 'new' || (r.discovery && w.kind !== 'onchain') ? 'border-sky-400/30 text-sky-200 bg-sky-500/10' : w.kind === 'onchain' ? 'border-orange-400/30 text-orange-200 bg-orange-500/10' : 'border-purple-400/30 text-purple-200 bg-purple-500/10'}`}>
                    <Icon className="w-3 h-3" /> {w.text}
                  </span>
                );
              })}
              {r.discovery && !r.why.some((w) => w.kind === 'new') && <span className="text-[10px] uppercase tracking-wider text-sky-300/80">discovery</span>}
              <button
                onClick={(e) => { e.stopPropagation(); setMenuFor(menuFor === r.note.id ? null : r.note.id); }}
                className="ml-auto p-1.5 rounded-lg text-gray-500 hover:text-gray-200 hover:bg-white/10"
                aria-label="Show less like this" title="Show less like this"
              >
                <ThumbsDown className="w-3.5 h-3.5" />
              </button>
            </div>
            {menuFor === r.note.id && <ShowLessMenu r={r} onLess={(k) => showLess(r, k)} onClose={() => setMenuFor(null)} />}
            <NoteCard note={r.note} engagement={engagement.get(r.note.id)} onSelectNote={onSelectNote} onViewProfile={onViewProfile} />
          </div>
        ))}
      </div>
      {visible.length > 0 && <div ref={endRef} className="h-10" />}

      {tuneOpen && (
        <div className="fixed inset-0 z-[60] flex items-end md:items-center justify-center bg-black/70" onClick={() => setTuneOpen(false)}>
          <div className="w-full md:max-w-md rounded-t-3xl md:rounded-3xl border border-white/10 bg-surface-900 p-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))]" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <span className="text-sm font-semibold">Tune your feed</span>
              <button onClick={() => setTuneOpen(false)} className="p-2 -mr-2 text-gray-400" aria-label="Close"><X className="w-5 h-5" /></button>
            </div>
            <label className="block text-xs text-gray-400 mb-1">Discovery: {tune.discovery < 0.1 ? 'only people you follow' : tune.discovery < 0.3 ? 'a few new voices' : tune.discovery < 0.45 ? 'plenty of new voices' : 'mostly new voices'}</label>
            <input type="range" min={0} max={0.6} step={0.05} value={tune.discovery} onChange={(e) => updateTune({ discovery: Number(e.target.value) })} className="w-full mb-4 accent-purple-500" aria-label="Discovery" />
            <label className="block text-xs text-gray-400 mb-1">Media: {tune.media < -0.3 ? 'more text' : tune.media > 0.3 ? 'more pictures and video' : 'balanced'}</label>
            <input type="range" min={-1} max={1} step={0.25} value={tune.media} onChange={(e) => updateTune({ media: Number(e.target.value) })} className="w-full mb-4 accent-purple-500" aria-label="Media" />
            <label className="block text-xs text-gray-400 mb-1">Topics to boost</label>
            <div className="flex flex-wrap gap-1.5 mb-2">
              {tune.topics.map((t) => (
                <button key={t} onClick={() => updateTune({ topics: tune.topics.filter((x) => x !== t) })} className="text-xs px-2.5 py-1 rounded-full bg-purple-500/20 border border-purple-400/40 text-purple-100">#{t} ×</button>
              ))}
            </div>
            <form onSubmit={(e) => { e.preventDefault(); const v = String(new FormData(e.currentTarget).get('t') || '').trim().toLowerCase().replace(/^#/, ''); if (v) updateTune({ topics: [...new Set([...tune.topics, v])] }); e.currentTarget.reset(); }} className="flex gap-2 mb-4">
              <input name="t" placeholder="add a hashtag" className="flex-1 bg-white/5 border border-white/10 rounded-full px-3 py-1.5 text-sm outline-none" />
              <button className="px-3 py-1.5 rounded-full bg-white/10 text-sm">Add</button>
            </form>
            <label className="flex items-center gap-2 text-sm mb-4">
              <input type="checkbox" checked={tune.showCW} onChange={(e) => updateTune({ showCW: e.target.checked })} className="accent-purple-500" /> Include notes with a content warning
            </label>
            {(less.authors.length > 0 || less.topics.length > 0) && (
              <button onClick={() => setLess(saveLess({ authors: [], topics: [] }))} className="text-xs text-purple-300 underline mb-3 block">
                Reset "show less" ({less.authors.length} people, {less.topics.length} topics)
              </button>
            )}
            <button onClick={() => { updateTune({ ...DEFAULT_TUNE }); }} className="text-xs text-gray-400 underline">Back to defaults</button>
          </div>
        </div>
      )}
    </div>
  );
}
