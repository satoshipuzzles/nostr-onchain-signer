import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, RefreshCw, Pickaxe } from 'lucide-react';
import {
  esplora,
  scanBlock,
  loadAllAnchors,
  getScannedHeights,
  type AnchorRecord,
  type ScanProgress,
} from '../lib/scanner';
import { parsePubkeyInput } from '../lib/nostr';
import { AnchorCard } from '../components/AnchorCard';

const AUTO_SCAN_BLOCKS = 2;

export function Feed() {
  const navigate = useNavigate();
  const [anchors, setAnchors] = useState<AnchorRecord[]>([]);
  const [tipHeight, setTipHeight] = useState<number | null>(null);
  const [scanned, setScanned] = useState<Set<number>>(new Set());
  const [progress, setProgress] = useState<ScanProgress | null>(null);
  const [scanning, setScanning] = useState(false);
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [visibleCount, setVisibleCount] = useState(30);
  const scanningRef = useRef(false);

  async function refreshFromCache() {
    setAnchors(await loadAllAnchors());
    setScanned(await getScannedHeights());
  }

  async function scanHeights(heights: number[]) {
    if (scanningRef.current) return;
    scanningRef.current = true;
    setScanning(true);
    setError('');
    try {
      for (const height of heights) {
        await scanBlock(height, setProgress);
        await refreshFromCache();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Scan failed — provider rate limit? Try again shortly.');
    } finally {
      scanningRef.current = false;
      setScanning(false);
      setProgress(null);
    }
  }

  useEffect(() => {
    (async () => {
      await refreshFromCache();
      try {
        const tip = await esplora.getTipHeight();
        setTipHeight(tip);
        const done = await getScannedHeights();
        const todo: number[] = [];
        for (let h = tip; h > tip - AUTO_SCAN_BLOCKS; h--) {
          if (!done.has(h)) todo.push(h);
        }
        if (todo.length > 0) scanHeights(todo);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Cannot reach Esplora providers');
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function nextUnscanned(count: number): number[] {
    if (tipHeight === null) return [];
    const out: number[] = [];
    for (let h = tipHeight; h > 0 && out.length < count; h--) {
      if (!scanned.has(h)) out.push(h);
    }
    return out;
  }

  function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    const q = query.trim();
    if (!q) return;
    if (/^[0-9a-f]{64}$/i.test(q)) {
      // ambiguous: could be a txid or a hex pubkey — txids are what people paste here
      navigate(`/tx/${q.toLowerCase()}`);
      return;
    }
    const pubkey = parsePubkeyInput(q);
    if (pubkey) {
      navigate(`/p/${q}`);
      return;
    }
    setError('Paste a txid, npub, or nprofile');
  }

  const oldestScanned = scanned.size > 0 ? Math.min(...scanned) : null;

  return (
    <div className="space-y-5">
      <section className="text-center space-y-2 py-2">
        <h1 className="text-3xl font-extrabold tracking-tight">
          The Nostr <span className="text-bitcoin">Block</span> Chain
        </h1>
        <p className="text-zinc-400 text-sm max-w-md mx-auto">
          Nostr events carved into Bitcoin OP_RETURNs — fetched from relays, verified against the chain, and social.
          Login to comment, react, follow, and zap.
        </p>
      </section>

      <form onSubmit={handleSearch} className="flex gap-2">
        <input
          className="input flex-1"
          placeholder="Search txid, npub, or nprofile…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button type="submit" className="btn-bitcoin px-3" aria-label="Search">
          <Search size={16} />
        </button>
      </form>

      {/* Scan status */}
      <div className="card p-3 flex items-center gap-3 text-xs text-zinc-400">
        <Pickaxe size={16} className={`shrink-0 ${scanning ? 'text-bitcoin animate-pulse' : 'text-zinc-600'}`} />
        <div className="flex-1 min-w-0">
          {progress ? (
            <>
              Scanning block {progress.height.toLocaleString()} — {progress.txsScanned}/{progress.txCount} txs,{' '}
              {progress.anchorsFound} anchors
              <div className="h-1 bg-ink-overlay rounded-full mt-1.5 overflow-hidden">
                <div
                  className="h-full bg-bitcoin transition-all"
                  style={{ width: `${(progress.txsScanned / Math.max(progress.txCount, 1)) * 100}%` }}
                />
              </div>
            </>
          ) : (
            <>
              {scanned.size.toLocaleString()} block{scanned.size === 1 ? '' : 's'} indexed
              {oldestScanned && tipHeight ? ` (${oldestScanned.toLocaleString()} → ${tipHeight.toLocaleString()})` : ''} ·{' '}
              {anchors.length.toLocaleString()} anchors found · scans run in your browser and stay cached
            </>
          )}
        </div>
        <button className="btn-ghost text-xs shrink-0" onClick={() => scanHeights(nextUnscanned(3))} disabled={scanning || tipHeight === null}>
          <RefreshCw size={13} className={scanning ? 'animate-spin' : ''} />
          Scan {scanning ? '…' : '3 more'}
        </button>
      </div>

      {error && <p className="text-red-400 text-sm">{error}</p>}

      {/* Feed */}
      <div className="space-y-3">
        {anchors.slice(0, visibleCount).map((a) => (
          <AnchorCard key={a.id} anchor={a} />
        ))}
        {anchors.length === 0 && !scanning && (
          <div className="card p-8 text-center text-zinc-500 text-sm">
            Nothing indexed yet. Scanning recent blocks… OP_RETURN anchors are rare gems — scan more blocks or paste a
            txid you know.
          </div>
        )}
      </div>

      {anchors.length > visibleCount && (
        <button className="btn-ghost w-full" onClick={() => setVisibleCount((c) => c + 30)}>
          Show more
        </button>
      )}
    </div>
  );
}
