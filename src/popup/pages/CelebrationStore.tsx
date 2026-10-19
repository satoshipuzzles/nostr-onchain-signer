import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Check, Play, Plus, Loader2, Store, Users } from 'lucide-react';
import { toast } from 'sonner';
import { PACK2, CUSTOM_LIMITS, celebrate, celebrateFile, loadPrefs, savePrefs, listCustoms, addCustom, customEffectId, type CelebrationPrefs, type CustomFile } from '@/lib/ui/celebrations';
import { streamStore, fetchShared, type SharedCelebration } from '@/lib/nostr/celebration-events';
import { useProfile } from '@/popup/hooks/useNostr';
import { ClickableAvatar } from '@/popup/components/ClickableAvatar';

function Author({ pubkey }: { pubkey: string }) {
  const p = useProfile(pubkey);
  const name = p?.displayName || p?.name || pubkey.slice(0, 10) + '…';
  return (
    <span className="flex items-center gap-1.5 min-w-0">
      <ClickableAvatar pubkey={pubkey} picture={p?.picture} name={name} size="xs" />
      <span className="text-[11px] text-gray-400 truncate">{name}</span>
    </span>
  );
}

export function CelebrationStore() {
  const navigate = useNavigate();
  const [prefs, setPrefs] = useState<CelebrationPrefs>(() => loadPrefs());
  const [customs, setCustoms] = useState<CustomFile[]>([]);
  const [shared, setShared] = useState<SharedCelebration[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [blobs] = useState(() => new Map<string, Blob>());

  useEffect(() => { listCustoms().then(setCustoms); }, []);
  useEffect(() => streamStore((list, done) => { setShared(list); if (done) setLoading(false); }), []);

  const mine = useMemo(() => new Set(customs.map((c) => c.shared?.naddr).filter(Boolean)), [customs]);

  const togglePack = (id: CelebrationPrefs['effect']) => {
    const has = prefs.added?.includes(id);
    const next = savePrefs({ added: has ? (prefs.added || []).filter((x) => x !== id) : [...(prefs.added || []), id], ...(has && prefs.effect === id ? { effect: 'confetti' as const } : {}) });
    setPrefs(next);
    if (!has) { void celebrate(id); toast.success('Added to your celebrations'); }
  };

  async function blobFor(c: SharedCelebration) {
    const have = blobs.get(c.id);
    if (have) return have;
    const b = await fetchShared(c);
    blobs.set(c.id, b);
    return b;
  }

  async function preview(c: SharedCelebration) {
    setBusy(`p:${c.id}`);
    try { await celebrateFile(await blobFor(c), c.mime, c.mode === 'video' ? 'pop' : c.mode); }
    catch (e) { toast.error(e instanceof Error ? e.message : 'Could not load it'); }
    finally { setBusy(''); }
  }

  async function add(c: SharedCelebration) {
    setBusy(`a:${c.id}`);
    try {
      const r = await addCustom(await blobFor(c), { name: c.name, type: c.mime, mode: c.mode === 'video' ? 'pop' : c.mode, shared: { naddr: c.naddr, url: c.url, author: c.pubkey } });
      if ('error' in r) { toast.error(r.error); return; }
      setCustoms(await listCustoms());
      setPrefs(savePrefs({ effect: customEffectId(r.id) }));
      void celebrate(customEffectId(r.id));
      toast.success(`"${c.name}" is now your celebration`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not add it');
    } finally { setBusy(''); }
  }

  return (
    <div className="min-h-full flex flex-col p-4 md:p-6 max-w-2xl">
      <div className="flex items-center gap-3 mb-1">
        <button onClick={() => navigate('/settings/celebrations')} className="p-2 -ml-2 rounded-lg hover:bg-surface-700" aria-label="Back">
          <ArrowLeft className="w-5 h-5" />
        </button>
        <h1 className="text-lg font-bold flex items-center gap-2"><Store className="w-5 h-5 text-purple-300" /> Celebration store</h1>
      </div>
      <p className="text-xs text-gray-400 mb-4">Tap a card to preview it, then add the ones you like. You can keep {CUSTOM_LIMITS.slots} shared or uploaded ones ({customs.length} used); the second pack doesn't count toward that.</p>

      <p className="text-[10px] text-gray-500 uppercase tracking-wider px-1 mb-2">Second pack · 12 effects</p>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5 mb-5">
        {PACK2.map((e) => {
          const has = prefs.added?.includes(e.id);
          return (
            <div key={e.id} className={`relative rounded-2xl border p-3 ${has ? 'border-purple-400/50 bg-purple-500/10' : 'border-white/10 bg-white/[0.03]'}`}>
              <button onClick={() => celebrate(e.id)} className="text-left w-full">
                <span className="text-3xl leading-none block mb-1.5" aria-hidden>{e.icon}</span>
                <span className="text-sm font-semibold text-white block">{e.name}</span>
                <span className="text-[11px] text-gray-400 leading-snug block">{e.line}</span>
              </button>
              <button onClick={() => togglePack(e.id)} className={`mt-2 w-full text-[11px] font-medium rounded-lg py-1.5 flex items-center justify-center gap-1 ${has ? 'bg-purple-500/30 text-purple-100' : 'bg-white/10 text-white hover:bg-white/15'}`}>
                {has ? <><Check className="w-3.5 h-3.5" /> Added</> : <><Plus className="w-3.5 h-3.5" /> Add</>}
              </button>
            </div>
          );
        })}
      </div>

      <p className="text-[10px] text-gray-500 uppercase tracking-wider px-1 mb-2 flex items-center gap-1.5"><Users className="w-3 h-3" /> Shared by people on Nostr {loading && <Loader2 className="w-3 h-3 animate-spin" />}</p>
      {!loading && shared.length === 0 && (
        <p className="text-xs text-gray-500 card mb-3">Nothing shared yet. Upload one in Celebrations and tap Share to be the first.</p>
      )}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5 mb-6">
        {shared.map((c) => {
          const added = mine.has(c.naddr);
          return (
            <div key={c.id} className="rounded-2xl border border-white/10 bg-white/[0.03] p-2.5 flex flex-col">
              <button onClick={() => preview(c)} className="relative aspect-square rounded-xl bg-black/50 overflow-hidden flex items-center justify-center mb-2">
                {c.mime.startsWith('video/')
                  ? <video src={c.url} muted loop autoPlay playsInline className="max-w-full max-h-full" />
                  : <img src={c.url} alt="" loading="lazy" className="max-w-[80%] max-h-[80%] object-contain" />}
                <span className="absolute bottom-1.5 right-1.5 w-7 h-7 rounded-full bg-black/70 flex items-center justify-center">
                  {busy === `p:${c.id}` ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
                </span>
              </button>
              <span className="text-sm font-semibold text-white truncate">{c.name}</span>
              <span className="text-[10px] text-gray-500 mb-1.5">{c.mode === 'video' ? 'Video' : c.mode[0].toUpperCase() + c.mode.slice(1)}</span>
              <Author pubkey={c.pubkey} />
              <button
                onClick={() => add(c)}
                disabled={added || !!busy || customs.length >= CUSTOM_LIMITS.slots}
                className={`mt-2 text-[11px] font-medium rounded-lg py-1.5 flex items-center justify-center gap-1 disabled:opacity-60 ${added ? 'bg-purple-500/30 text-purple-100' : 'bg-white/10 text-white hover:bg-white/15'}`}
              >
                {busy === `a:${c.id}` ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : added ? <><Check className="w-3.5 h-3.5" /> Added</> : <><Plus className="w-3.5 h-3.5" /> Add</>}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
