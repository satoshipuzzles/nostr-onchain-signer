import { useState } from 'react';
import { Radio, Gamepad2, ExternalLink, Loader2 } from 'lucide-react';

interface App {
  id: string;
  name: string;
  url: string;
  description: string;
}

const AUDIO_APPS: App[] = [
  {
    id: 'cornychat',
    name: 'Corny Chat',
    url: 'https://cornychat.com',
    description: 'Nostr audio spaces — live voice rooms',
  },
];

const GAME_APPS: App[] = [
  {
    id: 'puzzl35',
    name: 'Puzzl35',
    url: 'https://puzzl35.com/',
    description: 'Turn anything into puzzles — Nostr-powered jigsaw puzzles with zaps',
  },
  {
    id: 'word5',
    name: 'WORD5',
    url: 'https://otherstuff.ai/word5/',
    description: 'Daily 5-letter word game with Nostr login and streaks',
  },
];

type Tab = 'audio' | 'games';

export default function OtherStuff() {
  const [tab, setTab] = useState<Tab>('audio');
  const apps = tab === 'audio' ? AUDIO_APPS : GAME_APPS;
  const [activeApp, setActiveApp] = useState<App>(AUDIO_APPS[0]);
  const [iframeLoading, setIframeLoading] = useState(true);

  function switchTab(next: Tab) {
    setTab(next);
    const first = next === 'audio' ? AUDIO_APPS[0] : GAME_APPS[0];
    setActiveApp(first);
    setIframeLoading(true);
  }

  function openApp(app: App) {
    setActiveApp(app);
    setIframeLoading(true);
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
              onClick={() => openApp(app)}
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
          <p className="text-[10px] text-gray-500 truncate">{activeApp.description}</p>
        </div>
        <a
          href={activeApp.url}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] text-gray-400 hover:bg-white/5 hover:text-white transition-colors flex-shrink-0"
        >
          <ExternalLink className="w-3.5 h-3.5" /> Open in new tab
        </a>
      </div>

      {/* Iframe */}
      <div className="flex-1 relative min-h-[500px]">
        {iframeLoading && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/50 z-10 pointer-events-none">
            <Loader2 className="w-6 h-6 animate-spin text-purple-400" />
          </div>
        )}
        <iframe
          key={activeApp.id}
          src={activeApp.url}
          title={activeApp.name}
          onLoad={() => setIframeLoading(false)}
          className="absolute inset-0 w-full h-full border-0"
          allow="microphone; camera; autoplay; clipboard-write; web-share"
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals"
        />
      </div>
    </div>
  );
}
