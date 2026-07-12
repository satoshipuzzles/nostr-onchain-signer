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

type Tab = 'audio' | 'games';

export default function OtherStuff() {
  const { current, play, stop, registerDock } = useEmbedPlayer();
  const [tab, setTab] = useState<Tab>(current?.kind === 'game' ? 'games' : 'audio');
  const apps = tab === 'audio' ? AUDIO_APPS : GAME_APPS;
  const activeApp = current ?? AUDIO_APPS[0];

  // Auto-start the default audio app on first visit (same behavior as before,
  // but the iframe now lives in the persistent player and survives navigation)
  useEffect(() => {
    if (!current) play(AUDIO_APPS[0]);
  }, []);

  // Unregister the dock when leaving the page — the player shrinks to a
  // mini-player and the audio keeps going
  const dockRef = useCallback((el: HTMLDivElement | null) => {
    registerDock(el);
  }, [registerDock]);

  useEffect(() => () => registerDock(null), [registerDock]);

  function switchTab(next: Tab) {
    setTab(next);
    const first = next === 'audio' ? AUDIO_APPS[0] : GAME_APPS[0];
    if (current?.kind !== first.kind) play(first);
  }

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
        </button>
        <button
          onClick={() => switchTab('games')}
          className={`flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-sm font-medium transition-colors ${
            tab === 'games' ? 'bg-purple-600/20 text-purple-300' : 'text-gray-400 hover:bg-white/5'
          }`}
        >
          <Gamepad2 className="w-4 h-4" /> Games
        </button>
      </div>

      {/* App selector (when multiple apps in tab) */}
      {apps.length > 1 && (
        <div className="flex items-center gap-2 px-4 py-2 border-b border-white/10 flex-shrink-0 overflow-x-auto">
          {apps.map((app) => (
            <button
              key={app.id}
              onClick={() => play(app)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-colors ${
                activeApp.id === app.id
                  ? 'bg-white/10 text-white'
                  : 'text-gray-400 hover:bg-white/5'
              }`}
            >
              {app.name}
            </button>
          ))}
        </div>
      )}

      {/* Active app header */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-white/10 flex-shrink-0">
        <div className="min-w-0">
          <p className="text-sm font-semibold truncate">{activeApp.name}</p>
          <p className="text-[10px] text-gray-500 truncate">
            {activeApp.description} — keeps playing while you browse the app
          </p>
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          {current && (
            <button
              onClick={stop}
              className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] text-gray-400 hover:bg-red-500/10 hover:text-red-400 transition-colors"
              title="Stop and close"
            >
              <StopCircle className="w-3.5 h-3.5" /> Stop
            </button>
          )}
          <a
            href={activeApp.url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] text-gray-400 hover:bg-white/5 hover:text-white transition-colors"
          >
            <ExternalLink className="w-3.5 h-3.5" /> Open in new tab
          </a>
        </div>
      </div>

      {/* Dock — the persistent iframe overlays this container while on this page */}
      <div ref={dockRef} className="flex-1 relative min-h-[500px] bg-black" />
    </div>
  );
}
