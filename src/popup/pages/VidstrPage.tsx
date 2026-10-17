import { useEffect, useCallback, useState } from 'react';
import { nip19 } from 'nostr-tools';
import { ExternalLink, User, StopCircle } from 'lucide-react';
import { useEmbedPlayer } from '../context/EmbedPlayerContext';
import { useProfilePopup } from '../context/ProfilePopupContext';
import { VIDSTR } from '../apps';

const VIDSTR_PUBKEY = (() => {
  try { return nip19.decode(VIDSTR.npub!).data as string; } catch { return ''; }
})();

/** Vidstr's own tab: the studio, embedded, plus its Nostr account. */
export default function VidstrPage() {
  const { embeds, open, close, registerDock } = useEmbedPlayer();
  const { openProfile } = useProfilePopup();
  const [logoFailed, setLogoFailed] = useState(false);

  useEffect(() => { open(VIDSTR); }, []);

  const dockRef = useCallback((el: HTMLDivElement | null) => {
    registerDock(el);
  }, [registerDock]);
  useEffect(() => () => registerDock(null), [registerDock]);

  const running = embeds.some((e) => e.id === VIDSTR.id);

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center gap-3 px-4 py-3 border-b border-white/10 flex-shrink-0">
        {!logoFailed ? (
          <img src={VIDSTR.logo} alt="" onError={() => setLogoFailed(true)} className="w-11 h-11 rounded-xl object-cover bg-surface-700 flex-shrink-0" />
        ) : (
          <div className="w-11 h-11 rounded-xl bg-purple-600/30 flex-shrink-0" />
        )}
        <div className="min-w-0 flex-1">
          <p className="text-sm font-bold truncate">{VIDSTR.name}</p>
          <p className="text-[11px] text-gray-400 truncate">{VIDSTR.description}</p>
          <p className="text-[10px] text-purple-300/80 truncate">{VIDSTR.nip05}</p>
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          {VIDSTR_PUBKEY && (
            <button
              onClick={() => openProfile(VIDSTR_PUBKEY)}
              className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] text-gray-300 hover:bg-white/5 hover:text-white"
              title="Vidstr's Nostr profile"
            >
              <User className="w-3.5 h-3.5" /> Profile
            </button>
          )}
          {running && (
            <button
              onClick={() => close(VIDSTR.id)}
              className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] text-gray-400 hover:bg-red-500/10 hover:text-red-400"
              title="Stop and close"
            >
              <StopCircle className="w-3.5 h-3.5" />
            </button>
          )}
          <a
            href={VIDSTR.url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] text-gray-400 hover:bg-white/5 hover:text-white"
          >
            <ExternalLink className="w-3.5 h-3.5" /> Open studio
          </a>
        </div>
      </div>
      {!running && (
        <div className="flex-1 flex items-center justify-center bg-black">
          <button onClick={() => open(VIDSTR)} className="px-4 py-2 rounded-xl bg-purple-600/30 text-purple-200 text-sm">Open the Vidstr studio</button>
        </div>
      )}
      <div ref={dockRef} className={`${running ? 'flex-1' : 'h-0'} relative min-h-[500px] bg-black`} />
    </div>
  );
}
