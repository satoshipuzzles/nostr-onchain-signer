import { useMemo, useState } from 'react';
import { Play, ExternalLink, Music, Film, Link2, MessageSquare } from 'lucide-react';
import { extractEmbeds, type Embed } from '@/lib/nostr/embeds';
import { safeHttpUrl } from '@/lib/utils';
import { useFeedFilters } from '@/lib/nostr/feed-filters';

/** Stops a tap on an embed from also opening the note's thread. */
const stop = (e: React.SyntheticEvent) => e.stopPropagation();

function YouTube({ e }: { e: Extract<Embed, { type: 'youtube' }> }) {
  const [on, setOn] = useState(false);
  const src = `https://www.youtube-nocookie.com/embed/${e.id}?autoplay=1&playsinline=1${e.start ? `&start=${e.start}` : ''}`;
  const box = e.short ? 'aspect-[9/16] max-h-[520px] mx-auto' : 'aspect-video';
  return (
    <div className={`relative w-full ${box} rounded-xl overflow-hidden bg-black border border-white/10`} onClick={stop} data-embed="youtube">
      {on ? (
        <iframe src={src} title="YouTube video" className="absolute inset-0 w-full h-full" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowFullScreen referrerPolicy="strict-origin-when-cross-origin" />
      ) : (
        <button type="button" onClick={() => setOn(true)} className="absolute inset-0 w-full h-full group" aria-label="Play YouTube video">
          <img src={`https://i.ytimg.com/vi/${e.id}/hqdefault.jpg`} alt="" loading="lazy" className="w-full h-full object-cover opacity-90 group-hover:opacity-100" />
          <span className="absolute inset-0 flex items-center justify-center">
            <span className="w-14 h-10 rounded-xl bg-red-600 flex items-center justify-center shadow-lg"><Play className="w-6 h-6 text-white fill-white" /></span>
          </span>
          <span className="absolute bottom-1.5 left-2 text-[10px] text-white/80 bg-black/50 rounded px-1.5 py-0.5">YouTube{e.start ? ` · from ${Math.floor(e.start / 60)}:${String(e.start % 60).padStart(2, '0')}` : ''}</span>
        </button>
      )}
    </div>
  );
}

function Frame({ e }: { e: Extract<Embed, { type: 'iframe' }> }) {
  const [on, setOn] = useState(false);
  const video = e.height === 0;
  if (!on) {
    return (
      <button type="button" onClick={(ev) => { stop(ev); setOn(true); }} data-embed={e.provider.toLowerCase().replace(/\s+/g, '-')}
        className="w-full flex items-center gap-3 rounded-xl border border-white/10 bg-white/[0.04] hover:bg-white/[0.07] px-3 py-3 text-left">
        <span className="w-10 h-10 rounded-lg bg-purple-600/20 flex items-center justify-center flex-shrink-0">
          {e.media === 'audio' ? <Music className="w-5 h-5 text-purple-300" /> : <Film className="w-5 h-5 text-purple-300" />}
        </span>
        <span className="flex-1 min-w-0">
          <span className="block text-[13px] font-semibold text-white">{e.provider}</span>
          <span className="block text-[11px] text-gray-500 truncate">{e.url.replace(/^https?:\/\/(www\.)?/, '')}</span>
        </span>
        <span className="w-8 h-8 rounded-full bg-white/10 flex items-center justify-center"><Play className="w-4 h-4 text-white fill-white" /></span>
      </button>
    );
  }
  return (
    <div className={`relative w-full rounded-xl overflow-hidden border border-white/10 bg-black ${video ? 'aspect-video' : ''}`} style={video ? undefined : { height: e.height }} onClick={stop}>
      <iframe src={e.src} title={e.provider} loading="lazy" className="absolute inset-0 w-full h-full" allow="encrypted-media; picture-in-picture; fullscreen; clipboard-write" allowFullScreen referrerPolicy="strict-origin-when-cross-origin" />
    </div>
  );
}

function favicon(domain: string) {
  return `https://${domain}/favicon.ico`;
}

function LinkCard({ e }: { e: Extract<Embed, { type: 'link' }> }) {
  const href = safeHttpUrl(e.url);
  const [icon, setIcon] = useState(true);
  if (!href) return null;
  let path = '';
  try { const u = new URL(e.url); path = decodeURIComponent(u.pathname + u.search).replace(/\/$/, ''); } catch { /* keep empty */ }
  const Icon = e.media === 'audio' ? Music : e.media === 'video' ? Film : e.media === 'post' ? MessageSquare : Link2;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" onClick={stop} data-embed="link"
      className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/[0.03] hover:bg-white/[0.06] px-3 py-2.5 no-underline">
      <span className="w-8 h-8 rounded-lg bg-white/5 flex items-center justify-center flex-shrink-0 overflow-hidden">
        {icon ? <img src={favicon(e.domain)} alt="" loading="lazy" className="w-5 h-5" onError={() => setIcon(false)} /> : <Icon className="w-4 h-4 text-gray-400" />}
      </span>
      <span className="flex-1 min-w-0">
        <span className="block text-[13px] font-medium text-white truncate">{e.provider || e.domain}</span>
        <span className="block text-[11px] text-gray-500 truncate">{e.provider ? e.domain : ''}{path && path !== '/' ? `${e.provider ? ' · ' : ''}${path}` : ''}</span>
      </span>
      <ExternalLink className="w-3.5 h-3.5 text-gray-500 flex-shrink-0" />
    </a>
  );
}

/** Embeds for the links in a note. Respects the "media inline" filter preference. */
export function MediaEmbeds({ content, max = 3 }: { content: string; max?: number }) {
  const { prefs } = useFeedFilters();
  const embeds = useMemo(() => extractEmbeds(content, max), [content, max]);
  if (!embeds.length) return null;
  return (
    <div className="mt-2 space-y-2" data-testid="embeds">
      {embeds.map((e, i) => {
        const key = `${e.type}-${i}`;
        // with media off, everything becomes a plain link card
        if (!prefs.mediaInline && e.type !== 'link') {
          const url = e.url;
          let domain = ''; try { domain = new URL(url).hostname.replace(/^www\./, ''); } catch { /* bad url */ }
          return <LinkCard key={key} e={{ type: 'link', url, domain, media: e.type === 'audio' ? 'audio' : 'video' }} />;
        }
        switch (e.type) {
          case 'youtube': return <YouTube key={key} e={e} />;
          case 'iframe': return <Frame key={key} e={e} />;
          case 'audio': return <audio key={key} src={safeHttpUrl(e.url) || undefined} controls preload="none" className="w-full" onClick={stop} data-embed="audio" />;
          case 'video': return <video key={key} src={safeHttpUrl(e.url) || undefined} controls preload="metadata" playsInline className="w-full max-h-[480px] rounded-xl bg-black" onClick={stop} data-embed="video" />;
          case 'link': return <LinkCard key={key} e={e} />;
        }
      })}
    </div>
  );
}
