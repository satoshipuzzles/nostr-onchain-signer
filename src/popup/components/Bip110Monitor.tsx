/**
 * BIP-110 fork monitor for the block explorer.
 *
 * Pre-flag-day: shows the deployment timeline, miner signaling over recent
 * blocks, and per-block validity from the perspective of enforcing nodes
 * (during the mandatory window, non-signaling blocks are rejected by them).
 *
 * Dual chain tips: the main (Core) tip comes from the default Esplora
 * providers; the BIP-110 enforcing chain tip comes from a user-configurable
 * Esplora endpoint (e.g. one backed by a Knots node). Before divergence both
 * tips are identical.
 */
import { useState, useEffect, useCallback } from 'react';
import { GitFork, Loader2, RefreshCw, ChevronDown, ChevronUp, Check, X, Settings2 } from 'lucide-react';
import { fetchMempoolApi } from '@/lib/bitcoin/mempool';
import {
  bip110Status,
  blockSignalsBip110,
  BIP110_MANDATORY_SIGNAL_START,
  BIP110_LOCK_IN_HEIGHT,
  BIP110_ACTIVATION_HEIGHT,
} from '@/lib/bitcoin/bip110';

interface VersionedBlock {
  id: string;
  height: number;
  timestamp: number;
  version: number;
}

const ENDPOINT_KEY = 'bip110_esplora_url';

async function loadEnforcingEndpoint(): Promise<string> {
  try {
    const result = await chrome.storage.local.get(ENDPOINT_KEY);
    return (result[ENDPOINT_KEY] as string) || '';
  } catch {
    return '';
  }
}

export function Bip110Monitor() {
  const [blocks, setBlocks] = useState<VersionedBlock[]>([]);
  const [tipHeight, setTipHeight] = useState(0);
  const [tipHash, setTipHash] = useState('');
  const [enforcingUrl, setEnforcingUrl] = useState('');
  const [enforcingTip, setEnforcingTip] = useState<{ height: number; hash: string } | null>(null);
  const [enforcingError, setEnforcingError] = useState('');
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const [showConfig, setShowConfig] = useState(false);
  const [urlInput, setUrlInput] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [tipRes, hashRes, page1Res] = await Promise.all([
        fetchMempoolApi('/blocks/tip/height'),
        fetchMempoolApi('/blocks/tip/hash'),
        fetchMempoolApi('/v1/blocks'),
      ]);
      const tip = tipRes.ok ? parseInt(await tipRes.text(), 10) : 0;
      if (tip) setTipHeight(tip);
      if (hashRes.ok) setTipHash((await hashRes.text()).trim());

      let all: VersionedBlock[] = [];
      if (page1Res.ok) {
        all = (await page1Res.json()) as VersionedBlock[];
        // one more page for a better signaling sample (~30 blocks)
        const lastHeight = all[all.length - 1]?.height;
        if (lastHeight) {
          try {
            const page2 = await fetchMempoolApi(`/v1/blocks/${lastHeight - 1}`);
            if (page2.ok) all = all.concat((await page2.json()) as VersionedBlock[]);
          } catch { /* one page is enough */ }
        }
        setBlocks(all);
      }
    } catch { /* leave whatever we have */ }

    // Enforcing-chain tip from the configured endpoint, if any
    const url = await loadEnforcingEndpoint();
    setEnforcingUrl(url);
    setUrlInput(url);
    if (url) {
      try {
        const base = url.replace(/\/+$/, '');
        const [hRes, hashRes2] = await Promise.all([
          fetch(`${base}/blocks/tip/height`),
          fetch(`${base}/blocks/tip/hash`),
        ]);
        if (!hRes.ok) throw new Error(`HTTP ${hRes.status}`);
        setEnforcingTip({
          height: parseInt(await hRes.text(), 10),
          hash: hashRes2.ok ? (await hashRes2.text()).trim() : '',
        });
        setEnforcingError('');
      } catch (err) {
        setEnforcingTip(null);
        setEnforcingError(err instanceof Error ? err.message : 'unreachable');
      }
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 120_000);
    return () => clearInterval(t);
  }, [load]);

  async function saveEndpoint() {
    const clean = urlInput.trim();
    await chrome.storage.local.set({ [ENDPOINT_KEY]: clean });
    setEnforcingUrl(clean);
    setShowConfig(false);
    load();
  }

  if (loading && blocks.length === 0) {
    return (
      <div className="card flex items-center gap-2 text-xs text-gray-500">
        <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading BIP-110 fork monitor...
      </div>
    );
  }
  if (!tipHeight) return null;

  const status = bip110Status(tipHeight);
  const signaling = blocks.filter((b) => blockSignalsBip110(b.version)).length;
  const signalPct = blocks.length > 0 ? (signaling / blocks.length) * 100 : 0;

  const phaseLabel: Record<string, { text: string; cls: string }> = {
    signaling: { text: 'Signaling period', cls: 'bg-blue-500/15 text-blue-400 border-blue-500/30' },
    mandatory: { text: 'MANDATORY SIGNALING — fork risk live', cls: 'bg-red-500/15 text-red-400 border-red-500/30' },
    locked_in: { text: 'Locked in — activation pending', cls: 'bg-amber-500/15 text-amber-400 border-amber-500/30' },
    active: { text: 'ACTIVE on enforcing chain', cls: 'bg-red-500/15 text-red-400 border-red-500/30' },
    expired: { text: 'Expired', cls: 'bg-gray-500/15 text-gray-400 border-gray-500/30' },
  };
  const phase = phaseLabel[status.phase];

  const diverged = enforcingTip
    && (enforcingTip.height !== tipHeight || (enforcingTip.hash && tipHash && enforcingTip.hash !== tipHash));

  const milestones = [
    { label: 'Mandatory signaling', height: BIP110_MANDATORY_SIGNAL_START },
    { label: 'Lock-in', height: BIP110_LOCK_IN_HEIGHT },
    { label: 'Activation', height: BIP110_ACTIVATION_HEIGHT },
  ];

  return (
    <div className="card">
      <button onClick={() => setExpanded(!expanded)} className="w-full flex items-center gap-2 text-left">
        <GitFork className="w-4 h-4 text-nostr flex-shrink-0" />
        <span className="text-sm font-semibold text-white">BIP-110 Fork Monitor</span>
        <span className={`px-2 py-0.5 rounded-full text-[9px] font-bold border ${phase.cls}`}>
          {phase.text}
        </span>
        <span className="ml-auto flex items-center gap-1">
          <RefreshCw
            onClick={(e) => { e.stopPropagation(); load(); }}
            className={`w-3.5 h-3.5 text-gray-500 hover:text-white ${loading ? 'animate-spin' : ''}`}
          />
          {expanded ? <ChevronUp className="w-4 h-4 text-gray-500" /> : <ChevronDown className="w-4 h-4 text-gray-500" />}
        </span>
      </button>

      {/* Always-visible summary row */}
      <div className="grid grid-cols-3 gap-2 mt-3">
        <div className="rounded-lg bg-surface-700/50 p-2">
          <p className="text-[9px] text-gray-500 uppercase tracking-wide">Signaling (last {blocks.length})</p>
          <p className={`text-sm font-bold ${signalPct >= 55 ? 'text-red-400' : 'text-white'}`}>
            {signalPct.toFixed(1)}%
          </p>
        </div>
        <div className="rounded-lg bg-surface-700/50 p-2">
          <p className="text-[9px] text-gray-500 uppercase tracking-wide">Main chain tip</p>
          <p className="text-sm font-bold text-white font-mono">{tipHeight.toLocaleString()}</p>
        </div>
        <div className="rounded-lg bg-surface-700/50 p-2">
          <p className="text-[9px] text-gray-500 uppercase tracking-wide">BIP-110 chain tip</p>
          {enforcingTip ? (
            <p className={`text-sm font-bold font-mono ${diverged ? 'text-red-400' : 'text-green-400'}`}>
              {enforcingTip.height.toLocaleString()}
            </p>
          ) : (
            <p className="text-[10px] text-gray-500 leading-tight mt-0.5">
              {enforcingUrl ? (enforcingError ? `error: ${enforcingError}` : '...') : 'same (pre-fork)'}
            </p>
          )}
        </div>
      </div>

      {diverged && (
        <div className="mt-2 rounded-lg bg-red-500/10 border border-red-500/20 p-2 text-[11px] text-red-400">
          Chains have diverged — main tip {tipHeight.toLocaleString()} vs enforcing tip{' '}
          {enforcingTip!.height.toLocaleString()} ({Math.abs(tipHeight - enforcingTip!.height)} block
          difference). Transactions without a chain-specific output (e.g. a large OP_RETURN) may
          confirm on BOTH chains.
        </div>
      )}

      {expanded && (
        <div className="mt-3 space-y-3">
          {/* Timeline */}
          <div>
            <p className="text-[10px] text-gray-500 uppercase tracking-wide mb-1.5">Timeline</p>
            <div className="space-y-1">
              {milestones.map((m) => {
                const passed = tipHeight >= m.height;
                const blocksAway = m.height - tipHeight;
                const eta = new Date(Date.now() + blocksAway * 10 * 60 * 1000);
                return (
                  <div key={m.label} className="flex items-center justify-between text-[11px]">
                    <span className={passed ? 'text-green-400' : 'text-gray-300'}>
                      {passed ? '✓ ' : ''}{m.label}
                    </span>
                    <span className="text-gray-500 font-mono">
                      {m.height.toLocaleString()}
                      {!passed && ` · ~${blocksAway.toLocaleString()} blocks · ${eta.toLocaleDateString()}`}
                    </span>
                  </div>
                );
              })}
            </div>
            <p className="text-[10px] text-gray-500 mt-1.5 leading-relaxed">{status.nextMilestone}</p>
          </div>

          {/* Per-block validity for enforcing nodes */}
          <div>
            <p className="text-[10px] text-gray-500 uppercase tracking-wide mb-1.5">
              Recent blocks — validity for BIP-110 nodes {status.phase === 'mandatory' ? '(mandatory window: non-signaling = rejected)' : '(during the mandatory window)'}
            </p>
            <div className="flex flex-wrap gap-1">
              {blocks.slice(0, 30).map((b) => {
                const signals = blockSignalsBip110(b.version);
                return (
                  <span
                    key={b.id}
                    title={`Block ${b.height}: ${signals ? 'signals bit 4 — valid to enforcing nodes' : 'does NOT signal — rejected by enforcing nodes during the mandatory window'}`}
                    className={`flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[9px] font-mono border ${
                      signals
                        ? 'bg-green-500/10 text-green-400 border-green-500/20'
                        : 'bg-red-500/10 text-red-400 border-red-500/20'
                    }`}
                  >
                    {signals ? <Check className="w-2.5 h-2.5" /> : <X className="w-2.5 h-2.5" />}
                    {b.height}
                  </span>
                );
              })}
            </div>
          </div>

          {/* Enforcing-chain endpoint config */}
          <div>
            <button
              onClick={() => setShowConfig(!showConfig)}
              className="flex items-center gap-1.5 text-[10px] text-gray-500 hover:text-gray-300"
            >
              <Settings2 className="w-3 h-3" />
              {enforcingUrl ? 'Enforcing-chain endpoint configured' : 'Configure BIP-110 chain endpoint'}
            </button>
            {showConfig && (
              <div className="mt-2 flex gap-2">
                <input
                  value={urlInput}
                  onChange={(e) => setUrlInput(e.target.value)}
                  placeholder="https://esplora.of-a-knots-node.example/api"
                  className="input-field text-xs font-mono flex-1"
                />
                <button onClick={saveEndpoint} className="btn-secondary text-xs px-3">Save</button>
              </div>
            )}
            <p className="text-[10px] text-gray-600 mt-1 leading-relaxed">
              Point this at an Esplora API served by a BIP-110-enforcing (Knots) node to track the
              enforcing chain tip after divergence. Until the chains split, both tips are identical.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
