import {
  createContext, useContext, useState, useRef, useCallback,
  useLayoutEffect, type ReactNode,
} from 'react';
import { useNavigate } from 'react-router-dom';
import { Radio, Gamepad2, X, Maximize2, Loader2 } from 'lucide-react';
import { useIframeNostrBridge } from '@/lib/nostr/iframe-bridge';

export interface EmbedApp {
  id: string;
  name: string;
  url: string;
  description: string;
  kind: 'audio' | 'game';
}

interface EmbedPlayerContextType {
  /** All currently open embeds (audio room + game can run at the same time). */
  embeds: EmbedApp[];
  /** The embed currently shown in the dock. */
  activeId: string | null;
  /** Open an app (keeps others running) and focus it. */
  open: (app: EmbedApp) => void;
  /** Focus an already-open embed without closing others. */
  focus: (id: string) => void;
  /** Close one embed. Others keep running. */
  close: (id: string) => void;
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
 * Keeps every open embed's iframe mounted OUTSIDE the routed pages, so audio
 * rooms and games keep running while the user navigates — and an audio room
 * can keep playing while a game is in the foreground.
 *
 * - The active embed is position-synced over the Audio & Games page's dock.
 * - Background embeds shrink to 1px (audio keeps playing).
 * - Away from the page, a floating mini-player lists every open embed.
 */
export function EmbedPlayerProvider({ children }: { children: ReactNode }) {
  const [embeds, setEmbeds] = useState<EmbedApp[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [dockEl, setDockEl] = useState<HTMLElement | null>(null);
  const [rect, setRect] = useState<{ top: number; left: number; width: number; height: number } | null>(null);
  const [loadedIds, setLoadedIds] = useState<Set<string>>(new Set());
  const navigate = useNavigate();
  const iframeRefs = useRef<Map<string, HTMLIFrameElement>>(new Map());

  // Answer NIP-07 postMessage requests from any open embed
  useIframeNostrBridge(iframeRefs);

  const open = useCallback((app: EmbedApp) => {
    setEmbeds((prev) => (prev.some((e) => e.id === app.id) ? prev : [...prev, app]));
    setActiveId(app.id);
  }, []);

  const focus = useCallback((id: string) => {
    setActiveId(id);
  }, []);

  const close = useCallback((id: string) => {
    iframeRefs.current.delete(id);
    setEmbeds((prev) => {
      const next = prev.filter((e) => e.id !== id);
      setActiveId((cur) => (cur === id ? (next[next.length - 1]?.id ?? null) : cur));
      return next;
    });
    setLoadedIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
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
    <EmbedPlayerContext.Provider value={{ embeds, activeId, open, focus, close, registerDock }}>
      {children}

      {/* Persistent iframes — one per open embed, none unmount on navigation */}
      {embeds.map((app) => {
        const isActive = app.id === activeId;
        const showFull = docked && isActive;
        return (
          <div
            key={app.id}
            className="fixed z-40"
            style={
              showFull
                ? { top: rect!.top, left: rect!.left, width: rect!.width, height: rect!.height }
                : { bottom: 0, right: 0, width: 1, height: 1, opacity: 0, pointerEvents: 'none' }
            }
          >
            {showFull && !loadedIds.has(app.id) && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/50 z-10 pointer-events-none">
                <Loader2 className="w-6 h-6 animate-spin text-purple-400" />
              </div>
            )}
            <iframe
              ref={(el) => {
                if (el) iframeRefs.current.set(app.id, el);
                else iframeRefs.current.delete(app.id);
              }}
              src={app.url}
              title={app.name}
              onLoad={() => setLoadedIds((prev) => new Set(prev).add(app.id))}
              className="w-full h-full border-0 bg-black"
              allow="microphone; camera; autoplay; clipboard-write; web-share"
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals"
            />
          </div>
        );
      })}

      {/* Floating mini-player when away from the Audio & Games page */}
      {!docked && embeds.length > 0 && (
        <div className="fixed bottom-20 md:bottom-4 right-3 md:right-4 z-40 flex flex-col gap-1.5 items-end">
          {embeds.map((app) => (
            <div
              key={app.id}
              className="flex items-center gap-2 pl-3 pr-1.5 py-1.5 rounded-2xl bg-surface-800/95 backdrop-blur border border-purple-500/30 shadow-lg shadow-black/50"
            >
              <span className="relative flex h-2 w-2 flex-shrink-0">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-purple-400 opacity-60" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-purple-400" />
              </span>
              {app.kind === 'audio'
                ? <Radio className="w-3.5 h-3.5 text-purple-300 flex-shrink-0" />
                : <Gamepad2 className="w-3.5 h-3.5 text-purple-300 flex-shrink-0" />}
              <span className="text-xs font-medium text-white max-w-[120px] truncate">{app.name}</span>
              <button
                onClick={() => { focus(app.id); navigate('/other'); }}
                className="p-1.5 rounded-lg hover:bg-white/10 text-gray-300"
                title="Back to full view"
              >
                <Maximize2 className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={() => close(app.id)}
                className="p-1.5 rounded-lg hover:bg-red-500/20 text-gray-400 hover:text-red-400"
                title="Stop"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
    </EmbedPlayerContext.Provider>
  );
}
