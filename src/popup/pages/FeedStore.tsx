import { useContext, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  ArrowLeft, Store, Search, Plus, Check, Loader2, Eye, X, ChevronUp, ChevronDown, Trash2, Sparkles, Bot,
  ListFilter, CloudUpload, Users, Pencil, HardDrive,
} from 'lucide-react';
import { toast } from 'sonner';
import { AuthContext } from '@/popup/context/AuthContext';
import { useProfile } from '@/popup/hooks/useNostr';
import { NoteThread } from '@/popup/components/NoteThread';
import { CustomFeedView, FeedAuthor } from '@/popup/components/CustomFeedView';
import { FeedBuilder } from '@/popup/components/FeedBuilder';
import { publishEvent } from '@/lib/nostr/publish';
import { publishWithFeedback } from '@/lib/ui/publish-feedback';
import { saveFeedTab, saveCustomTab, type FeedNote } from '@/lib/nostr/feed';
import {
  streamStore, sortStore, matchesSearch, useAddedFeeds, addFeed, removeFeed, moveFeed, isAddedDirty,
  addedListTemplate, markAddedSynced, pullAddedFeeds, pendingGuestFeeds, mergeGuestFeeds, dismissGuestFeeds,
  FORYOU_DEF, FOOD_DEF, KIND_FEED_RECIPE, type FeedDef, type StoreState,
} from '@/lib/nostr/feed-store';

const pulled = new Set<string>();

function FeedImage({ def, size = 'w-12 h-12' }: { def: FeedDef; size?: string }) {
  const [broken, setBroken] = useState(false);
  const Icon = def.type === 'builtin' ? Sparkles : def.type === 'dvm' ? Bot : ListFilter;
  return def.image && !broken
    ? <img src={def.image} alt="" loading="lazy" onError={() => setBroken(true)} className={`${size} rounded-xl object-cover bg-white/5 flex-shrink-0`} />
    : <span className={`${size} rounded-xl bg-purple-500/15 border border-purple-400/20 flex items-center justify-center flex-shrink-0`}><Icon className="w-5 h-5 text-purple-300" /></span>;
}

function TypeChip({ def }: { def: FeedDef }) {
  const label = def.type === 'builtin' || def.addr.startsWith('builtin:') ? 'Nostr Onchain' : def.type === 'dvm' ? 'Algorithm · NIP-90' : def.addr.startsWith('local:') ? 'On this device' : 'Recipe';
  return (
    <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-white/5 border border-white/10 text-gray-400 whitespace-nowrap">
      {label}{def.paid ? ' · asks for sats' : ''}
    </span>
  );
}

function useAuthorName(pubkey: string): string {
  const p = useProfile(pubkey || null);
  return p?.displayName || p?.name || '';
}

function StoreCard({ def, count, added, onAdd, onRemove, onPreview, onFilterName, live }: {
  def: FeedDef; count: number; added: boolean; live?: boolean;
  onAdd: () => void; onRemove: () => void; onPreview: () => void;
  onFilterName?: (name: string) => void;
}) {
  const name = useAuthorName(def.pubkey);
  useEffect(() => { onFilterName?.(name); }, [name, onFilterName]);
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-3 flex gap-3" data-testid="store-card" data-addr={def.addr}>
      <button onClick={onPreview} aria-label={`Preview ${def.title}`}><FeedImage def={def} /></button>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 flex-wrap">
          <button onClick={onPreview} className="text-sm font-semibold text-white text-left truncate max-w-full">{def.title}</button>
          <TypeChip def={def} />
          {live && <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-emerald-500/10 border border-emerald-400/20 text-emerald-200 whitespace-nowrap" title="Posted public picks in the last 3 days">working</span>}
        </div>
        <FeedAuthor pubkey={def.pubkey} />
        {def.description && <p className="text-[12px] text-gray-400 leading-snug mt-0.5 line-clamp-2">{def.description}</p>}
        <div className="flex items-center gap-2 mt-2">
          {def.type === 'builtin' || def.addr.startsWith('builtin:')
            ? <span className="mr-auto" />
            : <span className="text-[11px] text-gray-500 flex items-center gap-1 mr-auto" title="People who added it"><Users className="w-3 h-3" /> {count}</span>}
          <button onClick={onPreview} className="text-[12px] px-2.5 py-1 rounded-lg bg-white/5 hover:bg-white/10 flex items-center gap-1"><Eye className="w-3.5 h-3.5" /> Preview</button>
          {def.type === 'builtin'
            ? <span className="text-[12px] px-2.5 py-1 rounded-lg bg-purple-500/20 text-purple-100 flex items-center gap-1"><Check className="w-3.5 h-3.5" /> On your Feed</span>
            : added
              ? <button onClick={onRemove} className="text-[12px] px-2.5 py-1 rounded-lg bg-purple-500/25 text-purple-100 flex items-center gap-1" data-testid="store-added"><Check className="w-3.5 h-3.5" /> Added</button>
              : <button onClick={onAdd} className="text-[12px] px-2.5 py-1 rounded-lg bg-purple-600 text-white flex items-center gap-1" data-testid="store-add"><Plus className="w-3.5 h-3.5" /> Add</button>}
        </div>
      </div>
    </div>
  );
}

/**
 * The feed store: everyone's published feeds (recipes and NIP-90 algorithm providers), most
 * added first, plus the user's own added feeds to reorder or remove. Guests can browse,
 * preview and add (kept on the device); publishing and syncing need an account.
 */
export function FeedStore() {
  const auth = useContext(AuthContext);
  const navigate = useNavigate();
  const publicKey = auth?.publicKey || '';
  const following = auth?.following ?? new Set<string>();
  const guest = !publicKey;
  const added = useAddedFeeds(publicKey);
  const [store, setStore] = useState<StoreState>({ feeds: [], counts: new Map(), active: new Set(), checked: false, done: false });
  const [q, setQ] = useState('');
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const [preview, setPreview] = useState<FeedDef | null>(null);
  const [building, setBuilding] = useState<FeedDef | 'new' | null>(null);
  const [thread, setThread] = useState<FeedNote | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [pending, setPending] = useState<FeedDef[]>(() => pendingGuestFeeds(publicKey));
  const [run, setRun] = useState(0);
  const [limit, setLimit] = useState({ recipes: 30, dvms: 30 });
  const [showQuiet, setShowQuiet] = useState(false);

  useEffect(() => streamStore(setStore), [run]);
  useEffect(() => {
    if (!publicKey || pulled.has(publicKey)) return;
    pulled.add(publicKey);
    pullAddedFeeds(publicKey).catch(() => {});
  }, [publicKey]);
  useEffect(() => setPending(pendingGuestFeeds(publicKey)), [publicKey, added.items.length]);

  const addedSet = useMemo(() => new Set(added.items.map((x) => x.addr)), [added.items]);
  const feeds = useMemo(() => {
    const all = [...store.feeds];
    // feeds you published that relays haven't returned yet still show
    for (const x of added.items) if (x.pubkey === publicKey && !x.addr.startsWith('local:') && !all.some((f) => f.addr === x.addr)) all.push(x);
    return sortStore(all, store.counts, store.active).filter((f) => matchesSearch(f, q, names.get(f.pubkey) || ''));
  }, [store, q, names, added.items, publicKey]);
  const mine = feeds.filter((f) => f.pubkey === publicKey && f.type === 'recipe');
  const recipes = feeds.filter((f) => f.type === 'recipe');
  // providers that answered lately first; the rest (most announcements on relays) go in a folded list
  const dvms = feeds.filter((f) => f.type === 'dvm' && (!store.checked || store.active.has(f.pubkey)));
  const quiet = store.checked ? feeds.filter((f) => f.type === 'dvm' && !store.active.has(f.pubkey)) : [];
  const setName = (pk: string) => (n: string) => { if (n && names.get(pk) !== n) setNames((m) => new Map(m).set(pk, n)); };

  const feedPath = guest ? '/explore' : '/feed';
  function openTab(def: FeedDef) {
    if (def.type === 'builtin') { saveFeedTab('foryou', guest); navigate(feedPath); return; }
    saveFeedTab('custom', guest);
    saveCustomTab(def.addr);
    navigate(feedPath);
  }
  function add(def: FeedDef) {
    addFeed(publicKey, def);
    toast.success(guest ? `Added "${def.title}" on this device` : `Added "${def.title}" to your Feed tabs`, {
      action: { label: 'Open', onClick: () => openTab(def) },
    });
  }
  function remove(def: FeedDef) {
    removeFeed(publicKey, def.addr);
    toast.success(`Removed "${def.title}"`);
  }

  async function sync() {
    if (!auth?.confirmAndSign) return;
    setSyncing(true);
    try {
      const signed = await auth.confirmAndSign(addedListTemplate(added.items));
      const r = await publishEvent(signed, { resolveAfter: 1 });
      if (!r.success.length) throw new Error('No relay took the list');
      markAddedSynced(publicKey, signed.created_at);
      toast.success('Saved your feeds to Nostr');
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Could not save';
      if (!/cancel/i.test(msg)) toast.error(msg);
    } finally { setSyncing(false); }
  }

  async function del(def: FeedDef) {
    if (!auth?.confirmAndSign || !confirm(`Delete "${def.title}" from Nostr? People who added it will lose it.`)) return;
    try {
      const signed = await auth.confirmAndSign({
        kind: 5, created_at: Math.floor(Date.now() / 1000), content: 'Feed deleted',
        tags: [['a', def.addr], ...(def.eventId ? [['e', def.eventId]] : []), ['k', String(KIND_FEED_RECIPE)]],
      });
      await publishWithFeedback(signed, 'Feed deleted');
      removeFeed(publicKey, def.addr);
      setStore((s) => ({ ...s, feeds: s.feeds.filter((f) => f.addr !== def.addr) }));
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Could not delete';
      if (!/cancel/i.test(msg)) toast.error(msg);
    }
  }

  const dirty = !guest && isAddedDirty(added) && added.items.some((x) => !x.addr.startsWith('local:'));

  return (
    <div className="min-h-full flex flex-col p-4 md:p-6 max-w-2xl mx-auto w-full" data-testid="feed-store">
      <div className="flex items-center gap-3 mb-1">
        <button onClick={() => navigate(feedPath)} className="p-2 -ml-2 rounded-lg hover:bg-white/5" aria-label="Back"><ArrowLeft className="w-5 h-5" /></button>
        <h1 className="text-lg font-bold flex items-center gap-2 flex-1"><Store className="w-5 h-5 text-purple-300" /> Feed store</h1>
        <button onClick={() => setBuilding('new')} className="px-3 py-1.5 rounded-xl bg-purple-600 text-white text-sm font-semibold flex items-center gap-1" data-testid="store-make">
          <Plus className="w-4 h-4" /> Make a feed
        </button>
      </div>
      <p className="text-xs text-gray-400 mb-3">Feeds made by people on Nostr and algorithm feeds from other providers. Add one and it shows as a tab on your Feed.</p>

      {guest && (
        <p className="text-[12px] rounded-xl border border-sky-400/20 bg-sky-500/10 text-sky-100 px-3 py-2 mb-3">
          You're browsing as a guest. Feeds you add are kept on this device. <Link to="/" className="underline">Sign in</Link> to publish feeds and keep your list on every device.
        </p>
      )}
      {!guest && pending.length > 0 && (
        <div className="text-[12px] rounded-xl border border-purple-400/30 bg-purple-500/10 px-3 py-2 mb-3 flex items-center gap-2 flex-wrap">
          <span className="flex-1">You added {pending.length} feed{pending.length === 1 ? '' : 's'} before signing in.</span>
          <button onClick={() => { mergeGuestFeeds(publicKey); setPending([]); toast.success('Added to this account. Tap Save to Nostr to keep them everywhere.'); }} className="px-2.5 py-1 rounded-lg bg-purple-600 text-white">Add them here</button>
          <button onClick={() => { dismissGuestFeeds(); setPending([]); }} className="px-2.5 py-1 rounded-lg bg-white/10">Dismiss</button>
        </div>
      )}

      {/* your tabs */}
      <div className="mb-4" data-testid="store-yours">
        <div className="flex items-center gap-2 mb-1.5">
          <p className="text-[10px] text-gray-500 uppercase tracking-wider flex-1">Your feed tabs</p>
          {dirty && (
            <button onClick={sync} disabled={syncing} className="text-[12px] px-2.5 py-1 rounded-lg bg-white/10 flex items-center gap-1" data-testid="store-sync">
              {syncing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CloudUpload className="w-3.5 h-3.5" />} Save to Nostr
            </button>
          )}
        </div>
        <div className="rounded-2xl border border-white/10 divide-y divide-white/5">
          <div className="flex items-center gap-2 px-3 py-2 text-sm">
            <Sparkles className="w-4 h-4 text-purple-300" /><span className="flex-1">For you · {FORYOU_DEF.title}</span><span className="text-[11px] text-gray-500">built in</span>
          </div>
          {added.items.map((def, i) => (
            <div key={def.addr} className="flex items-center gap-2 px-3 py-2 text-sm" data-testid="store-tab-row">
              <FeedImage def={def} size="w-7 h-7" />
              <button onClick={() => openTab(def)} className="flex-1 min-w-0 text-left truncate">{def.title}</button>
              {def.addr.startsWith('local:') && <HardDrive className="w-3.5 h-3.5 text-gray-500" aria-label="On this device only" />}
              {(def.addr.startsWith('local:') || (def.pubkey === publicKey && def.type === 'recipe')) && (
                <button onClick={() => setBuilding(def)} className="p-1.5 rounded-lg hover:bg-white/10 text-gray-400" aria-label="Edit"><Pencil className="w-3.5 h-3.5" /></button>
              )}
              <button onClick={() => moveFeed(publicKey, def.addr, -1)} disabled={i === 0} className="p-1.5 rounded-lg hover:bg-white/10 text-gray-400 disabled:opacity-30" aria-label="Move up"><ChevronUp className="w-4 h-4" /></button>
              <button onClick={() => moveFeed(publicKey, def.addr, 1)} disabled={i === added.items.length - 1} className="p-1.5 rounded-lg hover:bg-white/10 text-gray-400 disabled:opacity-30" aria-label="Move down"><ChevronDown className="w-4 h-4" /></button>
              <button onClick={() => remove(def)} className="p-1.5 rounded-lg hover:bg-white/10 text-gray-400" aria-label="Remove"><X className="w-4 h-4" /></button>
            </div>
          ))}
          {!added.items.length && <p className="px-3 py-2 text-[12px] text-gray-500">Nothing added yet. Pick feeds below.</p>}
        </div>
      </div>

      <div className="relative mb-4">
        <Search className="w-4 h-4 text-gray-500 absolute left-3 top-1/2 -translate-y-1/2" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search feeds, topics or makers" data-testid="store-search"
          className="w-full bg-white/5 border border-white/10 rounded-full pl-9 pr-4 py-2 text-sm outline-none focus:border-purple-500/50" />
      </div>

      <p className="text-[10px] text-gray-500 uppercase tracking-wider px-1 mb-2">Featured</p>
      <div className="mb-5">
        <StoreCard def={FORYOU_DEF} count={0} added onAdd={() => {}} onRemove={() => {}} onPreview={() => openTab(FORYOU_DEF)} />
        <div className="mt-2">
          <StoreCard def={FOOD_DEF} count={0} added={addedSet.has(FOOD_DEF.addr)} onAdd={() => add(FOOD_DEF)} onRemove={() => remove(FOOD_DEF)} onPreview={() => setPreview(FOOD_DEF)} />
        </div>
      </div>

      {mine.length > 0 && (
        <>
          <p className="text-[10px] text-gray-500 uppercase tracking-wider px-1 mb-2">Made by you</p>
          <div className="space-y-2 mb-5">
            {mine.map((def) => (
              <div key={def.addr} className="relative">
                <StoreCard def={def} count={store.counts.get(def.addr) ?? 0} added={addedSet.has(def.addr)} onAdd={() => add(def)} onRemove={() => remove(def)} onPreview={() => setPreview(def)} />
                <div className="flex gap-2 justify-end mt-1">
                  <button onClick={() => setBuilding(def)} className="text-[11px] text-gray-400 hover:text-white flex items-center gap-1"><Pencil className="w-3 h-3" /> Edit</button>
                  <button onClick={() => del(def)} className="text-[11px] text-red-300/80 hover:text-red-200 flex items-center gap-1"><Trash2 className="w-3 h-3" /> Delete</button>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      <p className="text-[10px] text-gray-500 uppercase tracking-wider px-1 mb-2 flex items-center gap-1.5">
        <ListFilter className="w-3 h-3" /> Feeds people made {!store.done && <Loader2 className="w-3 h-3 animate-spin" />}
      </p>
      <div className="space-y-2 mb-5" data-testid="store-recipes">
        {recipes.filter((f) => f.pubkey !== publicKey).slice(0, limit.recipes).map((def) => (
          <StoreCard key={def.addr} def={def} count={store.counts.get(def.addr) ?? 0} added={addedSet.has(def.addr)} onAdd={() => add(def)} onRemove={() => remove(def)} onPreview={() => setPreview(def)} onFilterName={setName(def.pubkey)} />
        ))}
        {recipes.filter((f) => f.pubkey !== publicKey).length > limit.recipes && (
          <button onClick={() => setLimit((l) => ({ ...l, recipes: l.recipes + 30 }))} className="w-full py-2 rounded-xl bg-white/5 text-sm text-gray-300">Show more</button>
        )}
        {store.done && !recipes.some((f) => f.pubkey !== publicKey) && (
          <p className="text-xs text-gray-500 rounded-2xl border border-white/10 p-3">{q ? 'No feeds match.' : 'No one has published a feed yet. Tap Make a feed to be the first.'}</p>
        )}
      </div>

      <p className="text-[10px] text-gray-500 uppercase tracking-wider px-1 mb-2 flex items-center gap-1.5">
        <Bot className="w-3 h-3" /> Algorithm feeds from other providers {!store.done && <Loader2 className="w-3 h-3 animate-spin" />}
      </p>
      {store.checked && <p className="text-[11px] text-gray-500 px-1 -mt-1 mb-2">Working now: these posted picks in the last 3 days.</p>}
      <div className="space-y-2 mb-8" data-testid="store-dvms">
        {dvms.slice(0, limit.dvms).map((def) => (
          <StoreCard key={def.addr} def={def} live={store.checked && store.active.has(def.pubkey)} count={store.counts.get(def.addr) ?? 0} added={addedSet.has(def.addr)} onAdd={() => add(def)} onRemove={() => remove(def)} onPreview={() => setPreview(def)} onFilterName={setName(def.pubkey)} />
        ))}
        {dvms.length > limit.dvms && (
          <button onClick={() => setLimit((l) => ({ ...l, dvms: l.dvms + 30 }))} className="w-full py-2 rounded-xl bg-white/5 text-sm text-gray-300" data-testid="store-more-dvms">Show more ({dvms.length - limit.dvms})</button>
        )}
        {store.done && !dvms.length && <p className="text-xs text-gray-500 rounded-2xl border border-white/10 p-3">{q ? 'No providers match.' : 'No providers answered.'} <button onClick={() => setRun((n) => n + 1)} className="underline">Try again</button></p>}
        {quiet.length > 0 && (
          <button onClick={() => setShowQuiet((v) => !v)} className="w-full py-2 rounded-xl bg-white/[0.03] border border-white/5 text-[12px] text-gray-400 flex items-center justify-center gap-1" data-testid="store-quiet-toggle">
            {showQuiet ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />} {showQuiet ? 'Hide' : 'Show'} {quiet.length} that haven't posted picks lately
          </button>
        )}
        {showQuiet && quiet.length > 0 && (
          <>
            <p className="text-[11px] text-gray-500 px-1">These only answer when asked, want sats, or have stopped. Opening one asks it with a throwaway key; many never reply.</p>
            {quiet.slice(0, 60).map((def) => (
              <StoreCard key={def.addr} def={def} count={store.counts.get(def.addr) ?? 0} added={addedSet.has(def.addr)} onAdd={() => add(def)} onRemove={() => remove(def)} onPreview={() => setPreview(def)} onFilterName={setName(def.pubkey)} />
            ))}
          </>
        )}
      </div>

      {preview && (
        <div className="fixed inset-0 z-[55] bg-black/80 flex items-stretch md:items-center justify-center" onClick={() => setPreview(null)} data-testid="store-preview">
          <div className="w-full md:max-w-xl md:max-h-[90vh] md:rounded-3xl border border-white/10 bg-surface-900 flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-3 px-4 py-3 border-b border-white/10">
              <FeedImage def={preview} size="w-9 h-9" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold truncate">{preview.title}</p>
                <FeedAuthor pubkey={preview.pubkey} />
              </div>
              {addedSet.has(preview.addr)
                ? <button onClick={() => openTab(preview)} className="text-[12px] px-3 py-1.5 rounded-lg bg-purple-500/25 text-purple-100">Open tab</button>
                : <button onClick={() => add(preview)} className="text-[12px] px-3 py-1.5 rounded-lg bg-purple-600 text-white flex items-center gap-1"><Plus className="w-3.5 h-3.5" /> Add</button>}
              <button onClick={() => setPreview(null)} className="p-2 -mr-2 text-gray-400" aria-label="Close"><X className="w-5 h-5" /></button>
            </div>
            {preview.description && <p className="px-4 pt-2 text-[12px] text-gray-400">{preview.description}</p>}
            <div className="flex-1 overflow-y-auto">
              <CustomFeedView def={preview} publicKey={publicKey} followingPubkeys={following} onSelectNote={setThread} />
            </div>
          </div>
        </div>
      )}

      {building && (
        <FeedBuilder
          initial={building === 'new' ? undefined : building}
          publicKey={publicKey}
          followingPubkeys={following}
          onClose={() => setBuilding(null)}
          onSaved={() => setRun((n) => n + 1)}
          onSelectNote={setThread}
        />
      )}
      {thread && <NoteThread note={thread} profiles={new Map()} onClose={() => setThread(null)} />}
    </div>
  );
}

export default FeedStore;
