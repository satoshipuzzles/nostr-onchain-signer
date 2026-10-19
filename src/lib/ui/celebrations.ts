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
  | 'custom' | 'none';

export type CustomMode = 'rain' | 'burst' | 'pop';

export interface CelebrationPrefs {
  effect: EffectId;
  /** Emoji used by the emoji effects */
  emoji: string;
  /** How a custom image is used; videos always play over the screen */
  customMode: CustomMode;
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

const KEY = 'celebration_prefs_v1';
const DEFAULTS: CelebrationPrefs = { effect: 'confetti', emoji: '🤙', customMode: 'rain' };
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
  imageBytes: 1_000_000,
  videoBytes: 4_000_000,
  videoSeconds: 6,
  imageTypes: ['image/png', 'image/gif', 'image/webp', 'image/svg+xml', 'image/apng', 'image/jpeg'],
  videoTypes: ['video/webm', 'video/mp4'],
};

export interface CustomFile { kind: 'image' | 'video'; type: string; name: string; data: Blob }

function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open('celebrations', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('files');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export async function loadCustom(): Promise<CustomFile | null> {
  try {
    const d = await db();
    return await new Promise((resolve) => {
      const q = d.transaction('files').objectStore('files').get('custom');
      q.onsuccess = () => resolve((q.result as CustomFile) || null);
      q.onerror = () => resolve(null);
    });
  } catch { return null; }
}

/** Checks the file against the limits; returns an error message, or null once saved. */
export async function saveCustom(file: File): Promise<string | null> {
  const isImage = CUSTOM_LIMITS.imageTypes.includes(file.type);
  const isVideo = CUSTOM_LIMITS.videoTypes.includes(file.type);
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
  const rec: CustomFile = { kind: isImage ? 'image' : 'video', type: file.type, name: file.name, data: file };
  try {
    const d = await db();
    await new Promise<void>((resolve, reject) => {
      const tx = d.transaction('files', 'readwrite');
      tx.objectStore('files').put(rec, 'custom');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch { return 'This browser would not store the file (private mode or storage full).'; }
  customCache = null;
  return null;
}

export async function removeCustom(): Promise<void> {
  try {
    const d = await db();
    d.transaction('files', 'readwrite').objectStore('files').delete('custom');
  } catch { /* nothing stored */ }
  customCache = null;
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

let customCache: { file: CustomFile; url: string; img?: HTMLImageElement } | null = null;
async function customAsset() {
  if (customCache) return customCache;
  const file = await loadCustom();
  if (!file) return null;
  const url = URL.createObjectURL(file.data);
  let img: HTMLImageElement | undefined;
  if (file.kind === 'image') {
    img = new Image();
    img.src = url;
    await img.decode().catch(() => {});
  }
  customCache = { file, url, img };
  return customCache;
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
  if (id === 'custom') {
    const asset = await customAsset();
    if (!asset) id = 'confetti';
    else if (asset.file.kind === 'video') { playVideo(asset.url); return; }
    else { sprite = asset.img; id = `custom-${prefs.customMode}`; }
  }

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
