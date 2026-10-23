import { useState } from 'react';
import { Radio, Gamepad2, Clapperboard, UtensilsCrossed } from 'lucide-react';
import type { EmbedApp } from '../context/EmbedPlayerContext';

const KIND_ICON = { audio: Radio, game: Gamepad2, video: Clapperboard, food: UtensilsCrossed } as const;

/** A card for one embedded Nostr app: logo, name, one line, its Nostr address. */
export function AppCard({ app, active, running, onOpen }: { app: EmbedApp; active: boolean; running: boolean; onOpen: () => void }) {
  const [logoFailed, setLogoFailed] = useState(false);
  const Icon = KIND_ICON[app.kind];
  return (
    <button
      onClick={onOpen}
      className={`flex items-center gap-2.5 min-w-[190px] max-w-[240px] px-3 py-2 rounded-xl border text-left transition-colors ${
        active ? 'bg-white/10 border-purple-500/40' : 'bg-white/[0.03] border-white/10 hover:bg-white/[0.07]'
      }`}
    >
      {app.logo && !logoFailed ? (
        <img src={app.logo} alt="" onError={() => setLogoFailed(true)} className="w-9 h-9 rounded-lg object-cover flex-shrink-0 bg-surface-700" />
      ) : (
        <span className="w-9 h-9 rounded-lg bg-purple-600/20 flex items-center justify-center flex-shrink-0">
          <Icon className="w-4 h-4 text-purple-300" />
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="text-xs font-semibold text-white truncate">{app.name}</span>
          {running && <span className="w-1.5 h-1.5 rounded-full bg-green-400 flex-shrink-0" title="Running" />}
        </span>
        <span className="block text-[10px] text-gray-400 truncate">{app.description}</span>
        {app.nip05 && <span className="block text-[9px] text-purple-300/70 truncate">{app.nip05}</span>}
      </span>
    </button>
  );
}
