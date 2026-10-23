import { useState, useEffect, useCallback, useContext } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Radio, Gamepad2, Clapperboard, UtensilsCrossed, ExternalLink, StopCircle, ListFilter } from 'lucide-react';
import { useEmbedPlayer, type EmbedApp } from '../context/EmbedPlayerContext';
import { AuthContext } from '../context/AuthContext';
import { AUDIO_APPS, GAME_APPS, FOOD_APPS, VIDEO_APPS, ALL_APPS } from '../apps';
import { AppCard } from '../components/AppCard';
import { CustomFeedView } from '../components/CustomFeedView';
import { NoteThread } from '../components/NoteThread';
import { FOOD_DEF } from '@/lib/nostr/feed-store';
import type { FeedNote } from '@/lib/nostr/feed';

type Tab = 'audio' | 'games' | 'food' | 'video';

const TAB_KIND: Record<Tab, EmbedApp['kind']> = { audio: 'audio', games: 'game', food: 'food', video: 'video' };
const TAB_APPS: Record<Tab, EmbedApp[]> = { audio: AUDIO_APPS, games: GAME_APPS, food: FOOD_APPS, video: VIDEO_APPS };

function tabFor(kind?: EmbedApp['kind']): Tab {
  return kind === 'game' ? 'games' : kind === 'video' ? 'video' : kind === 'food' ? 'food' : 'audio';
}

export default function OtherStuff() {
  const { embeds, activeId, open, focus, close, registerDock } = useEmbedPlayer();
  const auth = useContext(AuthContext);
  const [params] = useSearchParams();
  const active = ALL_APPS.find((a) => a.id === activeId) ?? null;
  const asked = params.get('tab') as Tab | null;
  const [tab, setTab] = useState<Tab>(asked && asked in TAB_APPS ? asked : tabFor(active?.kind));
  // the Food tab can show the Food feed (native) instead of an embedded app
  const [foodFeed, setFoodFeed] = useState(false);
  const [thread, setThread] = useState<FeedNote | null>(null);
  const apps = TAB_APPS[tab];
  const shownApp = active && active.kind === TAB_KIND[tab]
    ? active
    : apps.find((a) => embeds.some((e) => e.id === a.id)) ?? apps[0];

  // Auto-start the default app of the tab on first visit
  useEffect(() => {
    if (embeds.length === 0) open(TAB_APPS[tab][0]);
    else if (asked && asked in TAB_APPS) switchTab(asked);
  }, []);

  const dockRef = useCallback((el: HTMLDivElement | null) => {
    registerDock(el);
  }, [registerDock]);

  // React calls the ref with null on unmount, which unregisters the dock

  function switchTab(next: Tab) {
    setTab(next);
    setFoodFeed(false);
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
      className={`flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-sm font-medium whitespace-nowrap flex-shrink-0 transition-colors ${
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
        {tabBtn('food', UtensilsCrossed, 'Food')}
        {tabBtn('video', Clapperboard, 'Video')}
      </div>

      {/* App cards for this tab */}
      <div className="flex items-stretch gap-2 px-4 py-2 border-b border-white/10 flex-shrink-0 overflow-x-auto">
        {apps.map((app) => (
          <AppCard
            key={app.id}
            app={app}
            active={activeId === app.id && !foodFeed}
            running={isOpen(app.id)}
            onOpen={() => { setFoodFeed(false); open(app); }}
          />
        ))}
        {tab === 'food' && (
          <button
            onClick={() => setFoodFeed(true)}
            className={`flex items-center gap-2.5 px-3 py-2 rounded-xl border text-left min-w-[200px] transition-colors ${foodFeed ? 'border-purple-400/50 bg-purple-500/15' : 'border-white/10 bg-white/[0.03] hover:bg-white/[0.06]'}`}
            data-testid="food-feed-card"
          >
            <span className="w-9 h-9 rounded-xl bg-purple-500/15 border border-purple-400/20 flex items-center justify-center flex-shrink-0"><ListFilter className="w-4 h-4 text-purple-300" /></span>
            <span className="min-w-0">
              <span className="block text-sm font-semibold text-white">Food feed</span>
              <span className="block text-[11px] text-gray-400 truncate">Recipes + #foodstr, right here</span>
            </span>
          </button>
        )}
      </div>

      {tab === 'food' && foodFeed && (
        <div className="flex-1 min-h-0 overflow-y-auto" data-testid="food-feed">
          <CustomFeedView def={FOOD_DEF} publicKey={auth?.publicKey || ''} followingPubkeys={auth?.following ?? new Set()} onSelectNote={setThread} />
          {thread && <NoteThread note={thread} profiles={new Map()} onClose={() => setThread(null)} />}
        </div>
      )}

      {/* Active app header */}
      {shownApp && !(tab === 'food' && foodFeed) && (
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
      {!(tab === 'food' && foodFeed) && <div ref={dockRef} className="flex-1 relative min-h-[500px] bg-black" />}
    </div>
  );
}
