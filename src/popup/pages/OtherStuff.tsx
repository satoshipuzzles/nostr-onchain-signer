import { useState, useEffect, useCallback } from 'react';
import { Radio, Gamepad2, ExternalLink, StopCircle } from 'lucide-react';
import { useEmbedPlayer, type EmbedApp } from '../context/EmbedPlayerContext';

const AUDIO_APPS: EmbedApp[] = [
  {
    id: 'cornychat',
    name: 'Corny Chat',
    url: 'https://cornychat.com',
    description: 'Nostr audio spaces — live voice rooms',
    kind: 'audio',
  },
];

const GAME_APPS: EmbedApp[] = [
  {
    id: 'puzzl35',
    name: 'Puzzl35',
    url: 'https://puzzl35.com/',
    description: 'Turn anything into puzzles — Nostr-powered jigsaw puzzles with zaps',
    kind: 'game',
  },
  {
    id: 'word5',
    name: 'WORD5',
    url: 'https://otherstuff.ai/word5/',
    description: 'Daily 5-letter word game with Nostr login and streaks',
    kind: 'game',
  },
];

const ALL_APPS = [...AUDIO_APPS, ...GAME_APPS];

type Tab = 'audio' | 'games';

export default function OtherStuff() {
  const { embeds, activeId, open, focus, close, registerDock } = useEmbedPlayer();
  const active = ALL_APPS.find((a) => a.id === activeId) ?? null;
  const [tab, setTab] = useState<Tab>(active?.kind === 'game' ? 'games' : 'audio');
  const apps = tab === 'audio' ? AUDIO_APPS : GAME_APPS;
  const shownApp = active && active.kind === (tab === 'audio' ? 'audio' : 'game')
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
    const kind = next === 'audio' ? 'audio' : 'game';
    // Focus an already-open embed of that kind (keeps the other one running),
    // otherwise open the first app of the tab
    const openOfKind = embeds.find((e) => e.kind === kind);
    if (openOfKind) focus(openOfKind.id);
    else open(next === 'audio' ? AUDIO_APPS[0] : GAME_APPS[0]);
  }

  const isOpen = (id: string) => embeds.some((e) => e.id === id);

  return (
    <div className="h-full flex flex-col">
      {/* Tab bar */}
      <div className="flex items-center gap-1 px-4 pt-3 pb-2 border-b border-white/10 flex-shrink-0">
        <button
          onClick={() => switchTab('audio')}
          className={`flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-sm font-medium transition-colors ${
            tab === 'audio' ? 'bg-purple-600/20 text-purple-300' : 'text-gray-400 hover:bg-white/5'
          }`}
        >
          <Radio className="w-4 h-4" /> Nostr Audio
          {embeds.some((e) => e.kind === 'audio') && (
            <span className="w-1.5 h-1.5 rounded-full bg-green-400" title="Running" />
          )}
        </button>
        <button
          onClick={() => switchTab('games')}
          className={`flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-sm font-medium transition-colors ${
            tab === 'games' ? 'bg-purple-600/20 text-purple-300' : 'text-gray-400 hover:bg-white/5'
          }`}
        >
          <Gamepad2 className="w-4 h-4" /> Games
          {embeds.some((e) => e.kind === 'game') && (
            <span className="w-1.5 h-1.5 rounded-full bg-green-400" title="Running" />
          )}
        </button>
      </div>

      {/* App selector (when multiple apps in tab) */}
      {apps.length > 1 && (
        <div className="flex items-center gap-2 px-4 py-2 border-b border-white/10 flex-shrink-0 overflow-x-auto">
          {apps.map((app) => (
            <button
              key={app.id}
              onClick={() => open(app)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-colors ${
                activeId === app.id
                  ? 'bg-white/10 text-white'
                  : 'text-gray-400 hover:bg-white/5'
              }`}
            >
              {app.name}
              {isOpen(app.id) && <span className="w-1.5 h-1.5 rounded-full bg-green-400" />}
            </button>
          ))}
        </div>
      )}

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
