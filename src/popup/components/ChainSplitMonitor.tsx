/**
 * Chain split monitor for the block explorer.
 *
 * Shows both chain tips side by side — BTC (SHA-256, mempool.space) and XBT
 * (BLAKE2b, mempool.guide via the proxy; overridable with your own esplora
 * endpoint) — plus the facts a user needs to reason about replay: where the
 * chains parted, when XBT's proof of work and SIGHASH_UNIFIED activated.
 */
import { useState, useEffect, useCallback } from 'react';
import { GitFork, Loader2, RefreshCw, ChevronDown, ChevronUp, Settings2, ExternalLink } from 'lucide-react';
import { fetchMempoolApi } from '@/lib/bitcoin/mempool';
import {
  CHAIN_INFO,
  SPLIT_COMMON_ANCESTOR_HEIGHT,
  SPLIT_HEIGHT,
  XBT_HARDFORK_HEIGHT,
  type Chain,
} from '@/lib/bitcoin/chain';

const ENDPOINT_KEY = 'bip110_esplora_url'; // legacy key: custom XBT esplora endpoint

interface Tip { height: number; hash: string; time?: number }

async function loadCustomXbtEndpoint(): Promise<string> {
  try {
    const result = await chrome.storage.local.get(ENDPOINT_KEY);
    return (result[ENDPOINT_KEY] as string) || '';
  } catch {
    return '';
  }
}

async function fetchTip(chain: Chain, customBase?: string): Promise<Tip> {
  if (customBase) {
    const base = customBase.replace(/\/+$/, '');
    const [h, hash] = await Promise.all([fetch(`${base}/blocks/tip/height`), fetch(`${base}/blocks/tip/hash`)]);
    if (!h.ok) throw new Error(`HTTP ${h.status}`);
    return { height: parseInt(await h.text(), 10), hash: hash.ok ? (await hash.text()).trim() : '' };
  }
  const [h, hash] = await Promise.all([fetchMempoolApi('/blocks/tip/height', 12_000, chain), fetchMempoolApi('/blocks/tip/hash', 12_000, chain)]);
  if (!h.ok) throw new Error(`HTTP ${h.status}`);
  return { height: parseInt(await h.text(), 10), hash: hash.ok ? (await hash.text()).trim() : '' };
}

export function ChainSplitMonitor({ chain }: { chain: Chain }) {
  const [tips, setTips] = useState<Record<Chain, Tip | null>>({ btc: null, xbt: null });
  const [errors, setErrors] = useState<Record<Chain, string>>({ btc: '', xbt: '' });
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const [showConfig, setShowConfig] = useState(false);
  const [customUrl, setCustomUrl] = useState('');
  const [urlInput, setUrlInput] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    const custom = await loadCustomXbtEndpoint();
    setCustomUrl(custom);
    setUrlInput(custom);
    const results = await Promise.allSettled([fetchTip('btc'), fetchTip('xbt', custom || undefined)]);
    const next: Record<Chain, Tip | null> = { btc: null, xbt: null };
    const errs: Record<Chain, string> = { btc: '', xbt: '' };
    (['btc', 'xbt'] as Chain[]).forEach((c, i) => {
      const r = results[i];
      if (r.status === 'fulfilled') next[c] = r.value;
      else errs[c] = r.reason instanceof Error ? r.reason.message : 'unreachable';
    });
    setTips(next);
    setErrors(errs);
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
    setShowConfig(false);
    load();
  }

  const btc = tips.btc;
  const xbt = tips.xbt;
  const diff = btc && xbt ? xbt.height - btc.height : null;

  return (
    <div className="card">
      <button onClick={() => setExpanded(!expanded)} className="w-full flex items-center gap-2 text-left">
        <GitFork className="w-4 h-4 text-nostr flex-shrink-0" />
        <span className="text-sm font-semibold text-white">Chain split</span>
        <span className="px-2 py-0.5 rounded-full text-[9px] font-bold border bg-red-500/15 text-red-400 border-red-500/30">
          BTC / XBT since block {SPLIT_HEIGHT.toLocaleString()}
        </span>
        <span className="ml-auto flex items-center gap-1">
          {loading && <Loader2 className="w-3.5 h-3.5 animate-spin text-gray-500" />}
          <RefreshCw
            onClick={(e) => { e.stopPropagation(); load(); }}
            className="w-3.5 h-3.5 text-gray-500 hover:text-white"
          />
          {expanded ? <ChevronUp className="w-4 h-4 text-gray-500" /> : <ChevronDown className="w-4 h-4 text-gray-500" />}
        </span>
      </button>

      <div className="grid grid-cols-2 gap-2 mt-3">
        {(['btc', 'xbt'] as Chain[]).map((c) => {
          const tip = tips[c];
          const active = c === chain;
          return (
            <div key={c} className={`rounded-lg p-2 border ${active ? 'bg-surface-700/70 border-white/10' : 'bg-surface-700/40 border-transparent'}`}>
              <p className="text-[9px] text-gray-500 uppercase tracking-wide flex items-center justify-between">
                <span className={c === 'xbt' ? 'text-purple-400' : 'text-bitcoin'}>{CHAIN_INFO[c].ticker} · {CHAIN_INFO[c].pow}</span>
                {active && <span className="text-gray-500 normal-case">viewing</span>}
              </p>
              {tip ? (
                <p className="text-sm font-bold text-white font-mono">{tip.height.toLocaleString()}</p>
              ) : (
                <p className="text-[10px] text-gray-500 mt-0.5">{errors[c] ? `error: ${errors[c]}` : '…'}</p>
              )}
              {tip?.hash && <p className="text-[9px] text-gray-600 font-mono truncate">{tip.hash.slice(0, 20)}…</p>}
            </div>
          );
        })}
      </div>

      {diff !== null && (
        <p className="mt-2 text-[10px] text-gray-500">
          XBT is {Math.abs(diff).toLocaleString()} blocks {diff >= 0 ? 'ahead of' : 'behind'} BTC — the two chains have
          separate histories since block {SPLIT_HEIGHT.toLocaleString()}. Coins from before that exist on both.
        </p>
      )}

      {expanded && (
        <div className="mt-3 space-y-3">
          <div>
            <p className="text-[10px] text-gray-500 uppercase tracking-wide mb-1.5">Timeline</p>
            <div className="space-y-1 text-[11px]">
              <div className="flex items-center justify-between">
                <span className="text-gray-300">Last shared block</span>
                <span className="text-gray-500 font-mono">{SPLIT_COMMON_ANCESTOR_HEIGHT.toLocaleString()}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-gray-300">Chains diverge (BIP-110 enforcing nodes reject a non-signaling block)</span>
                <span className="text-gray-500 font-mono">{SPLIT_HEIGHT.toLocaleString()} · 2026-08-08</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-gray-300">XBT: BLAKE2b proof of work + SIGHASH_UNIFIED active</span>
                <span className="text-gray-500 font-mono">{XBT_HARDFORK_HEIGHT.toLocaleString()} · 2026-08-30</span>
              </div>
            </div>
          </div>

          <div className="rounded-lg bg-amber-500/10 border border-amber-500/20 p-2 text-[11px] text-amber-300 leading-relaxed">
            <span className="font-semibold">Replay:</span> an ordinary signature is valid on both chains, so a spend of
            pre-split coins moves them on BTC <em>and</em> XBT. Sending on XBT with SIGHASH_UNIFIED (this wallet does it
            automatically) is valid on XBT only. To keep both sides: split on XBT first, then spend the BTC side.
          </div>

          <div className="flex gap-3 text-[10px]">
            {(['btc', 'xbt'] as Chain[]).map((c) => (
              <a key={c} href={CHAIN_INFO[c].explorerWeb} target="_blank" rel="noopener noreferrer" className="text-gray-500 hover:text-white inline-flex items-center gap-1">
                {CHAIN_INFO[c].ticker}: {CHAIN_INFO[c].explorerWeb.replace(/^https?:\/\//, '')} <ExternalLink className="w-2.5 h-2.5" />
              </a>
            ))}
          </div>

          <div>
            <button
              onClick={() => setShowConfig(!showConfig)}
              className="flex items-center gap-1.5 text-[10px] text-gray-500 hover:text-gray-300"
            >
              <Settings2 className="w-3 h-3" />
              {customUrl ? 'Custom XBT endpoint configured' : 'Use your own XBT node (esplora endpoint)'}
            </button>
            {showConfig && (
              <div className="mt-2 flex gap-2">
                <input
                  value={urlInput}
                  onChange={(e) => setUrlInput(e.target.value)}
                  placeholder="http://umbrel.local:3006/api (leave empty for mempool.guide)"
                  className="input-field text-xs font-mono flex-1"
                />
                <button onClick={saveEndpoint} className="btn-secondary text-xs px-3">Save</button>
              </div>
            )}
            <p className="text-[10px] text-gray-600 mt-1 leading-relaxed">
              Default XBT data comes from mempool.guide through this app's proxy. Point this at an Esplora API served by
              your own Knots (BLAKE2b) node to track the tip privately.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
