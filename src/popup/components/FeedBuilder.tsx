import { useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { X, Plus, Loader2, Eye, Upload, Users, Hash, Server, Send, HardDrive, ListFilter } from 'lucide-react';
import { toast } from 'sonner';
import { nip19 } from 'nostr-tools';
import { AuthContext } from '@/popup/context/AuthContext';
import { useProfile } from '@/popup/hooks/useNostr';
import { publishWithFeedback } from '@/lib/ui/publish-feedback';
import { parseKeyQuery, searchPeopleOnce, type PeopleHit } from '@/lib/nostr/people-search';
import { resolveNip05 } from '@/lib/nostr/nip05';
import { normalizeRelay, streamQuery, DEFAULT_RELAYS } from '@/lib/nostr/query';
import { useSavedList, cleanTag } from '@/lib/nostr/saved-lists';
import { NO_PROMOTE } from '@/lib/nostr/algo';
import {
  emptyRecipe, recipeTemplate, slugify, addFeed, removeFeed, KIND_FEED_RECIPE, DEFAULT_RECIPE_KINDS,
  type Recipe, type FeedDef,
} from '@/lib/nostr/feed-store';
import type { ShowOnly } from '@/lib/nostr/feed-filters';
import type { FeedNote } from '@/lib/nostr/feed';
import { CustomFeedView } from './CustomFeedView';

interface Props {
  /** edit an existing (own or local) feed */
  initial?: FeedDef;
  publicKey: string;
  followingPubkeys: Set<string>;
  onClose: () => void;
  onSaved?: (def: FeedDef) => void;
  onSelectNote: (n: FeedNote) => void;
}

const KIND_CHOICES: { kinds: number[]; label: string }[] = [
  { kinds: [1], label: 'Notes' },
  { kinds: [20], label: 'Pictures' },
  { kinds: [21, 22], label: 'Videos' },
  { kinds: [30023], label: 'Articles' },
  { kinds: [6, 16], label: 'Reposts' },
];
const ONLY: { id: ShowOnly; label: string }[] = [
  { id: 'all', label: 'Everything' }, { id: 'images', label: 'Images' }, { id: 'video', label: 'Video' },
  { id: 'audio', label: 'Audio' }, { id: 'links', label: 'Links' }, { id: 'text', label: 'Text only' },
];
const MIN_ENG = [0, 1, 3, 5, 10, 25];

const chip = (on: boolean) => `px-3 py-1.5 rounded-full text-[13px] font-medium border whitespace-nowrap transition-colors ${
  on ? 'bg-purple-600/25 text-purple-200 border-purple-500/40' : 'bg-white/5 text-gray-300 border-white/10 hover:border-white/25'}`;

function Section({ title, icon, children }: { title: string; icon?: ReactNode; children: ReactNode }) {
  return (
    <div className="mb-4">
      <p className="text-[11px] uppercase tracking-wide text-gray-500 mb-1.5 flex items-center gap-1.5">{icon}{title}</p>
      {children}
    </div>
  );
}

function PersonChip({ pubkey, onRemove, label }: { pubkey: string; onRemove: () => void; label?: string }) {
  const p = useProfile(pubkey);
  return (
    <span className="inline-flex items-center gap-1 text-xs pl-2.5 pr-1.5 py-1 rounded-full bg-white/10 border border-white/10">
      {label}{p?.displayName || p?.name || nip19.npubEncode(pubkey).slice(0, 12) + '…'}
      <button onClick={onRemove} aria-label="Remove" className="p-0.5 text-gray-400 hover:text-white"><X className="w-3 h-3" /></button>
    </span>
  );
}

/** Build a recipe feed, preview it live, and publish it (or keep it on this device). */
export function FeedBuilder({ initial, publicKey, followingPubkeys, onClose, onSaved, onSelectNote }: Props) {
  const auth = useContext(AuthContext);
  const signedIn = !!(auth && publicKey);
  const [title, setTitle] = useState(initial?.title ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [image, setImage] = useState(initial?.image ?? '');
  const [recipe, setRecipe] = useState<Recipe>(() => (initial?.recipe ? structuredClone(initial.recipe) : emptyRecipe()));
  const [person, setPerson] = useState('');
  const [hits, setHits] = useState<PeopleHit[]>([]);
  const [finding, setFinding] = useState(false);
  const [tag, setTag] = useState('');
  const [relay, setRelay] = useState('');
  const [word, setWord] = useState('');
  const [busy, setBusy] = useState('');
  const [uploading, setUploading] = useState(false);
  const [suffix] = useState(() => Math.random().toString(36).slice(2, 6));
  const [mySets, setMySets] = useState<{ ref: string; title: string; size: number }[]>([]);
  const savedTags = useSavedList('tags', publicKey);
  const savedRelays = useSavedList('relays', publicKey);

  const S = recipe.sources;
  const F = recipe.filters;
  const setS = (p: Partial<Recipe['sources']>) => setRecipe((r) => ({ ...r, sources: { ...r.sources, ...p } }));
  const setF = (p: Partial<Recipe['filters']>) => setRecipe((r) => ({ ...r, filters: { ...r.filters, ...p } }));

  // the signed-in user's own NIP-51 follow sets, offered as sources
  useEffect(() => {
    if (!publicKey) return;
    return streamQuery({
      relays: [...DEFAULT_RELAYS, 'wss://relay.ditto.pub'],
      filters: [{ kinds: [30000], authors: [publicKey], limit: 30 }],
      timeoutMs: 6000,
      onDone: (evs) => {
        const newest = new Map<string, typeof evs[number]>();
        for (const e of evs) { const d = e.tags.find((t) => t[0] === 'd')?.[1] ?? ''; const p = newest.get(d); if (!p || p.created_at < e.created_at) newest.set(d, e); }
        setMySets([...newest.entries()].map(([d, e]) => ({
          ref: `30000:${publicKey}:${d}`,
          title: e.tags.find((t) => t[0] === 'title' || t[0] === 'name')?.[1] || d,
          size: e.tags.filter((t) => t[0] === 'p').length,
        })).filter((x) => x.size > 0));
      },
    });
  }, [publicKey]);

  async function addPerson(mode: 'person' | 'follows', raw = person) {
    const q = raw.trim();
    if (!q) return;
    let pk = parseKeyQuery(q)?.pubkey ?? null;
    if (!pk && q.includes('@')) pk = (await resolveNip05(q).catch(() => null))?.pubkey ?? null;
    if (!pk) {
      setFinding(true);
      const found = await searchPeopleOnce(q, followingPubkeys).catch(() => [] as PeopleHit[]);
      setFinding(false);
      setHits(found.filter((h) => !NO_PROMOTE.has(h.profile.pubkey)).slice(0, 5));
      if (!found.length) toast.error('Nobody found. Paste an npub or name@domain.');
      return;
    }
    if (mode === 'person') setS({ authors: [...new Set([...S.authors, pk])] });
    else setS({ followSets: [...new Set([...S.followSets, `3:${pk}`])] });
    setPerson('');
    setHits([]);
  }
  function addTag(v = tag) { const t = cleanTag(v); if (t) setS({ hashtags: [...new Set([...S.hashtags, t])] }); setTag(''); }
  function addRelay(v = relay) {
    const r = normalizeRelay(/^wss?:\/\//i.test(v.trim()) ? v.trim() : 'wss://' + v.trim());
    if (r) setS({ relays: [...new Set([...S.relays, r])] });
    else if (v.trim()) toast.error('That is not a relay address');
    setRelay('');
  }
  function toggleKinds(kinds: number[]) {
    const on = kinds.every((k) => S.kinds.includes(k));
    const next = on ? S.kinds.filter((k) => !kinds.includes(k)) : [...new Set([...S.kinds, ...kinds])];
    setS({ kinds: next.length ? next : [...DEFAULT_RECIPE_KINDS] });
  }

  async function upload(file: File) {
    setUploading(true);
    try {
      const { uploadImageToNostrBuild } = await import('@/lib/nostr/image-upload');
      setImage(await uploadImageToNostrBuild(file));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Upload failed');
    } finally { setUploading(false); }
  }

  const hasSource = S.follows || S.authors.length > 0 || S.followSets.length > 0 || S.hashtags.length > 0 || S.relays.length > 0;
  // the live preview follows the recipe, a moment after the last change
  const [previewRecipe, setPreviewRecipe] = useState<Recipe | null>(null);
  useEffect(() => {
    if (!hasSource) { setPreviewRecipe(null); return; }
    const t = setTimeout(() => setPreviewRecipe(structuredClone(recipe)), 700);
    return () => clearTimeout(t);
  }, [recipe, hasSource]);
  const previewDef = useMemo<FeedDef | null>(() => (previewRecipe ? {
    addr: 'preview', type: 'recipe', pubkey: publicKey, d: 'preview', title: title || 'Preview', description, image,
    hashtags: previewRecipe.sources.hashtags, createdAt: 0, recipe: previewRecipe,
  } : null), [previewRecipe, publicKey, title, description, image]);

  const isMine = initial && initial.type === 'recipe' && initial.pubkey === publicKey && !initial.addr.startsWith('local:');
  const d = isMine ? initial!.d : `${slugify(title)}-${suffix}`;

  function valid(): boolean {
    if (!title.trim()) { toast.error('Give the feed a name'); return false; }
    if (!hasSource) { toast.error('Add at least one source: people, hashtags or relays'); return false; }
    if (image && !/^https:\/\//.test(image)) { toast.error('The image must be an https link'); return false; }
    return true;
  }

  function saveLocal() {
    if (!valid()) return;
    const id = initial?.addr.startsWith('local:') ? initial.addr : `local:${Date.now().toString(36)}`;
    const def: FeedDef = { addr: id, type: 'recipe', pubkey: publicKey, d: id.slice(6), title: title.trim(), description: description.trim(), image, hashtags: S.hashtags, createdAt: Math.floor(Date.now() / 1000), recipe };
    addFeed(publicKey, def);
    toast.success('Saved on this device and added to your Feed tabs');
    onSaved?.(def);
    onClose();
  }

  async function publish() {
    if (!valid() || !auth?.confirmAndSign || !publicKey) return;
    setBusy('publish');
    try {
      const tmpl = recipeTemplate({ d, title: title.trim(), description: description.trim(), image, recipe });
      const signed = await auth.confirmAndSign(tmpl);
      await publishWithFeedback(signed, 'Feed published!');
      const def: FeedDef = {
        addr: `${KIND_FEED_RECIPE}:${publicKey}:${d}`, type: 'recipe', pubkey: publicKey, d, title: title.trim(),
        description: description.trim(), image, hashtags: S.hashtags, createdAt: signed.created_at, recipe, eventId: signed.id,
      };
      // a published copy replaces the device-only one
      if (initial?.addr.startsWith('local:')) removeFeed(publicKey, initial.addr);
      addFeed(publicKey, def);
      onSaved?.(def);
      onClose();
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Could not publish';
      if (!/cancel/i.test(msg)) toast.error(msg);
    } finally { setBusy(''); }
  }

  return (
    <div className="fixed inset-0 z-[60] bg-black/80 flex items-stretch md:items-center justify-center" data-testid="feed-builder">
      <div className="w-full md:max-w-2xl md:max-h-[92vh] md:rounded-3xl border border-white/10 bg-surface-900 flex flex-col overflow-hidden">
        <div className="flex items-center gap-2 px-4 h-12 border-b border-white/10 flex-shrink-0">
          <ListFilter className="w-4 h-4 text-purple-300" />
          <span className="text-sm font-semibold flex-1">{initial ? 'Edit feed' : 'Make a feed'}</span>
          <button onClick={onClose} className="p-2 -mr-2 text-gray-400 hover:text-white" aria-label="Close"><X className="w-5 h-5" /></button>
        </div>
        <div className="flex-1 overflow-y-auto">
          <div className="p-4">
            <Section title="Name and look">
              <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={80} placeholder="Feed name, e.g. XBT miners" data-testid="builder-title"
                className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-sm outline-none focus:border-purple-500/50 mb-2" />
              <textarea value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} rows={2} placeholder="What's in it, in a sentence"
                className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-sm outline-none focus:border-purple-500/50 mb-2 resize-none" />
              <div className="flex gap-2 items-center">
                {image && /^https:\/\//.test(image) && <img src={image} alt="" className="w-9 h-9 rounded-lg object-cover flex-shrink-0" />}
                <input value={image} onChange={(e) => setImage(e.target.value.trim())} placeholder="Image link (https://…), optional"
                  className="flex-1 min-w-0 bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-sm outline-none focus:border-purple-500/50" />
                {signedIn && (
                  <label className="px-3 py-2 rounded-xl bg-white/10 text-sm cursor-pointer flex items-center gap-1 flex-shrink-0">
                    {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
                    <input type="file" accept="image/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); }} />
                  </label>
                )}
              </div>
            </Section>

            <Section title="People" icon={<Users className="w-3 h-3" />}>
              {signedIn && (
                <label className="flex items-center gap-2 text-sm mb-2">
                  <input type="checkbox" checked={S.follows} onChange={(e) => setS({ follows: e.target.checked })} className="accent-purple-500" />
                  Everyone I follow <span className="text-[11px] text-gray-500">(for whoever reads it: their own follows)</span>
                </label>
              )}
              <div className="flex flex-wrap gap-1.5 mb-2">
                {S.authors.map((pk) => <PersonChip key={pk} pubkey={pk} onRemove={() => setS({ authors: S.authors.filter((x) => x !== pk) })} />)}
                {S.followSets.filter((r) => r.startsWith('3:')).map((r) => <PersonChip key={r} pubkey={r.slice(2)} label="follows of " onRemove={() => setS({ followSets: S.followSets.filter((x) => x !== r) })} />)}
                {S.followSets.filter((r) => r.startsWith('30000:')).map((r) => (
                  <span key={r} className="inline-flex items-center gap-1 text-xs pl-2.5 pr-1.5 py-1 rounded-full bg-white/10 border border-white/10">
                    list: {mySets.find((m) => m.ref === r)?.title || r.split(':').slice(2).join(':')}
                    <button onClick={() => setS({ followSets: S.followSets.filter((x) => x !== r) })} aria-label="Remove" className="p-0.5 text-gray-400"><X className="w-3 h-3" /></button>
                  </span>
                ))}
              </div>
              <form onSubmit={(e) => { e.preventDefault(); addPerson('person'); }} className="flex gap-2">
                <input value={person} onChange={(e) => setPerson(e.target.value)} placeholder="npub, name@domain or a name" data-testid="builder-person"
                  className="flex-1 min-w-0 bg-white/5 border border-white/10 rounded-full px-3 py-1.5 text-sm outline-none" />
                <button className="px-3 py-1.5 rounded-full bg-white/10 text-sm flex items-center gap-1">{finding ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />} Person</button>
                <button type="button" onClick={() => addPerson('follows')} className="px-3 py-1.5 rounded-full bg-white/10 text-sm whitespace-nowrap" title="Everyone this person follows">Their follows</button>
              </form>
              {hits.length > 0 && (
                <div className="mt-1.5 rounded-xl border border-white/10 bg-white/[0.03] p-1">
                  {hits.map((h) => (
                    <button key={h.profile.pubkey} onClick={() => { setS({ authors: [...new Set([...S.authors, h.profile.pubkey])] }); setHits([]); setPerson(''); }}
                      className="w-full text-left px-2.5 py-1.5 rounded-lg hover:bg-white/10 text-sm truncate">
                      {h.profile.displayName || h.profile.name} <span className="text-gray-500 text-xs">{h.profile.nip05 || ''}</span>
                    </button>
                  ))}
                </div>
              )}
              {mySets.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {mySets.filter((m) => !S.followSets.includes(m.ref)).map((m) => (
                    <button key={m.ref} onClick={() => setS({ followSets: [...S.followSets, m.ref] })} className={chip(false)}>+ {m.title} ({m.size})</button>
                  ))}
                </div>
              )}
            </Section>

            <Section title="Hashtags" icon={<Hash className="w-3 h-3" />}>
              <div className="flex flex-wrap gap-1.5 mb-2">
                {S.hashtags.map((t) => <button key={t} onClick={() => setS({ hashtags: S.hashtags.filter((x) => x !== t) })} className={chip(true)}>#{t} ×</button>)}
                {savedTags.items.filter((t) => !S.hashtags.includes(t)).slice(0, 8).map((t) => <button key={t} onClick={() => addTag(t)} className={chip(false)}>+ #{t}</button>)}
              </div>
              <form onSubmit={(e) => { e.preventDefault(); addTag(); }} className="flex gap-2">
                <input value={tag} onChange={(e) => setTag(e.target.value)} placeholder="any hashtag" data-testid="builder-tag" className="flex-1 min-w-0 bg-white/5 border border-white/10 rounded-full px-3 py-1.5 text-sm outline-none" />
                <button className="px-3 py-1.5 rounded-full bg-white/10 text-sm">Add</button>
              </form>
              {(S.authors.length > 0 || S.followSets.length > 0 || S.follows) && S.hashtags.length > 0 && (
                <div className="flex gap-1.5 mt-2">
                  <button onClick={() => setS({ match: 'any' })} className={chip(S.match === 'any')}>These people <i>or</i> these tags</button>
                  <button onClick={() => setS({ match: 'all' })} className={chip(S.match === 'all')}>Only these people's tagged notes</button>
                </div>
              )}
            </Section>

            <Section title="Relays (optional: read only these)" icon={<Server className="w-3 h-3" />}>
              <div className="flex flex-wrap gap-1.5 mb-2">
                {S.relays.map((r) => <button key={r} onClick={() => setS({ relays: S.relays.filter((x) => x !== r) })} className={chip(true)}>{r.replace(/^wss:\/\//, '')} ×</button>)}
                {savedRelays.items.filter((r) => !S.relays.includes(r)).slice(0, 6).map((r) => <button key={r} onClick={() => addRelay(r)} className={chip(false)}>+ {r.replace(/^wss:\/\//, '')}</button>)}
              </div>
              <form onSubmit={(e) => { e.preventDefault(); addRelay(); }} className="flex gap-2">
                <input value={relay} onChange={(e) => setRelay(e.target.value)} placeholder="wss://…" className="flex-1 min-w-0 bg-white/5 border border-white/10 rounded-full px-3 py-1.5 text-sm outline-none" />
                <button className="px-3 py-1.5 rounded-full bg-white/10 text-sm">Add</button>
              </form>
              <p className="text-[11px] text-gray-500 mt-1">With relays and no people or tags, the feed is everything recent on those relays.</p>
            </Section>

            <Section title="What to show">
              <div className="flex flex-wrap gap-1.5 mb-2">
                {KIND_CHOICES.map((k) => <button key={k.label} onClick={() => toggleKinds(k.kinds)} className={chip(k.kinds.every((x) => S.kinds.includes(x)))}>{k.label}</button>)}
              </div>
              <div className="flex flex-wrap gap-1.5 mb-2">
                {ONLY.map((o) => <button key={o.id} onClick={() => setF({ only: o.id })} className={chip(F.only === o.id)}>{o.label}</button>)}
              </div>
              <div className="flex flex-wrap gap-1.5 mb-2">
                <button onClick={() => setF({ noReplies: !F.noReplies })} className={chip(F.noReplies)} aria-pressed={F.noReplies}>No replies</button>
                <button onClick={() => setF({ noReposts: !F.noReposts })} className={chip(F.noReposts)} aria-pressed={F.noReposts}>No reposts</button>
                <button onClick={() => setF({ noHashtags: !F.noHashtags })} className={chip(F.noHashtags)} aria-pressed={F.noHashtags}>No hashtag posts</button>
              </div>
              <p className="text-[12px] text-gray-400 mb-1">Minimum engagement (likes 1, reposts 2, replies 3, zaps by sats)</p>
              <div className="flex flex-wrap gap-1.5 mb-2">
                {MIN_ENG.map((n) => <button key={n} onClick={() => setF({ minEngagement: n })} className={chip(F.minEngagement === n)}>{n === 0 ? 'Any' : `${n}+`}</button>)}
              </div>
              <div className="flex flex-wrap gap-1.5 mb-2">
                {F.mutedWords.map((w) => <button key={w} onClick={() => setF({ mutedWords: F.mutedWords.filter((x) => x !== w) })} className={chip(true)}>“{w}” ×</button>)}
              </div>
              <form onSubmit={(e) => { e.preventDefault(); const w = word.trim(); if (w) setF({ mutedWords: [...new Set([...F.mutedWords, w])] }); setWord(''); }} className="flex gap-2">
                <input value={word} onChange={(e) => setWord(e.target.value)} placeholder="leave out notes with this word" className="flex-1 min-w-0 bg-white/5 border border-white/10 rounded-full px-3 py-1.5 text-sm outline-none" />
                <button className="px-3 py-1.5 rounded-full bg-white/10 text-sm">Add</button>
              </form>
            </Section>

            <Section title="Order">
              <div className="flex gap-1.5">
                <button onClick={() => setRecipe((r) => ({ ...r, ranking: 'chronological' }))} className={chip(recipe.ranking === 'chronological')}>Newest first</button>
                <button onClick={() => setRecipe((r) => ({ ...r, ranking: 'foryou' }))} className={chip(recipe.ranking === 'foryou')}>Ranked like For you</button>
              </div>
            </Section>
          </div>

          <div className="border-t border-white/10" id="feed-builder-preview">
            <p className="px-4 pt-3 text-[11px] uppercase tracking-wide text-gray-500 flex items-center gap-1.5"><Eye className="w-3 h-3" /> Live preview</p>
            {previewDef
              ? <CustomFeedView key={JSON.stringify(previewRecipe)} def={previewDef} publicKey={publicKey} followingPubkeys={followingPubkeys} onSelectNote={onSelectNote} preview />
              : <p className="px-4 py-6 text-sm text-gray-500">Add people, hashtags or relays to see the feed.</p>}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-t border-white/10 flex-shrink-0 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
          <button onClick={saveLocal} className="px-3 py-2 rounded-xl bg-white/10 text-sm flex items-center gap-1.5" data-testid="builder-save-local">
            <HardDrive className="w-4 h-4" /> Keep on this device
          </button>
          <button onClick={() => document.getElementById('feed-builder-preview')?.scrollIntoView({ behavior: 'smooth' })} className="px-3 py-2 rounded-xl bg-white/5 text-sm flex items-center gap-1.5" aria-label="Jump to the preview">
            <Eye className="w-4 h-4" /> <span className="hidden sm:inline">Preview</span>
          </button>
          <span className="flex-1" />
          {signedIn ? (
            <button onClick={publish} disabled={!!busy} className="px-4 py-2 rounded-xl bg-purple-600 text-white text-sm font-semibold flex items-center gap-1.5 disabled:opacity-60" data-testid="builder-publish">
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />} {isMine ? 'Publish changes' : 'Publish feed'}
            </button>
          ) : (
            <Link to="/" className="px-4 py-2 rounded-xl bg-purple-600 text-white text-sm font-semibold">Sign in to publish</Link>
          )}
        </div>
      </div>
    </div>
  );
}
