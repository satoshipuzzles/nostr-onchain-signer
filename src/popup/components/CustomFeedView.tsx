import { useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, RefreshCw, Bot, ListFilter, UserRound, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { NoteCard } from '@/popup/components/NoteCard';
import { AuthContext } from '@/popup/context/AuthContext';
import { useProfile } from '@/popup/hooks/useNostr';
import { useFeedFilters, passesFilters } from '@/lib/nostr/feed-filters';
import { publishEvent } from '@/lib/nostr/publish';
import { getViewerReadRelays } from '@/lib/nostr/query';
import {
  runRecipe, latestDvmResult, askDvmAnonymously, dvmRequestTemplate, awaitDvmAnswer, FEED_STORE_RELAYS,
  type FeedDef, type FeedItem, type DvmStatus,
} from '@/lib/nostr/feed-store';
import type { FeedNote } from '@/lib/nostr/feed';

interface Props {
  def: FeedDef;
  publicKey: string;
  followingPubkeys: Set<string>;
  onSelectNote: (note: FeedNote) => void;
  onViewProfile?: (pubkey: string) => void;
  /** a preview: fewer notes, no header */
  preview?: boolean;
}

const PAGE = 25;

function ago(ts: number): string {
  const d = Math.floor(Date.now() / 1000) - ts;
  if (d < 3600) return `${Math.max(1, Math.floor(d / 60))}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
}

export function FeedAuthor({ pubkey }: { pubkey: string }) {
  const p = useProfile(pubkey || null);
  if (!pubkey) return <span className="text-[11px] text-gray-500">Built in</span>;
  return <span className="text-[11px] text-gray-500 truncate">by {p?.displayName || p?.name || `${pubkey.slice(0, 8)}…`}</span>;
}

/** A feed from the store, shown as a list of notes: a recipe run in the browser, or a DVM's picks. */
export function CustomFeedView({ def, publicKey, followingPubkeys, onSelectNote, onViewProfile, preview }: Props) {
  const auth = useContext(AuthContext);
  const [items, setItems] = useState<FeedItem[]>([]);
  const [done, setDone] = useState(false);
  const [shown, setShown] = useState(preview ? 12 : PAGE);
  const [run, setRun] = useState(0);
  const [dvm, setDvm] = useState<DvmStatus>({ state: 'idle' });
  const { prefs } = useFeedFilters();
  const endRef = useRef<HTMLDivElement | null>(null);
  const recipeKey = def.recipe ? JSON.stringify(def.recipe) : '';
  const followsKey = useMemo(() => [...followingPubkeys].sort().join(','), [followingPubkeys]);

  useEffect(() => {
    setItems([]);
    setDone(false);
    setShown(preview ? 12 : PAGE);
    if (def.type === 'recipe' && def.recipe) {
      return runRecipe(def.recipe, { me: publicKey, follows: followingPubkeys }, (list, finished) => {
        setItems(list);
        if (finished) setDone(true);
      });
    }
    if (def.type === 'dvm') {
      let cancelled = false;
      let stopAsk: (() => void) | null = null;
      setDvm({ state: 'idle' });
      latestDvmResult(def).then(async (r) => {
        if (cancelled) return;
        if (r && r.notes.length) {
          setItems(r.notes.map((note) => ({ note })));
          setDvm({ state: 'done', at: r.at });
          setDone(true);
          return;
        }
        // no public picks: this provider may only answer when asked, so ask (with a throwaway key)
        setDvm({ state: 'waiting', message: 'Asking the provider for its picks…' });
        try {
          const stop = await askDvmAnonymously(def, (st) => {
            if (cancelled) return;
            setDvm(st);
            if (st.state !== 'waiting') setDone(true);
          }, (notes) => { if (!cancelled) setItems(notes.map((note) => ({ note }))); });
          if (cancelled) stop(); else stopAsk = stop;
        } catch {
          if (!cancelled) { setDvm({ state: 'error', message: 'Could not reach the provider.' }); setDone(true); }
        }
      }).catch(() => { if (!cancelled) setDone(true); });
      return () => { cancelled = true; stopAsk?.(); };
    }
    setDone(true);
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [def.addr, recipeKey, publicKey, followsKey, run]);

  // a personal list from the provider: a signed kind 5300 request (signed in only, on a tap)
  const cancelAsk = useRef<(() => void) | null>(null);
  useEffect(() => () => cancelAsk.current?.(), []);
  async function askPersonal() {
    if (!auth?.confirmAndSign || !publicKey) return;
    try {
      setDvm({ state: 'waiting', message: 'Asking the provider…' });
      const relays = [...new Set([...(await getViewerReadRelays().catch(() => [] as string[])), ...FEED_STORE_RELAYS])].slice(0, 6);
      const signed = await auth.confirmAndSign(dvmRequestTemplate(def, publicKey, relays));
      const r = await publishEvent(signed, { resolveAfter: 1 });
      if (!r.success.length) throw new Error('No relay took the request');
      cancelAsk.current = awaitDvmAnswer(signed.id, def, relays, (s) => setDvm(s), (notes) => {
        setItems(notes.map((note) => ({ note })));
        setShown(PAGE);
      });
    } catch (e) {
      setDvm({ state: 'idle' });
      toast.error(e instanceof Error ? e.message : 'Could not ask the provider');
    }
  }

  const visible = useMemo(() => items.filter((i) => passesFilters(i.note, prefs)).slice(0, shown), [items, prefs, shown]);

  const itemsRef = useRef(items);
  itemsRef.current = items;
  useEffect(() => {
    const el = endRef.current;
    if (!el || preview) return;
    const io = new IntersectionObserver(([e]) => {
      if (e.isIntersecting && shown < itemsRef.current.length) setShown((n) => n + PAGE);
    }, { rootMargin: '600px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [visible.length, shown, preview]);

  const Icon = def.type === 'dvm' ? Bot : ListFilter;

  return (
    <div data-testid="custom-feed" data-feed={def.addr}>
      {!preview && (
        <div className="px-4 pt-3 pb-1 flex items-center gap-2">
          <Icon className="w-4 h-4 text-purple-300 flex-shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="text-[12px] text-gray-400 truncate">
              <b className="text-gray-200">{def.title}</b>
              {def.type === 'dvm' ? ' · picks from an outside provider' : def.recipe?.ranking === 'foryou' ? ' · ranked like For you' : ' · newest first'}
              {!done && items.length ? ' · loading more…' : ''}
            </p>
            {def.type === 'dvm' && dvm.at && <p className="text-[10px] text-gray-500">{dvm.state === 'done' ? 'List from ' : ''}{ago(dvm.at)}</p>}
          </div>
          {def.type === 'dvm' && publicKey && auth && (
            <button onClick={askPersonal} disabled={dvm.state === 'waiting'} className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-white/5 border border-white/10 text-[12px] text-gray-200 hover:bg-white/10 disabled:opacity-50" title="Ask this provider for a list made for you (signs a request)">
              {dvm.state === 'waiting' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <UserRound className="w-3.5 h-3.5" />} Personal picks
            </button>
          )}
          <button onClick={() => setRun((n) => n + 1)} className="p-2 rounded-lg hover:bg-white/10 text-gray-400" aria-label="Refresh" title="Refresh">
            <RefreshCw className={`w-4 h-4 ${!done ? 'animate-spin' : ''}`} />
          </button>
        </div>
      )}
      {def.type === 'dvm' && dvm.message && dvm.state !== 'done' && items.length > 0 && (
        <p className={`mx-4 mt-1 text-[12px] rounded-lg px-3 py-2 ${dvm.state === 'payment' || dvm.state === 'error' ? 'bg-amber-500/10 text-amber-200' : 'bg-white/5 text-gray-400'}`}>{dvm.message}</p>
      )}

      {!done && !items.length && (
        <div className="flex flex-col items-center py-12 text-gray-500">
          <Loader2 className="w-6 h-6 animate-spin mb-2" />
          <p className="text-sm">{def.type === 'dvm' ? (dvm.state === 'waiting' ? 'Asking the provider… some take up to 25 seconds' : 'Getting the provider’s picks…') : 'Running the recipe…'}</p>
        </div>
      )}
      {done && !visible.length && (
        <div className="px-6 py-10 text-center text-sm text-gray-500">
          <Sparkles className="w-6 h-6 mx-auto mb-2 text-gray-700" />
          {def.type === 'dvm'
            ? dvm.state === 'payment'
              ? 'This provider wants sats before it answers, so nothing was sent. Pick a provider marked “working” in the store.'
              : 'This provider is not answering right now. Most of the providers marked “working” in the store answer straight away.'
            : 'Nothing matches this feed right now. Loosen a filter or add more sources.'}
        </div>
      )}

      <div className="divide-y divide-white/5">
        {visible.map((i) => (
          <div key={i.note.id} className="px-4 py-3" data-feed-note={i.note.id}>
            <NoteCard note={i.note} engagement={i.engagement} onSelectNote={onSelectNote} onViewProfile={onViewProfile} />
          </div>
        ))}
      </div>
      {visible.length > 0 && !preview && <div ref={endRef} className="h-10" />}
    </div>
  );
}
