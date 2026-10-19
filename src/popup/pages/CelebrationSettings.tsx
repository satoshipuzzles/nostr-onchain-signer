import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Check, Play, Upload, Trash2, Loader2, Info } from 'lucide-react';
import {
  EFFECTS, CUSTOM_LIMITS, celebrate, loadPrefs, savePrefs, loadCustom, saveCustom, removeCustom,
  type CelebrationPrefs, type CustomFile, type CustomMode, type EffectId,
} from '@/lib/ui/celebrations';

const EMOJIS = ['🤙', '🎉', '🔥', '⚡', '₿', '💜', '🚀', '🍊', '🫡', '😂', '🥳', '🌽'];
const EMOJI_EFFECTS: EffectId[] = ['emoji-rain', 'emoji-burst', 'giant-emoji'];
const MODES: { id: CustomMode; name: string; line: string }[] = [
  { id: 'rain', name: 'Rain', line: 'Many copies fall from the top' },
  { id: 'burst', name: 'Burst', line: 'Copies explode from the middle' },
  { id: 'pop', name: 'Pop', line: 'One big copy pops up' },
];

export function CelebrationSettings() {
  const navigate = useNavigate();
  const [prefs, setPrefs] = useState<CelebrationPrefs>(() => loadPrefs());
  const [custom, setCustom] = useState<CustomFile | null>(null);
  const [customUrl, setCustomUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => { loadCustom().then(setCustom); }, []);
  useEffect(() => {
    if (!custom) { setCustomUrl(''); return; }
    const u = URL.createObjectURL(custom.data);
    setCustomUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [custom]);

  const update = (p: Partial<CelebrationPrefs>) => setPrefs(savePrefs(p));
  const choose = (id: EffectId) => { update({ effect: id }); if (id !== 'none') void celebrate(id); };

  async function onFile(f?: File) {
    if (!f) return;
    setBusy(true);
    setError('');
    const err = await saveCustom(f);
    setBusy(false);
    if (fileRef.current) fileRef.current.value = '';
    if (err) { setError(err); return; }
    setCustom(await loadCustom());
    update({ effect: 'custom' });
    void celebrate('custom');
  }

  const tile = (id: EffectId, icon: string, name: string, line: string, badge?: string) => {
    const on = prefs.effect === id;
    return (
      <button
        key={id}
        onClick={() => choose(id)}
        className={`relative text-left rounded-2xl border p-3 transition-colors min-h-[92px] ${on ? 'border-purple-400/70 bg-purple-500/15' : 'border-white/10 bg-white/[0.03] hover:bg-white/[0.06]'}`}
      >
        <span className="text-3xl leading-none block mb-1.5" aria-hidden>{icon}</span>
        <span className="text-sm font-semibold text-white block">{name}</span>
        <span className="text-[11px] text-gray-400 leading-snug block">{line}</span>
        {badge && <span className="absolute top-2 right-2 text-[9px] uppercase tracking-wider text-purple-200 bg-purple-500/25 rounded-full px-1.5 py-0.5">{badge}</span>}
        {on && <span className="absolute bottom-2 right-2 w-5 h-5 rounded-full bg-purple-500 flex items-center justify-center"><Check className="w-3 h-3 text-white" /></span>}
      </button>
    );
  };

  return (
    <div className="min-h-full flex flex-col p-4 md:p-6 max-w-2xl">
      <div className="flex items-center gap-3 mb-1">
        <button onClick={() => navigate('/settings')} className="p-2 -ml-2 rounded-lg hover:bg-surface-700" aria-label="Back">
          <ArrowLeft className="w-5 h-5" />
        </button>
        <h1 className="text-lg font-bold">Celebrations</h1>
      </div>
      <p className="text-xs text-gray-400 mb-4">What plays on your screen when a note, reply or message goes out. Tap one to preview it; the one you tap last is kept.</p>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5 mb-3">
        {EFFECTS.map((e) => tile(e.id, e.icon, e.name, e.line, e.id === 'confetti' ? 'Default' : undefined))}
        {tile('custom', '🖼️', 'Your own', custom ? custom.name : 'Upload an image or clip')}
        {tile('none', '🚫', 'None', 'Just the message, no animation')}
      </div>

      {EMOJI_EFFECTS.includes(prefs.effect) && (
        <div className="card mb-3">
          <p className="text-xs text-gray-400 mb-2">Emoji</p>
          <div className="flex flex-wrap gap-1.5 items-center">
            {EMOJIS.map((em) => (
              <button
                key={em}
                onClick={() => { update({ emoji: em }); void celebrate(prefs.effect, { emoji: em }); }}
                className={`w-10 h-10 rounded-xl text-xl flex items-center justify-center border ${prefs.emoji === em ? 'border-purple-400 bg-purple-500/20' : 'border-white/10 bg-white/[0.03]'}`}
              >{em}</button>
            ))}
            <input
              value={prefs.emoji}
              onChange={(e) => update({ emoji: [...e.target.value].slice(-2).join('') || '🤙' })}
              onBlur={() => void celebrate(prefs.effect)}
              aria-label="Any emoji"
              className="w-16 h-10 rounded-xl bg-white/5 border border-white/10 text-center text-xl outline-none focus:border-purple-400"
            />
          </div>
        </div>
      )}

      {/* Custom */}
      <div className="card mb-3">
        <div className="flex items-center justify-between gap-2 mb-2">
          <p className="text-sm font-semibold">Your own animation</p>
          {custom && (
            <button onClick={async () => { await removeCustom(); setCustom(null); if (prefs.effect === 'custom') update({ effect: 'confetti' }); }} className="text-xs text-gray-400 hover:text-red-300 flex items-center gap-1">
              <Trash2 className="w-3.5 h-3.5" /> Remove
            </button>
          )}
        </div>

        {custom ? (
          <div className="flex items-center gap-3 mb-3">
            <div className="w-16 h-16 rounded-xl bg-black/40 border border-white/10 overflow-hidden flex items-center justify-center flex-shrink-0">
              {custom.kind === 'image'
                ? <img src={customUrl} alt="" className="max-w-full max-h-full object-contain" />
                : <video src={customUrl} muted autoPlay loop playsInline className="max-w-full max-h-full" />}
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-xs text-white truncate">{custom.name}</p>
              <p className="text-[11px] text-gray-500">{custom.kind === 'image' ? 'Image' : 'Video'} · {(custom.data.size / 1e6).toFixed(2)} MB</p>
            </div>
            <button onClick={() => { update({ effect: 'custom' }); void celebrate('custom'); }} className="btn-secondary text-xs flex items-center gap-1 px-3 py-2">
              <Play className="w-3.5 h-3.5" /> Preview
            </button>
          </div>
        ) : null}

        {custom?.kind === 'image' && (
          <div className="grid grid-cols-3 gap-2 mb-3">
            {MODES.map((m) => (
              <button
                key={m.id}
                onClick={() => { update({ customMode: m.id, effect: 'custom' }); void celebrate('custom', { customMode: m.id }); }}
                className={`rounded-xl border p-2 text-left ${prefs.customMode === m.id ? 'border-purple-400/70 bg-purple-500/15' : 'border-white/10 bg-white/[0.03]'}`}
              >
                <span className="text-xs font-semibold block">{m.name}</span>
                <span className="text-[10px] text-gray-400 leading-snug block">{m.line}</span>
              </button>
            ))}
          </div>
        )}

        <button onClick={() => fileRef.current?.click()} disabled={busy} className="btn-primary w-full flex items-center justify-center gap-2 disabled:opacity-60">
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
          {custom ? 'Replace file' : 'Upload a file'}
        </button>
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
          <p><b className="text-gray-200">Images</b> (PNG, WebP, GIF, APNG, SVG or JPEG, up to {CUSTOM_LIMITS.imageBytes / 1e6} MB) become the pieces of the animation. Use a <b className="text-gray-200">transparent background</b> and a square-ish shape, 256 to 512 px on a side. A GIF shows its first frame. Pick Rain, Burst or Pop above.</p>
          <p><b className="text-gray-200">Videos</b> (WebM or MP4, up to {CUSTOM_LIMITS.videoBytes / 1e6} MB and {CUSTOM_LIMITS.videoSeconds} seconds) play once over the middle of the screen, muted. For see-through edges, export a <b className="text-gray-200">WebM with an alpha channel</b> (VP9); an MP4 always shows its own background, so give it a black one.</p>
          <p>Your file stays in this browser only: it isn't uploaded or shared, and other devices keep their own choice.</p>
        </div>
      </div>

      <p className="text-[11px] text-gray-500">If your device asks for reduced motion, a gentle sparkle plays instead.</p>
    </div>
  );
}
