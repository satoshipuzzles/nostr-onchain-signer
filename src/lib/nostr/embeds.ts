/**
 * Turning links in a note into embeds: video and music services, direct audio and
 * video files, posts on X, and a plain link card for everything else. Images are
 * handled separately (NoteCard renders them inline already).
 */
import { IMAGE_URL_RE } from './content';

export type Embed =
  | { type: 'youtube'; id: string; start?: number; short?: boolean; url: string }
  | { type: 'iframe'; provider: string; src: string; height: number; url: string; media: 'audio' | 'video' }
  | { type: 'audio'; url: string }
  | { type: 'video'; url: string }
  | { type: 'link'; url: string; domain: string; provider?: string; media?: 'audio' | 'video' | 'post' };

const URL_RE = /https?:\/\/[^\s<>"'`)\]]+[^\s<>"'`)\].,;:!?]/gi;
const AUDIO_RE = /\.(mp3|m4a|aac|ogg|oga|wav|flac|opus)(\?.*)?$/i;
const VIDEO_RE = /\.(mp4|webm|mov|m4v|ogv)(\?.*)?$/i;

function seconds(t: string | null): number | undefined {
  if (!t) return undefined;
  if (/^\d+$/.test(t)) return +t;
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(t);
  if (!m) return undefined;
  return (+(m[1] || 0)) * 3600 + (+(m[2] || 0)) * 60 + (+(m[3] || 0)) || undefined;
}

/** What one https link becomes. Null for images (rendered elsewhere) and non-http links. */
export function embedFor(raw: string): Embed | null {
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (IMAGE_URL_RE.test(raw)) { IMAGE_URL_RE.lastIndex = 0; return null; }
  IMAGE_URL_RE.lastIndex = 0;
  const host = u.hostname.replace(/^(www\.|m\.|music\.)/, '');
  const path = u.pathname;
  const url = u.toString();

  // YouTube: watch?v=, youtu.be/, /shorts/, /live/, /embed/
  if (host === 'youtube.com' || host === 'youtube-nocookie.com' || host === 'youtu.be') {
    let id = '';
    if (host === 'youtu.be') id = path.slice(1).split('/')[0];
    else if (path === '/watch') id = u.searchParams.get('v') || '';
    else { const m = /^\/(shorts|live|embed|v)\/([\w-]{6,})/.exec(path); if (m) id = m[2]; }
    if (/^[\w-]{6,20}$/.test(id)) return { type: 'youtube', id, start: seconds(u.searchParams.get('t') || u.searchParams.get('start')), short: path.startsWith('/shorts/'), url };
  }
  if (u.hostname === 'music.youtube.com') {
    const id = u.searchParams.get('v') || '';
    if (/^[\w-]{6,20}$/.test(id)) return { type: 'youtube', id, url };
  }

  // Spotify
  if (host === 'open.spotify.com') {
    const m = /^\/(?:intl-[a-z-]+\/)?(track|album|playlist|episode|show|artist)\/([A-Za-z0-9]{10,})/.exec(path);
    if (m) return { type: 'iframe', provider: 'Spotify', media: 'audio', url, src: `https://open.spotify.com/embed/${m[1]}/${m[2]}`, height: m[1] === 'track' || m[1] === 'episode' ? 152 : 352 };
  }
  // SoundCloud
  if (host === 'soundcloud.com' && path.split('/').filter(Boolean).length >= 2) {
    return { type: 'iframe', provider: 'SoundCloud', media: 'audio', url, height: 166, src: `https://w.soundcloud.com/player/?url=${encodeURIComponent(url)}&auto_play=false&visual=false&show_comments=false` };
  }
  // Apple Music (music.apple.com/...)
  if (u.hostname === 'music.apple.com' && /\/(album|playlist|song|station)\//.test(path)) {
    return { type: 'iframe', provider: 'Apple Music', media: 'audio', url, height: /\/song\/|[?&]i=/.test(url) ? 175 : 450, src: `https://embed.music.apple.com${path}${u.search}` };
  }
  // Wavlake
  if (host === 'wavlake.com') {
    const m = /^\/(track|album|artist|playlist)\/([\w-]+)/.exec(path);
    if (m && m[1] !== 'artist') return { type: 'iframe', provider: 'Wavlake', media: 'audio', url, height: m[1] === 'track' ? 380 : 450, src: `https://embed.wavlake.com/${m[1]}/${m[2]}` };
    return { type: 'link', url, domain: 'wavlake.com', provider: 'Wavlake', media: 'audio' };
  }
  // Tidal
  if (host === 'tidal.com' || host === 'listen.tidal.com') {
    const m = /\/(track|album|playlist|video)\/([\w-]+)/.exec(path);
    if (m) return { type: 'iframe', provider: 'TIDAL', media: m[1] === 'video' ? 'video' : 'audio', url, height: m[1] === 'track' ? 120 : m[1] === 'video' ? 230 : 400, src: `https://embed.tidal.com/${m[1]}s/${m[2]}` };
  }
  // Fountain: no public embed player, so a rich card
  if (host === 'fountain.fm') return { type: 'link', url, domain: 'fountain.fm', provider: 'Fountain', media: 'audio' };
  // Vimeo
  if (host === 'vimeo.com' || host === 'player.vimeo.com') {
    const m = /\/(?:video\/)?(\d{6,})/.exec(path);
    if (m) return { type: 'iframe', provider: 'Vimeo', media: 'video', url, height: 0, src: `https://player.vimeo.com/video/${m[1]}?dnt=1` };
  }
  // Rumble: only /embed/ links carry the embed id
  if (host === 'rumble.com') {
    const m = /^\/embed\/([\w]+)/.exec(path);
    if (m) return { type: 'iframe', provider: 'Rumble', media: 'video', url, height: 0, src: `https://rumble.com/embed/${m[1]}/` };
    return { type: 'link', url, domain: 'rumble.com', provider: 'Rumble', media: 'video' };
  }
  // Twitch: the player needs this site's hostname as `parent`
  if (host === 'twitch.tv' || host === 'clips.twitch.tv') {
    const parent = typeof location !== 'undefined' ? location.hostname : 'nostronchain.com';
    const clip = host === 'clips.twitch.tv' ? path.slice(1) : (/\/clip\/([\w-]+)/.exec(path)?.[1] || '');
    if (clip) return { type: 'iframe', provider: 'Twitch', media: 'video', url, height: 0, src: `https://clips.twitch.tv/embed?clip=${clip}&parent=${parent}&autoplay=false` };
    const v = /^\/videos\/(\d+)/.exec(path)?.[1];
    if (v) return { type: 'iframe', provider: 'Twitch', media: 'video', url, height: 0, src: `https://player.twitch.tv/?video=${v}&parent=${parent}&autoplay=false` };
    const ch = /^\/([\w]{3,25})\/?$/.exec(path)?.[1];
    if (ch) return { type: 'iframe', provider: 'Twitch', media: 'video', url, height: 0, src: `https://player.twitch.tv/?channel=${ch}&parent=${parent}&autoplay=false` };
  }
  // X / Twitter: the official embed needs their script, so a card
  if (host === 'x.com' || host === 'twitter.com' || host === 'mobile.twitter.com') {
    if (/\/status\/\d+/.test(path)) return { type: 'link', url, domain: 'x.com', provider: 'Post on X', media: 'post' };
  }
  // direct media files
  if (AUDIO_RE.test(path)) return { type: 'audio', url };
  if (VIDEO_RE.test(path)) return { type: 'video', url };

  return { type: 'link', url, domain: u.hostname.replace(/^www\./, '') };
}

/** Every embeddable link in a note's text, deduplicated, in order. */
export function extractEmbeds(content: string, max = 4): Embed[] {
  const out: Embed[] = [];
  const seen = new Set<string>();
  for (const raw of content.match(URL_RE) || []) {
    if (seen.has(raw)) continue;
    seen.add(raw);
    const e = embedFor(raw);
    if (e) out.push(e);
    if (out.length >= max) break;
  }
  return out;
}

export type MediaKind = 'image' | 'video' | 'audio' | 'link';

/** Which media a note carries: from links, imeta tags and the event kind. */
export function mediaKinds(note: { content: string; tags?: string[][]; kind?: number }): Set<MediaKind> {
  const s = new Set<MediaKind>();
  if (note.kind === 20) s.add('image');
  if (note.kind === 21 || note.kind === 22 || note.kind === 34235 || note.kind === 34236) s.add('video');
  if (note.kind === 1222) s.add('audio');
  IMAGE_URL_RE.lastIndex = 0;
  if (IMAGE_URL_RE.test(note.content)) s.add('image');
  IMAGE_URL_RE.lastIndex = 0;
  for (const t of note.tags || []) {
    if (t[0] !== 'imeta') continue;
    const m = t.find((x) => x.startsWith('m '))?.slice(2) || '';
    if (m.startsWith('image/')) s.add('image');
    else if (m.startsWith('video/')) s.add('video');
    else if (m.startsWith('audio/')) s.add('audio');
  }
  for (const e of extractEmbeds(note.content, 12)) {
    if (e.type === 'youtube' || e.type === 'video') s.add('video');
    else if (e.type === 'audio') s.add('audio');
    else if (e.type === 'iframe') s.add(e.media);
    else if (e.type === 'link') { if (e.media === 'audio') s.add('audio'); else if (e.media === 'video') s.add('video'); else s.add('link'); }
  }
  return s;
}
