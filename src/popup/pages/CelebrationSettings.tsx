import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Check, Play, Upload, Trash2, Loader2, Info, Store, Share2, Globe } from 'lucide-react';
import { toast } from 'sonner';
import {
  EFFECTS, PACK2, ACTIONS, CUSTOM_LIMITS, effectFor, type CelebrationAction, celebrate, loadPrefs, savePrefs, listCustoms, addCustom, updateCustom, removeCustom,
  customEffectId, type CelebrationPrefs, type CustomFile, type CustomMode, type EffectId,
} from '@/lib/ui/celebrations';
import { celebrationTemplate } from '@/lib/nostr/celebration-events';
import { uploadImageToNostrBuild } from '@/lib/nostr/image-upload';
import { publishWithFeedback } from '@/lib/ui/publish-feedback';
import { useAuth } from '@/popup/context/AuthContext';

const EMOJIS = ['🤙', '🎉', '🔥', '⚡', '₿', '💜', '🚀', '🍊', '🫡', '😂', '🥳', '🌽'];
const EMOJI_EFFECTS: EffectId[] = ['emoji-rain', 'emoji-burst', 'giant-emoji'];
const MODES: { id: CustomMode; name: string }[] = [
  { id: 'rain', name: 'Rain' },
  { id: 'burst', name: 'Burst' },
  { id: 'pop', name: 'Pop' },
];

function CustomThumb({ c }: { c: CustomFile }) {
  const [url, setUrl] = useState('');
  useEffect(() => { const u = URL.createObjectURL(c.data); setUrl(u); return () => URL.revokeObjectURL(u); }, [c.data]);
  return c.kind === 'image'
    ? <img src={url} alt="" className="max-w-full max-h-full object-contain" />
    : <video src={url} muted autoPlay loop playsInline className="max-w-full max-h-full" />;
}

export function CelebrationSettings() {
  const navigate = useNavigate();
  const { confirmAndSign } = useAuth();
  const [prefs, setPrefs] = useState<CelebrationPrefs>(() => loadPrefs());
  const [customs, setCustoms] = useState<CustomFile[]>([]);
  const [busy, setBusy] = useState(false);
  const [sharing, setSharing] = useState('');
  const [error, setError] = useState('');
  // which action the picker is choosing for: everything, or one action's own pick
  const [target, setTarget] = useState<'all' | CelebrationAction>('all');
  const fileRef = useRef<HTMLInputElement>(null);

  const reload = () => listCustoms().then(setCustoms);
  useEffect(() => { reload(); }, []);

  const update = (p: Partial<CelebrationPrefs>) => setPrefs(savePrefs(p));
  const current = target === 'all' ? prefs.effect : effectFor(target, prefs);
  const choose = (id: EffectId) => {
    if (target === 'all') update({ effect: id });
    else update({ perAction: { ...prefs.perAction, [target]: id } });
    if (id !== 'none') void celebrate(id);
  };
  const useMain = () => {
    if (target === 'all') return;
    const next = { ...prefs.perAction };
    delete next[target];
    update({ perAction: next });
  };
  const nameOf = (id: EffectId) => [...EFFECTS, ...PACK2].find((e) => e.id === id)?.name
    || customs.find((c) => customEffectId(c.id) === id)?.name || (id === 'none' ? 'None' : 'Custom');

  async function onFile(f?: File) {
    if (!f) return;
    setBusy(true);
    setError('');
    const r = await addCustom(f, { name: f.name.replace(/\.[a-z0-9]+$/i, '').slice(0, 40), mode: 'rain' });
    setBusy(false);
    if (fileRef.current) fileRef.current.value = '';
    if ('error' in r) { setError(r.error); return; }
    await reload();
    choose(customEffectId(r.id));
  }

  async function share(c: CustomFile) {
    setSharing(c.id);
    try {
      const file = new File([c.data], `${c.name || 'celebration'}.${c.type.split('/')[1]?.replace('svg+xml', 'svg') || 'bin'}`, { type: c.type });
      const url = c.shared?.url || await uploadImageToNostrBuild(file);
      const signed = await confirmAndSign(await celebrationTemplate(c, url));
      await publishWithFeedback(signed, `Shared "${c.name}" to the Celebration store`);
      const { nip19 } = await import('nostr-tools');
      const d = signed.tags.find((t) => t[0] === 'd')?.[1] || '';
      await updateCustom(c.id, { shared: { naddr: nip19.naddrEncode({ kind: signed.kind, pubkey: signed.pubkey, identifier: d }), url, author: signed.pubkey } });
      await reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not share it');
    } finally {
      setSharing('');
    }
  }

  const tile = (id: EffectId, icon: React.ReactNode, name: string, line: string, badge?: string) => {
    const on = current === id && (target === 'all' || !!prefs.perAction?.[target]);
    return (
      <button
        key={id}
        onClick={() => choose(id)}
        className={`relative text-left rounded-2xl border p-3 transition-colors min-h-[92px] ${on ? 'border-purple-400/70 bg-purple-500/15' : 'border-white/10 bg-white/[0.03] hover:bg-white/[0.06]'}`}
      >
        <span className="text-3xl leading-none h-8 flex items-center mb-1.5" aria-hidden>{icon}</span>
        <span className="text-sm font-semibold text-white block truncate">{name}</span>
        <span className="text-[11px] text-gray-400 leading-snug block line-clamp-2">{line}</span>
        {badge && <span className="absolute top-2 right-2 text-[9px] uppercase tracking-wider text-purple-200 bg-purple-500/25 rounded-full px-1.5 py-0.5">{badge}</span>}
        {on && <span className="absolute bottom-2 right-2 w-5 h-5 rounded-full bg-purple-500 flex items-center justify-center"><Check className="w-3 h-3 text-white" /></span>}
      </button>
    );
  };

  const added = PACK2.filter((e) => prefs.added?.includes(e.id));

  return (
    <div className="min-h-full flex flex-col p-4 md:p-6 max-w-2xl">
      <div className="flex items-center gap-3 mb-1">
        <button onClick={() => navigate('/settings')} className="p-2 -ml-2 rounded-lg hover:bg-surface-700" aria-label="Back">
          <ArrowLeft className="w-5 h-5" />
        </button>
        <h1 className="text-lg font-bold flex-1">Celebrations</h1>
        <button onClick={() => navigate('/settings/celebrations/store')} className="btn-secondary text-xs flex items-center gap-1.5 px-3 py-2">
          <Store className="w-4 h-4" /> Store
        </button>
      </div>
      <p className="text-xs text-gray-400 mb-4">What plays on your screen when a note, reply, message or zap goes out. Tap one to preview it; the one you tap last is kept.</p>

      {/* what this picker sets: the main one, or one action's own */}
      <div className="flex gap-1.5 overflow-x-auto no-scrollbar -mx-4 px-4 mb-2">
        {[{ id: 'all' as const, name: 'Everything' }, ...ACTIONS].map((a) => (
          <button key={a.id} onClick={() => setTarget(a.id)}
            className={`flex-shrink-0 px-3 py-1.5 rounded-full text-xs font-medium border ${target === a.id ? 'bg-purple-600/25 text-purple-100 border-purple-400/50' : 'border-white/10 text-gray-400 hover:text-white'}`}>
            {a.name}
          </button>
        ))}
      </div>
      <p className="text-[11px] text-gray-500 mb-3 min-h-[1rem]">
        {target === 'all'
          ? <>Plays for everything without its own pick. {ACTIONS.filter((a) => prefs.perAction?.[a.id]).map((a) => `${a.name}: ${nameOf(prefs.perAction![a.id]!)}`).join(' · ')}</>
          : prefs.perAction?.[target]
            ? <>{ACTIONS.find((a) => a.id === target)?.name} play <b className="text-gray-300">{nameOf(prefs.perAction[target]!)}</b>. <button onClick={useMain} className="underline text-purple-300">Use the main one ({nameOf(prefs.effect)})</button></>
            : <>{ACTIONS.find((a) => a.id === target)?.name} use the main one, <b className="text-gray-300">{nameOf(prefs.effect)}</b>. Tap a card to give them their own.</>}
      </p>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5 mb-3">
        {EFFECTS.map((e) => tile(e.id, e.icon, e.name, e.line, e.id === 'confetti' ? 'Default' : undefined))}
        {added.map((e) => tile(e.id, e.icon, e.name, e.line, 'Store'))}
        {customs.map((c) => tile(customEffectId(c.id), <span className="w-8 h-8 rounded-lg overflow-hidden bg-black/40 flex items-center justify-center"><CustomThumb c={c} /></span>, c.name, c.shared ? 'Yours · shared' : 'Yours', c.shared && c.shared.author !== undefined ? undefined : undefined))}
        {tile('none', '🚫', 'None', 'Just the message, no animation')}
      </div>
      <button onClick={() => navigate('/settings/celebrations/store')} className="w-full card mb-3 flex items-center gap-3 text-left hover:border-purple-500/40">
        <Store className="w-5 h-5 text-purple-300" />
        <span className="flex-1"><span className="block text-sm font-semibold">Celebration store</span><span className="block text-[11px] text-gray-400">12 more effects, and ones people have shared on Nostr</span></span>
      </button>

      {EMOJI_EFFECTS.includes(current) && (
        <div className="card mb-3">
          <p className="text-xs text-gray-400 mb-2">Emoji</p>
          <div className="flex flex-wrap gap-1.5 items-center">
            {EMOJIS.map((em) => (
              <button
                key={em}
                onClick={() => { update({ emoji: em }); void celebrate(current, { emoji: em }); }}
                className={`w-10 h-10 rounded-xl text-xl flex items-center justify-center border ${prefs.emoji === em ? 'border-purple-400 bg-purple-500/20' : 'border-white/10 bg-white/[0.03]'}`}
              >{em}</button>
            ))}
            <input
              value={prefs.emoji}
              onChange={(e) => update({ emoji: [...e.target.value].slice(-2).join('') || '🤙' })}
              onBlur={() => void celebrate(current)}
              aria-label="Any emoji"
              className="w-16 h-10 rounded-xl bg-white/5 border border-white/10 text-center text-xl outline-none focus:border-purple-400"
            />
          </div>
        </div>
      )}

      {/* Your own */}
      <div className="card mb-3">
        <div className="flex items-center justify-between gap-2 mb-2">
          <p className="text-sm font-semibold">Your own · {customs.length}/{CUSTOM_LIMITS.slots}</p>
        </div>

        {customs.map((c) => (
          <div key={c.id} className="flex items-center gap-3 py-2 border-b border-white/5 last:border-0">
            <div className="w-14 h-14 rounded-xl bg-black/40 border border-white/10 overflow-hidden flex items-center justify-center flex-shrink-0"><CustomThumb c={c} /></div>
            <div className="min-w-0 flex-1">
              <input
                defaultValue={c.name}
                onBlur={(e) => { const v = e.target.value.trim().slice(0, 40); if (v && v !== c.name) updateCustom(c.id, { name: v }).then(reload); }}
                className="w-full bg-transparent text-sm text-white outline-none border-b border-transparent focus:border-white/20"
                aria-label="Name"
              />
              {c.kind === 'image' ? (
                <div className="flex gap-1 mt-1">
                  {MODES.map((m) => (
                    <button key={m.id} onClick={() => updateCustom(c.id, { mode: m.id }).then(() => { reload(); void celebrate(customEffectId(c.id), { customMode: m.id }); })}
                      className={`text-[10px] px-2 py-0.5 rounded-full border ${c.mode === m.id ? 'border-purple-400 bg-purple-500/20 text-white' : 'border-white/10 text-gray-400'}`}>{m.name}</button>
                  ))}
                </div>
              ) : <p className="text-[10px] text-gray-500 mt-1">Video · plays once over the screen</p>}
              {c.shared && <p className="text-[10px] text-green-400/90 mt-1 flex items-center gap-1"><Globe className="w-3 h-3" /> In the store</p>}
            </div>
            <div className="flex flex-col gap-1">
              <button onClick={() => choose(customEffectId(c.id))} className="p-2 rounded-lg hover:bg-white/10" aria-label="Preview" title="Preview"><Play className="w-4 h-4" /></button>
              <button onClick={() => share(c)} disabled={!!sharing} className="p-2 rounded-lg hover:bg-white/10 disabled:opacity-40" aria-label="Share to the store" title={c.shared ? 'Update in the store' : 'Share to the store'}>
                {sharing === c.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Share2 className="w-4 h-4" />}
              </button>
              <button onClick={() => removeCustom(c.id).then(() => { setPrefs(loadPrefs()); reload(); })} className="p-2 rounded-lg hover:bg-white/10 text-gray-400 hover:text-red-300" aria-label="Remove" title="Remove"><Trash2 className="w-4 h-4" /></button>
            </div>
          </div>
        ))}

        {customs.length < CUSTOM_LIMITS.slots && (
          <button onClick={() => fileRef.current?.click()} disabled={busy} className="btn-primary w-full flex items-center justify-center gap-2 disabled:opacity-60 mt-2">
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
            Upload a file
          </button>
        )}
        <input
          ref={fileRef}
          type="file"
          accept={[...CUSTOM_LIMITS.imageTypes, ...CUSTOM_LIMITS.videoTypes].join(',')}
          className="hidden"
          onChange={(e) => onFile(e.target.files?.[0])}
        />
        {error && <p className="text-xs text-red-400 mt-2">{error}</p>}

        <div className="mt-3 rounded-xl bg-white/[0.03] border border-white/10 p-3 text-[11px] text-gray-400 leading-relaxed space-y-1.5">
          <p className="flex items-center gap-1.5 text-gray-300 font-medium"><Info className="w-3.5 h-3.5" /> What works best</p>
          <p><b className="text-gray-200">Images</b> (PNG, WebP, GIF, APNG, SVG or JPEG, up to {CUSTOM_LIMITS.imageBytes / 1e6} MB) become the pieces of the animation. Use a <b className="text-gray-200">transparent background</b> and a square-ish shape, 256 to 512 px on a side. A GIF shows its first frame. Pick Rain, Burst or Pop.</p>
          <p><b className="text-gray-200">Videos</b> (WebM or MP4, up to {CUSTOM_LIMITS.videoBytes / 1e6} MB and {CUSTOM_LIMITS.videoSeconds} seconds) play once over the middle of the screen, muted. For see-through edges, export a <b className="text-gray-200">WebM with an alpha channel</b> (VP9); an MP4 always shows its own background, so give it a black one.</p>
          <p>Files stay on this device until you tap <Share2 className="w-3 h-3 inline" /> Share. Sharing uploads the file to nostr.build and publishes it as a Nostr event (kind 31616) so anyone can add it from the store.</p>
        </div>
      </div>

      <p className="text-[11px] text-gray-500">If your device asks for reduced motion, a gentle sparkle plays instead.</p>
    </div>
  );
}
