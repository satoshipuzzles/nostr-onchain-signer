/**
 * Celebrations: the animation that plays when a note, reply or DM goes out.
 *
 * Twelve built-in effects drawn on one full-screen canvas (no libraries), "none", and a
 * custom effect from the user's own file: an image used as falling/bursting/popping
 * sprites, or a short video played over the screen. The choice lives in localStorage;
 * custom files live in IndexedDB so they don't eat the small localStorage quota.
 */

export type EffectId =
  | 'confetti' | 'emoji-rain' | 'emoji-burst' | 'giant-emoji' | 'fireworks' | 'coins'
  | 'hearts' | 'lightning' | 'sparkles' | 'balloons' | 'rocket' | 'shockwave'
  // the second pack
  | 'matrix' | 'lasers' | 'orange-pills' | 'blocks' | 'bubbles' | 'snow'
  | 'supernova' | 'paper-planes' | 'disco' | 'ripples' | 'pizza' | 'to-the-moon'
  | 'custom' | 'none';

export type CustomMode = 'rain' | 'burst' | 'pop';

export interface CelebrationPrefs {
  effect: EffectId;
  /** Emoji used by the emoji effects */
  emoji: string;
  /** How a custom image is used; videos always play over the screen */
  customMode: CustomMode;
  /** second-pack effects the user added from the store */
  added?: EffectId[];
  /** a different celebration for some actions; missing = the main one (`effect`) */
  perAction?: Partial<Record<CelebrationAction, EffectId>>;
}

export type CelebrationAction = 'note' | 'reply' | 'zap' | 'reaction' | 'repost' | 'dm';
export const ACTIONS: { id: CelebrationAction; name: string }[] = [
  { id: 'note', name: 'Notes' },
  { id: 'reply', name: 'Replies' },
  { id: 'zap', name: 'Zaps' },
  { id: 'reaction', name: 'Likes' },
  { id: 'repost', name: 'Reposts' },
  { id: 'dm', name: 'Messages' },
];
/** What plays for an action: its own pick, else the main celebration. */
export function effectFor(action: CelebrationAction, prefs = loadPrefs()): EffectId {
  return prefs.perAction?.[action] ?? prefs.effect;
}
/** Play the celebration the user picked for this action. */
export function celebrateAction(action: CelebrationAction): Promise<void> {
  return celebrate(effectFor(action));
}

export const EFFECTS: { id: EffectId; name: string; icon: string; line: string }[] = [
  { id: 'confetti', name: 'Confetti', icon: '🎉', line: 'Two cannons of paper (default)' },
  { id: 'emoji-rain', name: 'Emoji rain', icon: '🌧️', line: 'Big emojis pour down' },
  { id: 'emoji-burst', name: 'Emoji burst', icon: '💥', line: 'Emojis explode from the middle' },
  { id: 'giant-emoji', name: 'Giant emoji', icon: '🤩', line: 'One huge emoji pops and bounces' },
  { id: 'fireworks', name: 'Fireworks', icon: '🎆', line: 'Rockets and sparkling bursts' },
  { id: 'coins', name: 'Coin shower', icon: '🪙', line: 'Spinning ₿ coins rain down' },
  { id: 'hearts', name: 'Hearts', icon: '💜', line: 'Hearts float up and sway' },
  { id: 'lightning', name: 'Lightning', icon: '⚡', line: 'A flash and forked bolts' },
  { id: 'sparkles', name: 'Sparkles', icon: '✨', line: 'Stars twinkle all over' },
  { id: 'balloons', name: 'Balloons', icon: '🎈', line: 'A bunch of balloons drifts up' },
  { id: 'rocket', name: 'Rocket', icon: '🚀', line: 'Launch with a smoke trail' },
  { id: 'shockwave', name: 'Shockwave', icon: '🌀', line: 'Glowing rings ripple out' },
];

/** The second pack, offered in the Celebration store alongside what people share. */
export const PACK2: { id: EffectId; name: string; icon: string; line: string }[] = [
  { id: 'matrix', name: 'Matrix', icon: '🟩', line: 'Green code pours down the screen' },
  { id: 'lasers', name: 'Laser show', icon: '🔦', line: 'Beams sweep from the corners' },
  { id: 'orange-pills', name: 'Orange pills', icon: '💊', line: 'Pills bounce in from the top' },
  { id: 'blocks', name: 'Block party', icon: '🧱', line: 'Blocks drop and stack up' },
  { id: 'bubbles', name: 'Bubbles', icon: '🫧', line: 'Soap bubbles float up and pop' },
  { id: 'snow', name: 'Snowfall', icon: '❄️', line: 'A quiet flurry of flakes' },
  { id: 'supernova', name: 'Supernova', icon: '🌟', line: 'A star bursts into rays' },
  { id: 'paper-planes', name: 'Paper planes', icon: '🛩️', line: 'A squadron glides across' },
  { id: 'disco', name: 'Disco', icon: '🪩', line: 'Spinning colored light' },
  { id: 'ripples', name: 'Ripples', icon: '💧', line: 'Drops ripple across a pond' },
  { id: 'pizza', name: 'Pizza day', icon: '🍕', line: '10,000 BTC worth of pizza' },
  { id: 'to-the-moon', name: 'To the moon', icon: '🌕', line: 'Rockets race to a rising moon' },
];

const KEY = 'celebration_prefs_v1';
const DEFAULTS: CelebrationPrefs = { effect: 'confetti', emoji: '🤙', customMode: 'rain', added: [] };
const PALETTE = ['#a855f7', '#7c3aed', '#f7931a', '#22c55e', '#3b82f6', '#ec4899', '#eab308', '#ffffff'];

export function loadPrefs(): CelebrationPrefs {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (v && typeof v === 'object') return { ...DEFAULTS, ...v };
  } catch { /* blocked storage */ }
  return { ...DEFAULTS };
}

export function savePrefs(p: Partial<CelebrationPrefs>): CelebrationPrefs {
  const next = { ...loadPrefs(), ...p };
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* blocked storage */ }
  return next;
}

// ---------------------------------------------------------------- custom files (IndexedDB)

export const CUSTOM_LIMITS = {
  slots: 5,
  imageBytes: 1_000_000,
  videoBytes: 4_000_000,
  videoSeconds: 6,
  imageTypes: ['image/png', 'image/gif', 'image/webp', 'image/svg+xml', 'image/apng', 'image/jpeg'],
  videoTypes: ['video/webm', 'video/mp4'],
};

export interface CustomFile {
  id: string;
  kind: 'image' | 'video';
  type: string;
  name: string;
  data: Blob;
  /** how an image is used; videos always play over the screen */
  mode: CustomMode;
  /** where it came from when added from the store, or where it was shared */
  shared?: { naddr: string; url: string; author: string };
  addedAt: number;
}

/** prefs.effect for a custom celebration is `custom:<id>` */
export const customEffectId = (id: string) => `custom:${id}` as EffectId;
export const isCustomEffect = (e: string) => e === 'custom' || e.startsWith('custom:');

function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open('celebrations', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('files');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function idb<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  return db().then((d) => new Promise((resolve, reject) => {
    const tx = d.transaction('files', mode);
    const req = fn(tx.objectStore('files'));
    tx.oncomplete = () => resolve(req ? (req as IDBRequest<T>).result : undefined);
    tx.onerror = () => reject(tx.error);
  }));
}

/** All saved custom celebrations, oldest first. The single file of the first version is kept as one. */
export async function listCustoms(): Promise<CustomFile[]> {
  try {
    const all = (await idb<unknown[]>('readonly', (st) => st.getAll())) || [];
    const keys = (await idb<IDBValidKey[]>('readonly', (st) => st.getAllKeys())) || [];
    return all.map((v, i) => {
      const f = v as Partial<CustomFile> & { data: Blob };
      return { id: f.id || String(keys[i]), kind: f.kind || 'image', type: f.type || '', name: f.name || 'Custom', data: f.data, mode: f.mode || loadPrefs().customMode, shared: f.shared, addedAt: f.addedAt || 0 } as CustomFile;
    }).filter((f) => f.data).sort((x, y) => x.addedAt - y.addedAt);
  } catch { return []; }
}

export async function loadCustom(id?: string): Promise<CustomFile | null> {
  const all = await listCustoms();
  return (id ? all.find((f) => f.id === id) : all[0]) || null;
}

async function checkFile(file: Blob, type: string): Promise<string | null> {
  const isImage = CUSTOM_LIMITS.imageTypes.includes(type);
  const isVideo = CUSTOM_LIMITS.videoTypes.includes(type);
  if (!isImage && !isVideo) return 'Use a PNG, GIF, WebP, APNG, SVG or JPEG image, or a WebM or MP4 video.';
  if (isImage && file.size > CUSTOM_LIMITS.imageBytes) return `Images can be up to ${CUSTOM_LIMITS.imageBytes / 1e6} MB; this one is ${(file.size / 1e6).toFixed(1)} MB.`;
  if (isVideo && file.size > CUSTOM_LIMITS.videoBytes) return `Videos can be up to ${CUSTOM_LIMITS.videoBytes / 1e6} MB; this one is ${(file.size / 1e6).toFixed(1)} MB.`;
  if (isVideo) {
    const secs = await videoSeconds(file).catch(() => NaN);
    if (!Number.isFinite(secs)) return 'That video could not be read. Try exporting it again as WebM or MP4.';
    if (secs > CUSTOM_LIMITS.videoSeconds + 0.3) return `Keep videos to ${CUSTOM_LIMITS.videoSeconds} seconds or less; this one is ${secs.toFixed(1)} s.`;
  } else {
    const ok = await new Promise<boolean>((res) => { const i = new Image(); i.onload = () => res(true); i.onerror = () => res(false); i.src = URL.createObjectURL(file); });
    if (!ok) return 'That image could not be read.';
  }
  return null;
}

/** Saves a new custom celebration. Returns its id, or an error message. */
export async function addCustom(
  file: Blob, opts: { name: string; type?: string; mode?: CustomMode; shared?: CustomFile['shared'] },
): Promise<{ id: string } | { error: string }> {
  const type = opts.type || file.type;
  const have = await listCustoms();
  if (have.length >= CUSTOM_LIMITS.slots) return { error: `You can keep ${CUSTOM_LIMITS.slots} of your own. Remove one to make room.` };
  if (opts.shared && have.some((f) => f.shared?.naddr === opts.shared!.naddr)) return { error: 'That one is already in your celebrations.' };
  const err = await checkFile(file, type);
  if (err) return { error: err };
  const id = `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const rec: CustomFile = {
    id, kind: CUSTOM_LIMITS.imageTypes.includes(type) ? 'image' : 'video', type,
    name: (opts.name || 'Custom').slice(0, 40), data: file, mode: opts.mode || 'rain', shared: opts.shared, addedAt: Date.now(),
  };
  try { await idb('readwrite', (st) => st.put(rec, id)); } catch { return { error: 'This browser would not store the file (private mode or storage full).' }; }
  assetCache.delete(id);
  return { id };
}

/** Kept for the first version's single slot. */
export async function saveCustom(file: File): Promise<string | null> {
  const r = await addCustom(file, { name: file.name.replace(/\.[a-z0-9]+$/i, ''), mode: loadPrefs().customMode });
  return 'error' in r ? r.error : null;
}

export async function updateCustom(id: string, patch: Partial<Pick<CustomFile, 'name' | 'mode' | 'shared'>>): Promise<void> {
  const cur = await loadCustom(id);
  if (!cur) return;
  await idb('readwrite', (st) => st.put({ ...cur, ...patch }, id)).catch(() => {});
  assetCache.delete(id);
}

export async function removeCustom(id?: string): Promise<void> {
  const target = id ?? (await loadCustom())?.id;
  if (!target) return;
  await idb('readwrite', (st) => st.delete(target)).catch(() => {});
  assetCache.delete(target);
  const prefs = loadPrefs();
  if (prefs.effect === customEffectId(target) || (prefs.effect === 'custom' && !(await loadCustom()))) savePrefs({ effect: 'confetti' });
}

function videoSeconds(file: Blob): Promise<number> {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.onloadedmetadata = () => { resolve(v.duration); URL.revokeObjectURL(v.src); };
    v.onerror = () => reject(new Error('unreadable'));
    v.src = URL.createObjectURL(file);
  });
}

const assetCache = new Map<string, { file: CustomFile; url: string; img?: HTMLImageElement }>();
async function customAsset(id?: string) {
  const file = await loadCustom(id);
  if (!file) return null;
  const hit = assetCache.get(file.id);
  if (hit) return hit;
  const url = URL.createObjectURL(file.data);
  let img: HTMLImageElement | undefined;
  if (file.kind === 'image') {
    img = new Image();
    img.src = url;
    await img.decode().catch(() => {});
  }
  const a = { file, url, img };
  assetCache.set(file.id, a);
  return a;
}

/** Plays a file that isn't saved (a preview in the store). */
export async function celebrateFile(blob: Blob, type: string, mode: CustomMode): Promise<void> {
  if (CUSTOM_LIMITS.videoTypes.includes(type)) { playVideo(URL.createObjectURL(blob)); return; }
  const img = new Image();
  img.src = URL.createObjectURL(blob);
  await img.decode().catch(() => {});
  await run(`custom-${mode}`, loadPrefs(), img);
}

// ---------------------------------------------------------------- engine

interface P {
  x: number; y: number; vx: number; vy: number;
  size: number; rot: number; spin: number; life: number; age: number;
  color: string; g: number; drag: number; sway?: number; phase?: number;
  draw: (c: CanvasRenderingContext2D, p: P, t: number) => void;
  /** spawn more particles when it dies (fireworks) */
  onDie?: (p: P) => P[];
}

const rnd = (a: number, b: number) => a + Math.random() * (b - a);
const pick = <T,>(a: T[]) => a[Math.floor(Math.random() * a.length)];

function emojiDraw(ch: string): P["draw"] {
  return (c: CanvasRenderingContext2D, p: P) => {
    c.font = `${p.size}px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif`;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText(ch, 0, 0);
  };
}
function spriteDraw(img: HTMLImageElement): P["draw"] {
  return (c: CanvasRenderingContext2D, p: P) => {
    const r = img.naturalWidth / (img.naturalHeight || 1) || 1;
    const w = r >= 1 ? p.size : p.size * r;
    const h = r >= 1 ? p.size / r : p.size;
    c.drawImage(img, -w / 2, -h / 2, w, h);
  };
}
const rectDraw = (c: CanvasRenderingContext2D, p: P) => {
  c.fillStyle = p.color;
  c.beginPath();
  c.roundRect(-p.size / 2, -p.size * 0.7, p.size, p.size * 1.4, 2);
  c.fill();
};
const dotDraw = (c: CanvasRenderingContext2D, p: P) => {
  c.fillStyle = p.color;
  c.shadowColor = p.color;
  c.shadowBlur = 12;
  c.beginPath();
  c.arc(0, 0, p.size, 0, Math.PI * 2);
  c.fill();
};
const starDraw = (c: CanvasRenderingContext2D, p: P, t: number) => {
  const tw = 0.5 + 0.5 * Math.sin(t / 90 + (p.phase ?? 0));
  const s = p.size * (0.6 + tw * 0.6);
  c.fillStyle = p.color;
  c.shadowColor = p.color;
  c.shadowBlur = 16;
  c.beginPath();
  for (let i = 0; i < 8; i++) {
    const r = i % 2 ? s * 0.28 : s;
    const a = (i * Math.PI) / 4;
    c.lineTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  c.closePath();
  c.fill();
};
const coinDraw = (c: CanvasRenderingContext2D, p: P, t: number) => {
  const squash = Math.abs(Math.cos(t / 160 + (p.phase ?? 0)));
  c.scale(Math.max(0.12, squash), 1);
  const g = c.createRadialGradient(-p.size * 0.3, -p.size * 0.3, 1, 0, 0, p.size);
  g.addColorStop(0, p.color === '#a855f7' ? '#e9d5ff' : '#fff3c4');
  g.addColorStop(1, p.color);
  c.fillStyle = g;
  c.beginPath();
  c.arc(0, 0, p.size, 0, Math.PI * 2);
  c.fill();
  c.fillStyle = 'rgba(0,0,0,0.35)';
  c.font = `bold ${p.size * 1.15}px system-ui,sans-serif`;
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  if (squash > 0.35) c.fillText('₿', 0, p.size * 0.06);
};
const heartDraw = (c: CanvasRenderingContext2D, p: P) => {
  const s = p.size / 16;
  c.fillStyle = p.color;
  c.scale(s, s);
  c.beginPath();
  c.moveTo(0, 5);
  c.bezierCurveTo(-14, -6, -6, -16, 0, -8);
  c.bezierCurveTo(6, -16, 14, -6, 0, 5);
  c.fill();
};
const balloonDraw = (c: CanvasRenderingContext2D, p: P) => {
  const r = p.size;
  c.strokeStyle = 'rgba(255,255,255,0.5)';
  c.lineWidth = 1.2;
  c.beginPath();
  c.moveTo(0, r * 1.15);
  c.quadraticCurveTo(r * 0.3, r * 1.8, 0, r * 2.6);
  c.stroke();
  const g = c.createRadialGradient(-r * 0.35, -r * 0.4, r * 0.1, 0, 0, r * 1.2);
  g.addColorStop(0, 'rgba(255,255,255,0.85)');
  g.addColorStop(0.25, p.color);
  g.addColorStop(1, p.color);
  c.fillStyle = g;
  c.beginPath();
  c.ellipse(0, 0, r * 0.85, r * 1.1, 0, 0, Math.PI * 2);
  c.fill();
  c.beginPath();
  c.moveTo(-r * 0.12, r * 1.08);
  c.lineTo(r * 0.12, r * 1.08);
  c.lineTo(0, r * 1.22);
  c.fill();
};
const ringDraw = (c: CanvasRenderingContext2D, p: P) => {
  const k = p.age / p.life;
  c.strokeStyle = p.color;
  c.shadowColor = p.color;
  c.shadowBlur = 24;
  c.lineWidth = Math.max(1, 10 * (1 - k));
  c.beginPath();
  c.arc(0, 0, p.size * (0.1 + k * 1.1), 0, Math.PI * 2);
  c.stroke();
};

function base(o: Partial<P> & { draw: P['draw'] }): P {
  return { x: 0, y: 0, vx: 0, vy: 0, size: 10, rot: 0, spin: 0, life: 2000, age: 0, color: '#fff', g: 0, drag: 1, ...o };
}

function build(effect: string, W: number, H: number, prefs: CelebrationPrefs, sprite?: HTMLImageElement): { ps: P[]; dur: number; flash?: boolean; bolts?: boolean } {
  const em = emojiDraw(prefs.emoji || '🤙');
  const art = sprite ? spriteDraw(sprite) : em;
  const big = Math.min(W, H);
  switch (effect) {
    case 'confetti': {
      const ps: P[] = [];
      for (const side of [-1, 1]) for (let i = 0; i < 90; i++) {
        const a = (side < 0 ? -60 : -120) + rnd(-18, 18);
        const sp = rnd(13, 26) * (big / 800 + 0.5);
        ps.push(base({ x: side < 0 ? 0 : W, y: H * 0.95, vx: Math.cos((a * Math.PI) / 180) * sp, vy: Math.sin((a * Math.PI) / 180) * sp, size: rnd(6, 11), rot: rnd(0, 360), spin: rnd(-14, 14), color: pick(PALETTE), g: 0.38, drag: 0.985, life: rnd(2400, 3200), draw: rectDraw, sway: rnd(0.5, 2), phase: rnd(0, 6) }));
      }
      return { ps, dur: 3300 };
    }
    case 'emoji-rain':
    case 'custom-rain': {
      const n = Math.round(W / 22);
      return { ps: Array.from({ length: n }, () => base({ x: rnd(0, W), y: rnd(-H * 0.8, -40), vy: rnd(3, 7), vx: rnd(-0.6, 0.6), size: rnd(34, 64), rot: rnd(-20, 20), spin: rnd(-1.5, 1.5), g: 0.08, drag: 0.995, life: 3400, draw: art })), dur: 3400 };
    }
    case 'emoji-burst':
    case 'custom-burst':
      return { ps: Array.from({ length: 34 }, () => { const a = rnd(0, Math.PI * 2); const sp = rnd(6, 17); return base({ x: W / 2, y: H * 0.45, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 4, size: rnd(36, 72), spin: rnd(-6, 6), g: 0.3, drag: 0.975, life: 2600, draw: art }); }), dur: 2600 };
    case 'giant-emoji':
    case 'custom-pop':
      return {
        ps: [base({ x: W / 2, y: H * 0.45, size: big * 0.55, life: 2200, draw: (c, p, t) => {
          const k = p.age / p.life;
          // overshoot pop in, a little wobble, then grow and fade
          const pop = k < 0.18 ? (k / 0.18) * 1.15 : k < 0.3 ? 1.15 - ((k - 0.18) / 0.12) * 0.15 : 1 + (k > 0.75 ? (k - 0.75) * 1.4 : 0);
          c.rotate(Math.sin(t / 110) * 0.08 * (k < 0.75 ? 1 : 0));
          c.scale(pop, pop);
          art(c, p, t);
        } })],
        dur: 2200,
      };
    case 'fireworks': {
      const ps: P[] = [];
      for (let i = 0; i < 6; i++) {
        const color = pick(PALETTE);
        ps.push(base({ x: rnd(W * 0.15, W * 0.85), y: H + 10, vx: rnd(-1.5, 1.5), vy: -rnd(H / 70, H / 48), size: 3, g: 0.22, drag: 0.995, life: rnd(700, 1100) + i * 220, color, draw: dotDraw,
          onDie: (p) => Array.from({ length: 60 }, () => { const a = rnd(0, Math.PI * 2); const sp = rnd(2, 8); return base({ x: p.x, y: p.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, size: rnd(1.5, 3), g: 0.08, drag: 0.965, life: rnd(900, 1500), color: Math.random() < 0.2 ? '#fff' : color, draw: dotDraw }); }) }));
        ps[ps.length - 1].age = -i * 220; // stagger the launches
      }
      return { ps, dur: 3600 };
    }
    case 'coins':
      return { ps: Array.from({ length: 46 }, () => base({ x: rnd(0, W), y: rnd(-H * 0.7, -30), vy: rnd(4, 8), vx: rnd(-1, 1), size: rnd(12, 22), g: 0.12, drag: 0.995, life: 3300, color: Math.random() < 0.75 ? '#f7931a' : '#a855f7', phase: rnd(0, 6), draw: coinDraw })), dur: 3300 };
    case 'hearts':
      return { ps: Array.from({ length: 40 }, () => base({ x: rnd(W * 0.1, W * 0.9), y: H + rnd(10, H * 0.5), vy: -rnd(2.5, 5.5), size: rnd(18, 42), g: -0.01, drag: 1, life: 3600, color: pick(['#a855f7', '#ec4899', '#f43f5e', '#c084fc']), sway: rnd(1, 2.5), phase: rnd(0, 6), draw: heartDraw })), dur: 3600 };
    case 'lightning':
      return { ps: [], dur: 1300, flash: true, bolts: true };
    case 'sparkles':
      return { ps: Array.from({ length: 70 }, () => base({ x: rnd(0, W), y: rnd(0, H), size: rnd(5, 14), life: rnd(1200, 2600), color: pick(['#fff', '#fde68a', '#c4b5fd', '#f7931a']), phase: rnd(0, 6), draw: starDraw })), dur: 2700 };
    case 'balloons':
      return { ps: Array.from({ length: 16 }, () => base({ x: rnd(W * 0.08, W * 0.92), y: H + rnd(40, H * 0.6), vy: -rnd(3, 5.5), size: rnd(22, 36), life: 4000, color: pick(['#a855f7', '#f7931a', '#22c55e', '#3b82f6', '#ec4899', '#eab308']), sway: rnd(0.6, 1.4), phase: rnd(0, 6), draw: balloonDraw })), dur: 4000 };
    case 'rocket': {
      const rocket = base({ x: -60, y: H * 0.85, vx: W / 70, vy: -H / 95, size: Math.max(56, big * 0.13), life: 1900, draw: (c, p) => { c.rotate(Math.atan2(p.vy, p.vx) + Math.PI / 4); emojiDraw('🚀')(c, p, 0); } });
      return { ps: [rocket], dur: 2600 };
    }
    case 'shockwave':
      return { ps: Array.from({ length: 4 }, (_, i) => { const r = base({ x: W / 2, y: H * 0.45, size: Math.hypot(W, H) * 0.6, life: 1500, color: i % 2 ? '#f7931a' : '#a855f7', draw: ringDraw }); r.age = -i * 180; return r; }), dur: 2100 };
    case 'matrix': {
      const cols = Math.ceil(W / 18);
      const glyphs = '₿01アイウエオカキクケコサシスセソタチツテトナニヌネノ'.split('');
      return { ps: Array.from({ length: cols }, (_, i) => base({ x: i * 18 + 9, y: rnd(-H, 0), vy: rnd(7, 14), size: 16, life: 2600, phase: rnd(0, 100), draw: (c, p, t) => {
        c.font = 'bold 15px ui-monospace,monospace'; c.textAlign = 'center';
        for (let k = 0; k < 14; k++) {
          c.fillStyle = k === 0 ? '#eafff0' : `rgba(34,197,94,${Math.max(0, 1 - k / 14)})`;
          c.fillText(glyphs[Math.floor((t / 70 + (p.phase ?? 0) + k * 7)) % glyphs.length], 0, -k * 17);
        }
      } })), dur: 2700 };
    }
    case 'lasers':
      return { ps: Array.from({ length: 6 }, (_, i) => base({ x: i % 2 ? W : 0, y: i < 2 ? 0 : i < 4 ? H : H / 2, size: Math.hypot(W, H), life: 2200, color: pick(['#a855f7', '#22c55e', '#3b82f6', '#ec4899', '#f7931a']), phase: rnd(0, 6), draw: (c, p, t) => {
        const a = Math.atan2(H / 2 - p.y, W / 2 - p.x) + Math.sin(t / 260 + (p.phase ?? 0)) * 0.7;
        c.rotate(a); c.strokeStyle = p.color; c.shadowColor = p.color; c.shadowBlur = 18; c.lineWidth = 3;
        c.beginPath(); c.moveTo(0, 0); c.lineTo(p.size, 0); c.stroke();
      } })), dur: 2300 };
    case 'orange-pills':
      return { ps: Array.from({ length: 30 }, () => base({ x: rnd(0, W), y: rnd(-H * 0.5, -20), vy: rnd(2, 6), vx: rnd(-2, 2), size: rnd(26, 44), rot: rnd(0, 360), spin: rnd(-4, 4), g: 0.32, drag: 0.995, life: 3200, draw: (c, p) => {
        const w = p.size, h = p.size * 0.42;
        c.fillStyle = '#f7931a'; c.beginPath(); c.roundRect(-w / 2, -h / 2, w / 2, h, [h / 2, 0, 0, h / 2]); c.fill();
        c.fillStyle = '#fff7ed'; c.beginPath(); c.roundRect(0, -h / 2, w / 2, h, [0, h / 2, h / 2, 0]); c.fill();
      }, onDie: undefined })).map((p) => { const floor = H - 30; const d = p.draw; p.draw = (c, q, t) => { if (q.y > floor && q.vy > 0) { q.y = floor; q.vy *= -0.55; } d(c, q, t); }; return p; }), dur: 3300 };
    case 'blocks': {
      const size = Math.max(28, W / 12);
      const cols = Math.floor(W / size);
      const heights = new Array(cols).fill(0);
      return { ps: Array.from({ length: cols * 3 }, (_, i) => { const col = i % cols; const p = base({ x: col * size + size / 2, y: -size - Math.floor(i / cols) * H * 0.35 - rnd(0, H * 0.3), vy: 0, g: 0.6, size, life: 3400, color: pick(['#f7931a', '#a855f7', '#7c3aed', '#fb923c']), draw: (c, q) => {
        const stackTop = H - heights[col] * size - size / 2;
        if (q.y >= stackTop && q.vy > 0 && !(q as P & { landed?: boolean }).landed) { q.y = stackTop; q.vy = 0; q.g = 0; (q as P & { landed?: boolean }).landed = true; heights[col]++; }
        c.fillStyle = q.color; c.fillRect(-size / 2 + 1, -size / 2 + 1, size - 2, size - 2);
        c.fillStyle = 'rgba(0,0,0,0.3)'; c.font = `bold ${size * 0.5}px system-ui`; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText('₿', 0, 1);
      } }); return p; }), dur: 3500 };
    }
    case 'bubbles':
      return { ps: Array.from({ length: 34 }, () => base({ x: rnd(0, W), y: H + rnd(0, H * 0.4), vy: -rnd(1.5, 4), size: rnd(10, 34), life: rnd(2200, 3600), sway: rnd(0.5, 1.5), phase: rnd(0, 6), draw: (c, p) => {
        const g = c.createRadialGradient(-p.size * 0.35, -p.size * 0.35, 1, 0, 0, p.size);
        g.addColorStop(0, 'rgba(255,255,255,0.75)'); g.addColorStop(0.3, 'rgba(196,181,253,0.18)'); g.addColorStop(1, 'rgba(168,85,247,0.35)');
        c.fillStyle = g; c.strokeStyle = 'rgba(255,255,255,0.45)'; c.lineWidth = 1;
        c.beginPath(); c.arc(0, 0, p.size, 0, Math.PI * 2); c.fill(); c.stroke();
      } })), dur: 3600 };
    case 'snow':
      return { ps: Array.from({ length: 120 }, () => base({ x: rnd(0, W), y: rnd(-H, 0), vy: rnd(1, 3), size: rnd(1.5, 4.5), life: 3800, sway: rnd(0.3, 1.2), phase: rnd(0, 6), color: '#ffffff', draw: dotDraw })), dur: 3800 };
    case 'supernova':
      return { ps: [base({ x: W / 2, y: H * 0.45, size: Math.hypot(W, H) * 0.7, life: 1900, draw: (c, p) => {
        const k = p.age / p.life;
        for (let i = 0; i < 28; i++) {
          const a = (i / 28) * Math.PI * 2 + k * 0.6;
          c.strokeStyle = i % 2 ? `rgba(247,147,26,${1 - k})` : `rgba(253,230,138,${1 - k})`;
          c.lineWidth = 3 * (1 - k) + 0.5;
          c.beginPath(); c.moveTo(Math.cos(a) * p.size * k * 0.15, Math.sin(a) * p.size * k * 0.15); c.lineTo(Math.cos(a) * p.size * k, Math.sin(a) * p.size * k); c.stroke();
        }
        const g = c.createRadialGradient(0, 0, 0, 0, 0, 90 * (1 - k) + 10);
        g.addColorStop(0, 'rgba(255,255,255,0.95)'); g.addColorStop(1, 'rgba(247,147,26,0)');
        c.fillStyle = g; c.beginPath(); c.arc(0, 0, 100, 0, Math.PI * 2); c.fill();
      } })], dur: 2000 };
    case 'paper-planes':
      return { ps: Array.from({ length: 9 }, (_, i) => { const p = base({ x: -60 - i * 50, y: rnd(H * 0.15, H * 0.8), vx: rnd(5, 8), vy: rnd(-1.2, 0.4), size: rnd(26, 42), life: 3000, sway: rnd(0.6, 1.4), phase: rnd(0, 6), draw: (c, q) => {
        c.rotate(Math.atan2(q.vy, q.vx)); const s = q.size;
        c.fillStyle = '#f5f5f5'; c.beginPath(); c.moveTo(s * 0.6, 0); c.lineTo(-s * 0.5, -s * 0.35); c.lineTo(-s * 0.2, 0); c.lineTo(-s * 0.5, s * 0.35); c.closePath(); c.fill();
        c.fillStyle = '#c4b5fd'; c.beginPath(); c.moveTo(s * 0.6, 0); c.lineTo(-s * 0.2, 0); c.lineTo(-s * 0.35, s * 0.18); c.closePath(); c.fill();
      } }); p.age = -i * 120; return p; }), dur: 3400 };
    case 'disco':
      return { ps: [base({ x: W / 2, y: H * 0.22, size: Math.min(W, H) * 0.12, life: 2600, draw: (c, p, t) => {
        for (let i = 0; i < 10; i++) {
          const a = t / 400 + (i / 10) * Math.PI * 2;
          c.save(); c.rotate(a); c.fillStyle = `hsla(${(i * 36 + t / 8) % 360},90%,60%,0.16)`;
          c.beginPath(); c.moveTo(0, 0); c.lineTo(Math.hypot(W, H), -60); c.lineTo(Math.hypot(W, H), 60); c.closePath(); c.fill(); c.restore();
        }
        c.rotate(t / 600); emojiDraw('🪩')(c, p, t);
      } })], dur: 2700 };
    case 'ripples':
      return { ps: Array.from({ length: 10 }, (_, i) => { const r = base({ x: rnd(W * 0.1, W * 0.9), y: rnd(H * 0.15, H * 0.85), size: rnd(80, 180), life: 1400, color: pick(['#93c5fd', '#c4b5fd', '#a5f3fc']), draw: ringDraw }); r.age = -i * 200; return r; }), dur: 3400 };
    case 'pizza':
      return { ps: Array.from({ length: 40 }, () => base({ x: rnd(0, W), y: rnd(-H * 0.8, -40), vy: rnd(3, 6), size: rnd(30, 52), spin: rnd(-4, 4), rot: rnd(0, 360), g: 0.1, drag: 0.995, life: 3400, draw: emojiDraw('🍕') })), dur: 3400 };
    case 'to-the-moon': {
      const moon = base({ x: W * 0.78, y: H + 60, vy: -H / 140, size: Math.min(W, H) * 0.22, life: 3000, drag: 0.985, draw: emojiDraw('🌕') });
      const rockets = Array.from({ length: 5 }, (_, i) => { const r = base({ x: rnd(W * 0.05, W * 0.45), y: H + 40, vx: rnd(2.5, 4.5), vy: -rnd(H / 90, H / 70), size: rnd(30, 44), life: 2200, draw: (c, p) => { c.rotate(Math.atan2(p.vy, p.vx) + Math.PI / 4); emojiDraw('🚀')(c, p, 0); } }); r.age = -i * 260; return r; });
      return { ps: [moon, ...rockets], dur: 3300 };
    }
    default:
      return { ps: [], dur: 0 };
  }
}

let running: { stop: () => void } | null = null;

/** Play the user's chosen celebration, or a specific one (for previews). */
export async function celebrate(effect?: EffectId, prefsOverride?: Partial<CelebrationPrefs>): Promise<void> {
  if (typeof document === 'undefined') return;
  const prefs = { ...loadPrefs(), ...prefsOverride };
  let id: string = effect ?? prefs.effect;
  if (id === 'none') return;
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  if (reduce) id = 'sparkles'; // gentle, no flashing or big motion

  running?.stop();

  let sprite: HTMLImageElement | undefined;
  if (isCustomEffect(id)) {
    const asset = await customAsset(id.startsWith('custom:') ? id.slice(7) : undefined);
    if (!asset) id = 'confetti';
    else if (asset.file.kind === 'video') { playVideo(asset.url); return; }
    else { sprite = asset.img; id = `custom-${prefsOverride?.customMode ?? asset.file.mode}`; }
  }
  await run(id, prefs, sprite);
}

async function run(id: string, prefs: CelebrationPrefs, sprite?: HTMLImageElement): Promise<void> {
  running?.stop();
  const canvas = document.createElement('canvas');
  canvas.setAttribute('aria-hidden', 'true');
  canvas.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:99999';
  document.body.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  if (!ctx) { canvas.remove(); return; }
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const W = window.innerWidth, H = window.innerHeight;
  canvas.width = W * dpr; canvas.height = H * dpr;
  ctx.scale(dpr, dpr);

  const { ps, dur, flash, bolts } = build(id, W, H, prefs, sprite);
  const boltPaths = bolts ? Array.from({ length: 3 }, () => zigzag(rnd(W * 0.15, W * 0.85), H)) : [];
  const start = performance.now();
  let last = start;
  let raf = 0;
  const stop = () => { cancelAnimationFrame(raf); canvas.remove(); if (running?.stop === stop) running = null; };
  running = { stop };

  const frame = (now: number) => {
    const dt = Math.min(48, now - last) / 16.7; // in 60 fps steps, so slow phones keep pace
    last = now;
    const t = now - start;
    ctx.clearRect(0, 0, W, H);

    if (flash) {
      const a = t < 90 ? 0.55 : t < 260 ? 0.15 : t < 340 ? 0.4 : Math.max(0, 0.4 - (t - 340) / 900);
      ctx.fillStyle = `rgba(233,213,255,${a})`;
      ctx.fillRect(0, 0, W, H);
      ctx.save();
      ctx.strokeStyle = '#fff';
      ctx.shadowColor = '#c084fc';
      ctx.shadowBlur = 28;
      ctx.lineWidth = 3.5;
      ctx.globalAlpha = Math.max(0, 1 - t / 1100) * (t % 140 < 100 ? 1 : 0.4);
      for (const path of boltPaths) { ctx.beginPath(); path.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.stroke(); }
      ctx.restore();
      const z = base({ x: W / 2, y: H * 0.42, size: Math.min(W, H) * 0.32, life: 1300, draw: emojiDraw('⚡') });
      ctx.save(); ctx.globalAlpha = Math.max(0, 1 - t / 1200); ctx.translate(z.x, z.y); ctx.scale(1 + t / 2500, 1 + t / 2500); z.draw(ctx, z, t); ctx.restore();
    }

    for (let i = ps.length - 1; i >= 0; i--) {
      const p = ps[i];
      p.age += 16.7 * dt;
      if (p.age < 0) continue;
      if (p.age > p.life) {
        ps.splice(i, 1);
        if (p.onDie) ps.push(...p.onDie(p));
        continue;
      }
      p.vy += p.g * dt;
      p.vx *= Math.pow(p.drag, dt);
      p.vy *= Math.pow(p.drag, dt);
      p.x += (p.vx + (p.sway ? Math.sin(t / 300 + (p.phase ?? 0)) * p.sway : 0)) * dt;
      p.y += p.vy * dt;
      p.rot += p.spin * dt;
      const k = p.age / p.life;
      ctx.save();
      ctx.globalAlpha = k > 0.75 ? Math.max(0, (1 - k) / 0.25) : 1;
      ctx.translate(p.x, p.y);
      if (p.rot) ctx.rotate((p.rot * Math.PI) / 180);
      p.draw(ctx, p, t);
      ctx.restore();
      if (id === 'rocket' && p.size >= 40) { // the rocket itself leaves the smoke
        ps.push(base({ x: p.x - p.vx * 2, y: p.y - p.vy * 2, vx: rnd(-1, 1), vy: rnd(-1, 1), size: rnd(4, 10), life: 700, g: -0.02, color: pick(['rgba(255,255,255,0.7)', 'rgba(247,147,26,0.8)', 'rgba(168,85,247,0.6)']), draw: dotDraw }));
      }
    }

    if (t < dur || ps.length) raf = requestAnimationFrame(frame);
    else stop();
  };
  raf = requestAnimationFrame(frame);
}

function zigzag(x: number, H: number): [number, number][] {
  const pts: [number, number][] = [[x, -10]];
  let y = -10;
  while (y < H * rnd(0.55, 0.85)) { y += rnd(30, 70); x += rnd(-45, 45); pts.push([x, y]); }
  return pts;
}

function playVideo(url: string) {
  running?.stop();
  const v = document.createElement('video');
  v.src = url;
  v.muted = true;
  v.playsInline = true;
  v.autoplay = true;
  v.setAttribute('aria-hidden', 'true');
  v.style.cssText = 'position:fixed;left:50%;top:45%;transform:translate(-50%,-50%);max-width:92vw;max-height:70vh;pointer-events:none;z-index:99999;transition:opacity .35s';
  const stop = () => { v.style.opacity = '0'; setTimeout(() => v.remove(), 380); if (running?.stop === stop) running = null; };
  running = { stop };
  v.onended = stop;
  v.onerror = stop;
  setTimeout(stop, (CUSTOM_LIMITS.videoSeconds + 1) * 1000);
  document.body.appendChild(v);
  v.play().catch(stop);
}
