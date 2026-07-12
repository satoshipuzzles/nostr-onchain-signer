import {
  createContext, useContext, useState, useRef, useCallback,
  useLayoutEffect, type ReactNode,
} from 'react';
import { useNavigate } from 'react-router-dom';
import { Radio, X, Maximize2, Loader2 } from 'lucide-react';
import { useIframeNostrBridge } from '@/lib/nostr/iframe-bridge';

export interface EmbedApp {
  id: string;
  name: string;
  url: string;
  description: string;
  kind: 'audio' | 'game';
}

interface EmbedPlayerContextType {
  current: EmbedApp | null;
  /** Start (or switch to) an embedded app. The iframe persists across routes. */
  play: (app: EmbedApp) => void;
  /** Stop and unmount the embedded app. */
  stop: () => void;
  /** The page hosting the full-size view registers its container here. */
  registerDock: (el: HTMLElement | null) => void;
}

const EmbedPlayerContext = createContext<EmbedPlayerContextType | null>(null);

export function useEmbedPlayer(): EmbedPlayerContextType {
  const ctx = useContext(EmbedPlayerContext);
  if (!ctx) throw new Error('useEmbedPlayer must be used within EmbedPlayerProvider');
  return ctx;
}

/**
 * Keeps the active embed's iframe mounted OUTSIDE the routed pages so audio
 * rooms and games keep running while the user navigates the app.
 *
 * - Docked: the iframe is position-synced over the Audio & Games page's
 *   container (registered via registerDock).
 * - Undocked: the iframe stays alive at 1px (audio keeps playing) and a
 *   floating mini-player bar gives quick return/stop controls.
 */
export function EmbedPlayerProvider({ children }: { children: ReactNode }) {
  const [current, setCurrent] = useState<EmbedApp | null>(null);
  const [dockEl, setDockEl] = useState<HTMLElement | null>(null);
  const [rect, setRect] = useState<{ top: number; left: number; width: number; height: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  // Let the embedded app talk NIP-07 to us via postMessage (sign in with the
  // user's active nostr keys — "nostr clients within clients")
  useIframeNostrBridge(iframeRef);

  const play = useCallback((app: EmbedApp) => {
    setCurrent((prev) => {
      if (prev?.id === app.id) return prev;
      setLoading(true);
      return app;
    });
  }, []);

  const stop = useCallback(() => {
    setCurrent(null);
    setLoading(false);
  }, []);

  const registerDock = useCallback((el: HTMLElement | null) => {
    setDockEl(el);
  }, []);

  // Track the dock container's on-screen rect so the fixed iframe overlays it
  useLayoutEffect(() => {
    if (!dockEl) {
      setRect(null);
      return;
    }
    const sync = () => {
      const r = dockEl.getBoundingClientRect();
      setRect({ top: r.top, left: r.left, width: r.width, height: r.height });
    };
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(dockEl);
    window.addEventListener('resize', sync);
    window.addEventListener('scroll', sync, true);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', sync);
      window.removeEventListener('scroll', sync, true);
    };
  }, [dockEl]);

  const docked = !!dockEl && !!rect;

  return (
    <EmbedPlayerContext.Provider value={{ current, play, stop, registerDock }}>
      {children}

      {current && (
        <>
          {/* The persistent iframe — never unmounts while an app is active */}
          <div
            className="fixed z-40"
            style={
              docked
                ? { top: rect!.top, left: rect!.left, width: rect!.width, height: rect!.height }
                : { bottom: 0, right: 0, width: 1, height: 1, opacity: 0, pointerEvents: 'none' }
            }
          >
            {docked && loading && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/50 z-10 pointer-events-none">
                <Loader2 className="w-6 h-6 animate-spin text-purple-400" />
              </div>
            )}
            <iframe
              ref={iframeRef}
              key={current.id}
              src={current.url}
              title={current.name}
              onLoad={() => setLoading(false)}
              className="w-full h-full border-0 bg-black"
              allow="microphone; camera; autoplay; clipboard-write; web-share"
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals"
            />
          </div>

          {/* Floating mini-player when the user navigates away */}
          {!docked && (
            <div className="fixed bottom-20 md:bottom-4 right-3 md:right-4 z-40 flex items-center gap-2 pl-3 pr-1.5 py-1.5 rounded-2xl bg-surface-800/95 backdrop-blur border border-purple-500/30 shadow-lg shadow-black/50">
              <span className="relative flex h-2 w-2 flex-shrink-0">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-purple-400 opacity-60" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-purple-400" />
              </span>
              <Radio className="w-3.5 h-3.5 text-purple-300 flex-shrink-0" />
              <span className="text-xs font-medium text-white max-w-[120px] truncate">{current.name}</span>
              <button
                onClick={() => navigate('/other')}
                className="p-1.5 rounded-lg hover:bg-white/10 text-gray-300"
                title="Back to full view"
              >
                <Maximize2 className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={stop}
                className="p-1.5 rounded-lg hover:bg-red-500/20 text-gray-400 hover:text-red-400"
                title="Stop"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
        </>
      )}
    </EmbedPlayerContext.Provider>
  );
}
