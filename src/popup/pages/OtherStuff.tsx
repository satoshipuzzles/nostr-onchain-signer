import { useState, useEffect, useCallback } from 'react';
import { Radio, Gamepad2, Clapperboard, ExternalLink, StopCircle } from 'lucide-react';
import { useEmbedPlayer, type EmbedApp } from '../context/EmbedPlayerContext';
import { AUDIO_APPS, GAME_APPS, VIDEO_APPS, ALL_APPS } from '../apps';
import { AppCard } from '../components/AppCard';

type Tab = 'audio' | 'games' | 'video';

const TAB_KIND: Record<Tab, EmbedApp['kind']> = { audio: 'audio', games: 'game', video: 'video' };
const TAB_APPS: Record<Tab, EmbedApp[]> = { audio: AUDIO_APPS, games: GAME_APPS, video: VIDEO_APPS };

function tabFor(kind?: EmbedApp['kind']): Tab {
  return kind === 'game' ? 'games' : kind === 'video' ? 'video' : 'audio';
}

export default function OtherStuff() {
  const { embeds, activeId, open, focus, close, registerDock } = useEmbedPlayer();
  const active = ALL_APPS.find((a) => a.id === activeId) ?? null;
  const [tab, setTab] = useState<Tab>(tabFor(active?.kind));
  const apps = TAB_APPS[tab];
  const shownApp = active && active.kind === TAB_KIND[tab]
    ? active
    : apps.find((a) => embeds.some((e) => e.id === a.id)) ?? apps[0];

  // Auto-start the default audio app on first visit
  useEffect(() => {
    if (embeds.length === 0) open(AUDIO_APPS[0]);
  }, []);

  const dockRef = useCallback((el: HTMLDivElement | null) => {
    registerDock(el);
  }, [registerDock]);

  useEffect(() => () => registerDock(null), [registerDock]);

  function switchTab(next: Tab) {
    setTab(next);
    // Focus an already-open embed of that kind (keeps the other one running),
    // otherwise open the first app of the tab
    const openOfKind = embeds.find((e) => e.kind === TAB_KIND[next]);
    if (openOfKind) focus(openOfKind.id);
    else open(TAB_APPS[next][0]);
  }

  const isOpen = (id: string) => embeds.some((e) => e.id === id);

  const tabBtn = (t: Tab, Icon: typeof Radio, label: string) => (
    <button
      key={t}
      onClick={() => switchTab(t)}
      className={`flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-sm font-medium transition-colors ${
        tab === t ? 'bg-purple-600/20 text-purple-300' : 'text-gray-400 hover:bg-white/5'
      }`}
    >
      <Icon className="w-4 h-4" /> {label}
      {embeds.some((e) => e.kind === TAB_KIND[t]) && (
        <span className="w-1.5 h-1.5 rounded-full bg-green-400" title="Running" />
      )}
    </button>
  );

  return (
    <div className="h-full flex flex-col">
      {/* Tab bar */}
      <div className="flex items-center gap-1 px-4 pt-3 pb-2 border-b border-white/10 flex-shrink-0 overflow-x-auto">
        {tabBtn('audio', Radio, 'Nostr Audio')}
        {tabBtn('games', Gamepad2, 'Games')}
        {tabBtn('video', Clapperboard, 'Video')}
      </div>

      {/* App cards for this tab */}
      <div className="flex items-stretch gap-2 px-4 py-2 border-b border-white/10 flex-shrink-0 overflow-x-auto">
        {apps.map((app) => (
          <AppCard
            key={app.id}
            app={app}
            active={activeId === app.id}
            running={isOpen(app.id)}
            onOpen={() => open(app)}
          />
        ))}
      </div>

      {/* Active app header */}
      {shownApp && (
        <div className="flex items-center justify-between px-4 py-2 border-b border-white/10 flex-shrink-0">
          <div className="min-w-0">
            <p className="text-sm font-semibold truncate">{shownApp.name}</p>
            <p className="text-[10px] text-gray-500 truncate">
              {shownApp.description} — keeps running while you browse
            </p>
          </div>
          <div className="flex items-center gap-1 flex-shrink-0">
            {isOpen(shownApp.id) && (
              <button
                onClick={() => close(shownApp.id)}
                className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] text-gray-400 hover:bg-red-500/10 hover:text-red-400 transition-colors"
                title="Stop and close"
              >
                <StopCircle className="w-3.5 h-3.5" /> Stop
              </button>
            )}
            <a
              href={shownApp.url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] text-gray-400 hover:bg-white/5 hover:text-white transition-colors"
            >
              <ExternalLink className="w-3.5 h-3.5" /> Open in new tab
            </a>
          </div>
        </div>
      )}

      {/* Dock — the persistent active iframe overlays this container */}
      <div ref={dockRef} className="flex-1 relative min-h-[500px] bg-black" />
    </div>
  );
}
