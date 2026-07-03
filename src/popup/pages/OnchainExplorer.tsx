import { useState, useEffect, useCallback, useRef } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import {
  decodeNostrOpReturn,
  decodeInvoiceOpReturn,
  decodeLightOp,
} from '@/lib/bitcoin/opreturn';
import { fetchBlockchainStatus, type BlockchainStatus } from '@/lib/bitcoin/ticker';
import { fetchMempoolApi, getMempoolTxUrl, getMempoolAddressUrl } from '@/lib/bitcoin/mempool';
import {
  Search, Loader2, ExternalLink, AlertCircle,
  Copy, Check, RefreshCw, Clock, ArrowRight, ArrowLeft,
  Layers, ArrowDownRight, ArrowUpRight,
  ChevronDown, ChevronUp,
} from 'lucide-react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TxVout {
  scriptpubkey: string;
  scriptpubkey_asm: string;
  scriptpubkey_type: string;
  scriptpubkey_address?: string;
  value: number;
}

interface TxVin {
  txid: string;
  vout: number;
  prevout?: {
    scriptpubkey: string;
    scriptpubkey_type: string;
    scriptpubkey_address?: string;
    value: number;
  };
}

interface TxData {
  txid: string;
  version: number;
  locktime: number;
  size: number;
  weight: number;
  fee: number;
  status: {
    confirmed: boolean;
    block_height?: number;
    block_hash?: string;
    block_time?: number;
  };
  vin: TxVin[];
  vout: TxVout[];
}

interface BlockSummary {
  id: string;
  height: number;
  timestamp: number;
  tx_count: number;
  size: number;
  weight: number;
  extras?: {
    pool?: { name: string };
    totalFees?: number;
    avgFeeRate?: number;
  };
}

interface AddressData {
  address: string;
  chain_stats: {
    funded_txo_count: number;
    funded_txo_sum: number;
    spent_txo_count: number;
    spent_txo_sum: number;
    tx_count: number;
  };
  mempool_stats: {
    funded_txo_count: number;
    funded_txo_sum: number;
    spent_txo_count: number;
    spent_txo_sum: number;
    tx_count: number;
  };
}

interface UTXOData {
  txid: string;
  vout: number;
  value: number;
  status: {
    confirmed: boolean;
    block_height?: number;
    block_time?: number;
  };
}

interface DifficultyData {
  progressPercent: number;
  difficultyChange: number;
  estimatedRetargetDate: number;
  remainingBlocks: number;
  remainingTime: number;
  previousRetarget: number;
  nextRetargetHeight: number;
  timeAvg: number;
  timeOffset: number;
}

interface HashrateData {
  currentHashrate: number;
  currentDifficulty: number;
}

type ProtocolMatch =
  | { protocol: 'NSTR'; eventId: string; kind: number }
  | { protocol: 'NINV'; hash: string }
  | { protocol: 'LOPS'; hash: string };

type Tab = 'overview' | 'transaction' | 'address';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatSats(sats: number): string {
  if (sats >= 100_000_000) return `${(sats / 100_000_000).toFixed(8)} BTC`;
  if (sats >= 1_000_000) return `${(sats / 1_000_000).toFixed(2)}M sats`;
  if (sats >= 1_000) return `${(sats / 1_000).toFixed(1)}k sats`;
  return `${sats} sats`;
}

function formatBtc(sats: number): string {
  return (sats / 100_000_000).toFixed(8);
}

function truncateHash(hash: string, len = 8): string {
  if (hash.length <= len * 2 + 3) return hash;
  return `${hash.slice(0, len)}...${hash.slice(-len)}`;
}

function timeAgo(timestamp: number): string {
  const seconds = Math.floor(Date.now() / 1000 - timestamp);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function formatHashrate(h: number): string {
  if (h >= 1e18) return `${(h / 1e18).toFixed(1)} EH/s`;
  if (h >= 1e15) return `${(h / 1e15).toFixed(1)} PH/s`;
  if (h >= 1e12) return `${(h / 1e12).toFixed(1)} TH/s`;
  return `${h} H/s`;
}

function formatDifficulty(d: number): string {
  if (d >= 1e12) return `${(d / 1e12).toFixed(2)} T`;
  if (d >= 1e9) return `${(d / 1e9).toFixed(2)} G`;
  return d.toLocaleString();
}

function formatUsd(n: number): string {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}

function scriptTypeLabel(type: string): string {
  const map: Record<string, string> = {
    v1_p2tr: 'P2TR',
    v0_p2wpkh: 'P2WPKH',
    v0_p2wsh: 'P2WSH',
    p2sh: 'P2SH',
    p2pkh: 'P2PKH',
    op_return: 'OP_RETURN',
    multisig: 'Multisig',
  };
  return map[type] ?? type;
}

function detectProtocol(scriptHex: string): ProtocolMatch | null {
  const nstr = decodeNostrOpReturn(scriptHex);
  if (nstr) return { protocol: 'NSTR', eventId: nstr.eventId, kind: nstr.kind };
  const ninv = decodeInvoiceOpReturn(scriptHex);
  if (ninv) return { protocol: 'NINV', hash: ninv.hash };
  const lops = decodeLightOp(scriptHex);
  if (lops) return { protocol: 'LOPS', hash: lops.hash };
  return null;
}

function isOpReturn(vout: TxVout): boolean {
  return vout.scriptpubkey_type === 'op_return' || vout.scriptpubkey.startsWith('6a');
}

function useLiveTimer(timestamp: number | undefined): string {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!timestamp) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [timestamp]);
  if (!timestamp) return '—';
  const seconds = Math.max(0, Math.floor(Date.now() / 1000 - timestamp));
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

// ---------------------------------------------------------------------------
// Clipboard button
// ---------------------------------------------------------------------------

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={async () => { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
      className="p-1 hover:bg-surface-700 rounded transition-colors flex-shrink-0"
      title="Copy"
    >
      {copied ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3 text-gray-500" />}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Protocol badge
// ---------------------------------------------------------------------------

function ProtocolBadge({ match }: { match: ProtocolMatch }) {
  const colors: Record<string, string> = {
    NSTR: 'bg-purple-500/20 text-purple-300 border-purple-500/30',
    NINV: 'bg-orange-500/20 text-orange-300 border-orange-500/30',
    LOPS: 'bg-blue-500/20 text-blue-300 border-blue-500/30',
  };
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 text-[10px] font-bold rounded border ${colors[match.protocol]}`}>
      {match.protocol}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Stats bar
// ---------------------------------------------------------------------------

function StatsBar({
  status,
  difficulty,
  hashrate,
  latestBlockTime,
}: {
  status: BlockchainStatus | null;
  difficulty: DifficultyData | null;
  hashrate: HashrateData | null;
  latestBlockTime: number | undefined;
}) {
  const timeSince = useLiveTimer(latestBlockTime);
  const items = [
    { label: 'Block', value: status?.blockHeight?.toLocaleString() ?? '—' },
    { label: 'Since Last', value: timeSince },
    { label: 'Difficulty', value: hashrate ? formatDifficulty(hashrate.currentDifficulty) : '—' },
    { label: 'Avg Fee', value: status ? `${status.fees.hour} sat/vB` : '—' },
    { label: 'Hashrate', value: hashrate ? formatHashrate(hashrate.currentHashrate) : '—' },
    { label: 'BTC Price', value: status?.btcPriceUsd ? formatUsd(status.btcPriceUsd) : '—' },
  ];
  return (
    <div className="flex gap-3 overflow-x-auto px-4 py-3 bg-surface-800 border-b border-white/5 scrollbar-hide">
      {items.map((item) => (
        <div key={item.label} className="flex-shrink-0 min-w-[80px]">
          <p className="text-[10px] text-gray-500 uppercase tracking-wider">{item.label}</p>
          <p className="text-sm font-semibold text-white whitespace-nowrap font-mono">{item.value}</p>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

export function OnchainExplorer() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const initialTab = (searchParams.get('tab') as Tab) || 'overview';
  const initialTxQuery = searchParams.get('txid') || '';
  const initialAddrQuery = searchParams.get('addr') || '';

  const [activeTab, setActiveTab] = useState<Tab>(initialTab);

  // Stats
  const [status, setStatus] = useState<BlockchainStatus | null>(null);
  const [difficulty, setDifficulty] = useState<DifficultyData | null>(null);
  const [hashrate, setHashrate] = useState<HashrateData | null>(null);

  // Blocks
  const [blocks, setBlocks] = useState<BlockSummary[]>([]);
  const [blocksLoading, setBlocksLoading] = useState(true);
  const [blocksError, setBlocksError] = useState('');
  const [expandedBlock, setExpandedBlock] = useState<string | null>(null);
  const [blockTxs, setBlockTxs] = useState<Record<string, TxData[]>>({});
  const [blockTxsLoading, setBlockTxsLoading] = useState<string | null>(null);

  // Transaction lookup
  const [txQuery, setTxQuery] = useState(initialTxQuery);
  const [txResult, setTxResult] = useState<TxData | null>(null);
  const [txLoading, setTxLoading] = useState(false);
  const [txError, setTxError] = useState('');
  const [txCurrentHeight, setTxCurrentHeight] = useState(0);

  // Address lookup
  const [addrQuery, setAddrQuery] = useState(initialAddrQuery);
  const [addrData, setAddrData] = useState<AddressData | null>(null);
  const [addrTxs, setAddrTxs] = useState<TxData[]>([]);
  const [addrUtxos, setAddrUtxos] = useState<UTXOData[]>([]);
  const [addrLoading, setAddrLoading] = useState(false);
  const [addrError, setAddrError] = useState('');
  const [showUtxos, setShowUtxos] = useState(false);

  const refreshTimer = useRef<ReturnType<typeof setInterval>>();
  const loadedRef = useRef(false);

  // ---------------------------------------------------------------------------
  // Data fetching
  // ---------------------------------------------------------------------------

  const loadStats = useCallback(async () => {
    const [s, diffRes, hrRes] = await Promise.allSettled([
      fetchBlockchainStatus(),
      fetchMempoolApi('/v1/difficulty-adjustment').then((r) => r.ok ? r.json() : null),
      fetchMempoolApi('/v1/mining/hashrate/3d').then((r) => r.ok ? r.json() : null),
    ]);
    if (s.status === 'fulfilled') setStatus(s.value);
    if (diffRes.status === 'fulfilled' && diffRes.value) setDifficulty(diffRes.value);
    if (hrRes.status === 'fulfilled' && hrRes.value) setHashrate(hrRes.value);
  }, []);

  const loadBlocks = useCallback(async () => {
    setBlocksError('');
    try {
      const res = await fetchMempoolApi('/v1/blocks');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: BlockSummary[] = await res.json();
      setBlocks(data.slice(0, 10));
      loadedRef.current = true;
    } catch (err) {
      if (!loadedRef.current) {
        setBlocksError(err instanceof Error ? err.message : 'Failed to load blocks');
      }
    }
    setBlocksLoading(false);
  }, []);

  useEffect(() => {
    if (loadedRef.current && blocks.length > 0) {
      setBlocksLoading(false);
      loadStats();
      loadBlocks();
    } else {
      loadStats();
      loadBlocks();
    }

    refreshTimer.current = setInterval(() => {
      loadStats();
      loadBlocks();
    }, 60_000);
    return () => clearInterval(refreshTimer.current);
  }, [loadStats, loadBlocks]);

  // Auto-search if query params present
  useEffect(() => {
    if (initialTxQuery) { setActiveTab('transaction'); lookupTx(initialTxQuery); }
    if (initialAddrQuery) { setActiveTab('address'); lookupAddress(initialAddrQuery); }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------------------------------------------------------------------------
  // Block expand
  // ---------------------------------------------------------------------------

  async function toggleBlockExpand(blockHash: string) {
    if (expandedBlock === blockHash) {
      setExpandedBlock(null);
      return;
    }
    setExpandedBlock(blockHash);
    if (blockTxs[blockHash]) return;
    setBlockTxsLoading(blockHash);
    try {
      const res = await fetchMempoolApi(`/block/${blockHash}/txs`);
      if (res.ok) {
        const txs: TxData[] = await res.json();
        setBlockTxs((prev) => ({ ...prev, [blockHash]: txs.slice(0, 25) }));
      }
    } catch { /* ignore */ }
    setBlockTxsLoading(null);
  }

  // ---------------------------------------------------------------------------
  // Transaction lookup
  // ---------------------------------------------------------------------------

  async function lookupTx(txid?: string) {
    const id = (txid ?? txQuery).trim();
    if (!id) return;
    setTxLoading(true);
    setTxError('');
    setTxResult(null);

    try {
      const res = await fetchMempoolApi(`/tx/${id}`);
      if (!res.ok) throw new Error('Transaction not found');
      const tx: TxData = await res.json();
      setTxResult(tx);

      if (status?.blockHeight) setTxCurrentHeight(status.blockHeight);
      else {
        try {
          const hRes = await fetchMempoolApi('/blocks/tip/height');
          if (hRes.ok) setTxCurrentHeight(parseInt(await hRes.text(), 10));
        } catch { /* ignore */ }
      }
    } catch (err) {
      setTxError(err instanceof Error ? err.message : 'Lookup failed');
    }
    setTxLoading(false);
  }

  // ---------------------------------------------------------------------------
  // Address lookup
  // ---------------------------------------------------------------------------

  async function lookupAddress(addr?: string) {
    const address = (addr ?? addrQuery).trim();
    if (!address) return;
    setAddrLoading(true);
    setAddrError('');
    setAddrData(null);
    setAddrTxs([]);
    setAddrUtxos([]);

    try {
      const [infoRes, txsRes, utxoRes] = await Promise.all([
        fetchMempoolApi(`/address/${address}`),
        fetchMempoolApi(`/address/${address}/txs`),
        fetchMempoolApi(`/address/${address}/utxo`),
      ]);
      if (!infoRes.ok) throw new Error('Address not found');

      const info: AddressData = await infoRes.json();
      setAddrData(info);

      if (txsRes.ok) {
        const txs: TxData[] = await txsRes.json();
        setAddrTxs(txs.slice(0, 20));
      }
      if (utxoRes.ok) {
        const utxos: UTXOData[] = await utxoRes.json();
        setAddrUtxos(utxos);
      }
    } catch (err) {
      setAddrError(err instanceof Error ? err.message : 'Lookup failed');
    }
    setAddrLoading(false);
  }

  // ---------------------------------------------------------------------------
  // Navigation helper — switch tab and pre-fill query
  // ---------------------------------------------------------------------------

  function navigateToTx(txid: string) {
    setTxQuery(txid);
    setActiveTab('transaction');
    lookupTx(txid);
  }

  function navigateToAddr(address: string) {
    setAddrQuery(address);
    setActiveTab('address');
    lookupAddress(address);
  }

  // ---------------------------------------------------------------------------
  // Tab switching
  // ---------------------------------------------------------------------------

  function switchTab(tab: Tab) {
    setActiveTab(tab);
    setSearchParams((prev) => { prev.set('tab', tab); return prev; }, { replace: true });
  }

  const tabs: { id: Tab; label: string }[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'transaction', label: 'Transaction' },
    { id: 'address', label: 'Address' },
  ];

  const latestBlockTime = blocks[0]?.timestamp;

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="h-full flex flex-col">
      {/* Header with back button */}
      <div className="page-header px-4">
        <button onClick={() => navigate('/')} className="btn-back">
          <ArrowLeft className="w-5 h-5" />
        </button>
        <h1 className="text-lg font-bold">Block Explorer</h1>
      </div>

      {/* Stats bar */}
      <StatsBar status={status} difficulty={difficulty} hashrate={hashrate} latestBlockTime={latestBlockTime} />

      {/* Tab bar */}
      <div className="flex border-b border-white/10 px-4">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => switchTab(t.id)}
            className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
              activeTab === t.id
                ? 'text-white border-bitcoin'
                : 'text-gray-500 border-transparent hover:text-gray-300'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto pb-24">
        {activeTab === 'overview' && (
          <OverviewTab
            blocks={blocks}
            blocksLoading={blocksLoading}
            blocksError={blocksError}
            expandedBlock={expandedBlock}
            blockTxs={blockTxs}
            blockTxsLoading={blockTxsLoading}
            onToggleBlock={toggleBlockExpand}
            onRefresh={() => { setBlocksLoading(true); setBlocksError(''); loadBlocks(); loadStats(); }}
            onViewTx={navigateToTx}
          />
        )}
        {activeTab === 'transaction' && (
          <TransactionTab
            query={txQuery}
            setQuery={setTxQuery}
            result={txResult}
            loading={txLoading}
            error={txError}
            currentHeight={txCurrentHeight}
            onSearch={() => lookupTx()}
            onViewAddr={navigateToAddr}
          />
        )}
        {activeTab === 'address' && (
          <AddressTab
            query={addrQuery}
            setQuery={setAddrQuery}
            data={addrData}
            txs={addrTxs}
            utxos={addrUtxos}
            loading={addrLoading}
            error={addrError}
            showUtxos={showUtxos}
            setShowUtxos={setShowUtxos}
            onSearch={() => lookupAddress()}
            onViewTx={navigateToTx}
            currentHeight={status?.blockHeight ?? 0}
          />
        )}
      </div>
    </div>
  );
}

// ===========================================================================
// OVERVIEW TAB
// ===========================================================================

function OverviewTab({
  blocks,
  blocksLoading,
  blocksError,
  expandedBlock,
  blockTxs,
  blockTxsLoading,
  onToggleBlock,
  onRefresh,
  onViewTx,
}: {
  blocks: BlockSummary[];
  blocksLoading: boolean;
  blocksError: string;
  expandedBlock: string | null;
  blockTxs: Record<string, TxData[]>;
  blockTxsLoading: string | null;
  onToggleBlock: (hash: string) => void;
  onRefresh: () => void;
  onViewTx: (txid: string) => void;
}) {
  return (
    <div className="p-4 space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-white flex items-center gap-2">
          <Layers className="w-4 h-4 text-bitcoin" />
          Latest Blocks
        </h2>
        <button
          onClick={onRefresh}
          className="p-1.5 rounded-lg hover:bg-surface-700 transition-colors"
          title="Refresh"
        >
          <RefreshCw className={`w-4 h-4 text-gray-400 ${blocksLoading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {blocksError && blocks.length === 0 ? (
        <div className="flex flex-col items-center py-12">
          <AlertCircle className="w-8 h-8 text-red-400 mb-3" />
          <p className="text-sm text-red-300 mb-1">Failed to load blocks</p>
          <p className="text-xs text-gray-500 mb-4">{blocksError}</p>
          <button
            onClick={onRefresh}
            className="btn-primary flex items-center gap-2 text-sm px-4 py-2"
          >
            <RefreshCw className="w-4 h-4" />
            Retry
          </button>
        </div>
      ) : blocksLoading && blocks.length === 0 ? (
        <div className="flex flex-col items-center py-12">
          <Loader2 className="w-8 h-8 text-bitcoin animate-spin mb-3" />
          <p className="text-sm text-gray-400">Loading blocks...</p>
        </div>
      ) : (
        <div className="space-y-2">
          {blocks.map((block) => (
            <div key={block.id} className="card">
              <button
                onClick={() => onToggleBlock(block.id)}
                className="w-full flex items-center gap-3 text-left"
              >
                {/* Height badge */}
                <div className="w-16 h-10 rounded-lg bg-bitcoin/15 flex items-center justify-center flex-shrink-0">
                  <span className="text-xs font-bold text-bitcoin font-mono">{block.height.toLocaleString()}</span>
                </div>
                {/* Info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <code className="text-[11px] text-gray-400 font-mono truncate">{truncateHash(block.id, 10)}</code>
                    <CopyButton text={block.id} />
                  </div>
                  <div className="flex items-center gap-3 mt-1 text-[10px] text-gray-500">
                    {block.extras?.pool?.name && (
                      <span className="text-gray-400">{block.extras.pool.name}</span>
                    )}
                    <span>{block.tx_count} txs</span>
                    {block.extras?.totalFees !== undefined && (
                      <span>{formatSats(block.extras.totalFees)}</span>
                    )}
                    <span className="flex items-center gap-0.5">
                      <Clock className="w-3 h-3" />
                      {timeAgo(block.timestamp)}
                    </span>
                  </div>
                </div>
                {expandedBlock === block.id
                  ? <ChevronUp className="w-4 h-4 text-gray-500 flex-shrink-0" />
                  : <ChevronDown className="w-4 h-4 text-gray-500 flex-shrink-0" />
                }
              </button>

              {/* Expanded block transactions */}
              {expandedBlock === block.id && (
                <div className="mt-3 pt-3 border-t border-white/5">
                  {blockTxsLoading === block.id ? (
                    <div className="flex items-center justify-center py-4">
                      <Loader2 className="w-5 h-5 text-bitcoin animate-spin" />
                    </div>
                  ) : blockTxs[block.id] ? (
                    <div className="space-y-1.5 max-h-60 overflow-y-auto">
                      {blockTxs[block.id].map((tx) => (
                        <button
                          key={tx.txid}
                          onClick={() => onViewTx(tx.txid)}
                          className="w-full flex items-center justify-between text-left py-1.5 px-2 rounded-lg hover:bg-surface-700 transition-colors"
                        >
                          <code className="text-[11px] text-gray-400 font-mono truncate mr-2">{truncateHash(tx.txid, 12)}</code>
                          <span className="text-[10px] text-gray-500 flex-shrink-0">{formatSats(tx.fee)} fee</span>
                        </button>
                      ))}
                      {block.tx_count > 25 && (
                        <p className="text-[10px] text-gray-500 text-center py-1">
                          Showing 25 of {block.tx_count} transactions
                        </p>
                      )}
                    </div>
                  ) : null}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ===========================================================================
// TRANSACTION TAB
// ===========================================================================

function TransactionTab({
  query,
  setQuery,
  result,
  loading,
  error,
  currentHeight,
  onSearch,
  onViewAddr,
}: {
  query: string;
  setQuery: (q: string) => void;
  result: TxData | null;
  loading: boolean;
  error: string;
  currentHeight: number;
  onSearch: () => void;
  onViewAddr: (addr: string) => void;
}) {
  const confirmations = result?.status.confirmed && result.status.block_height && currentHeight
    ? currentHeight - result.status.block_height + 1
    : 0;

  const totalInput = result?.vin.reduce((sum, v) => sum + (v.prevout?.value ?? 0), 0) ?? 0;
  const totalOutput = result?.vout.reduce((sum, v) => sum + v.value, 0) ?? 0;

  return (
    <div className="p-4 space-y-3">
      {/* Search */}
      <form onSubmit={(e) => { e.preventDefault(); onSearch(); }} className="flex gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Enter transaction ID (txid)"
            className="input-field !pl-9 !py-2 !min-h-[40px] text-sm font-mono"
          />
        </div>
        <button type="submit" disabled={loading || !query.trim()} className="btn-primary !px-4 !py-2 !min-h-[40px] text-sm">
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Lookup'}
        </button>
      </form>

      {loading && (
        <div className="flex flex-col items-center py-12">
          <Loader2 className="w-8 h-8 text-bitcoin animate-spin mb-3" />
          <p className="text-sm text-gray-400">Fetching transaction...</p>
        </div>
      )}

      {error && (
        <div className="card border-red-500/20">
          <div className="flex items-start gap-2.5">
            <AlertCircle className="w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" />
            <p className="text-sm text-red-300">{error}</p>
          </div>
        </div>
      )}

      {result && (
        <div className="space-y-3">
          {/* Overview card */}
          <div className="card">
            <div className="flex items-center gap-2 mb-3">
              <div className="w-1.5 h-1.5 rounded-full bg-bitcoin" />
              <span className="text-[10px] text-gray-500 uppercase tracking-wider">Transaction</span>
              <a
                href={getMempoolTxUrl(result.txid)}
                target="_blank"
                rel="noopener noreferrer"
                className="ml-auto flex items-center gap-1 text-[10px] text-bitcoin hover:text-bitcoin/80"
              >
                mempool.space <ExternalLink className="w-3 h-3" />
              </a>
            </div>

            <div className="space-y-2.5">
              <div className="flex items-start gap-2">
                <div className="flex-1 min-w-0">
                  <p className="text-[10px] text-gray-500 mb-0.5">TXID</p>
                  <code className="text-[11px] text-gray-300 font-mono break-all">{result.txid}</code>
                </div>
                <CopyButton text={result.txid} />
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div>
                  <p className="text-[10px] text-gray-500 mb-0.5">Status</p>
                  <p className="text-sm font-medium">
                    {result.status.confirmed
                      ? <span className="text-green-400">Confirmed</span>
                      : <span className="text-bitcoin">Unconfirmed</span>
                    }
                  </p>
                </div>
                <div>
                  <p className="text-[10px] text-gray-500 mb-0.5">Confirmations</p>
                  <p className="text-sm font-medium text-white font-mono">{confirmations > 0 ? confirmations.toLocaleString() : '—'}</p>
                </div>
                <div>
                  <p className="text-[10px] text-gray-500 mb-0.5">Fee</p>
                  <p className="text-sm font-medium text-white font-mono">{formatSats(result.fee)}</p>
                </div>
              </div>

              {result.status.block_height && (
                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <p className="text-[10px] text-gray-500 mb-0.5">Block</p>
                    <p className="text-sm text-white font-mono">{result.status.block_height.toLocaleString()}</p>
                  </div>
                  <div>
                    <p className="text-[10px] text-gray-500 mb-0.5">Size</p>
                    <p className="text-sm text-white font-mono">{result.size.toLocaleString()} B</p>
                  </div>
                  <div>
                    <p className="text-[10px] text-gray-500 mb-0.5">Weight</p>
                    <p className="text-sm text-white font-mono">{result.weight.toLocaleString()} WU</p>
                  </div>
                </div>
              )}

              <div>
                <p className="text-[10px] text-gray-500 mb-0.5">Fee Rate</p>
                <p className="text-sm text-white font-mono">{(result.fee / (result.weight / 4)).toFixed(1)} sat/vB</p>
              </div>
            </div>
          </div>

          {/* Visual flow: Inputs → Outputs */}
          <div className="card">
            <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-3">Flow</p>
            <div className="flex items-stretch gap-2">
              {/* Inputs column */}
              <div className="flex-1 space-y-1.5 min-w-0">
                <p className="text-[10px] text-red-400 font-medium flex items-center gap-1 mb-1">
                  <ArrowDownRight className="w-3 h-3" /> Inputs ({result.vin.length})
                </p>
                {result.vin.slice(0, 8).map((vin, i) => (
                  <div key={i} className="bg-surface-700 rounded-lg px-2 py-1.5 text-[10px]">
                    {vin.prevout?.scriptpubkey_address ? (
                      <button
                        onClick={() => onViewAddr(vin.prevout!.scriptpubkey_address!)}
                        className="text-gray-300 font-mono break-all text-left hover:text-white transition-colors"
                      >
                        {truncateHash(vin.prevout.scriptpubkey_address, 8)}
                      </button>
                    ) : (
                      <span className="text-gray-500 font-mono">Coinbase</span>
                    )}
                    {vin.prevout && (
                      <p className="text-bitcoin font-mono mt-0.5">{formatBtc(vin.prevout.value)} BTC</p>
                    )}
                  </div>
                ))}
                {result.vin.length > 8 && (
                  <p className="text-[10px] text-gray-500 text-center">+{result.vin.length - 8} more</p>
                )}
                <div className="text-[10px] text-gray-500 font-mono pt-1">
                  Total: {formatBtc(totalInput)} BTC
                </div>
              </div>

              {/* Arrow */}
              <div className="flex items-center px-1">
                <ArrowRight className="w-5 h-5 text-gray-600" />
              </div>

              {/* Outputs column */}
              <div className="flex-1 space-y-1.5 min-w-0">
                <p className="text-[10px] text-green-400 font-medium flex items-center gap-1 mb-1">
                  <ArrowUpRight className="w-3 h-3" /> Outputs ({result.vout.length})
                </p>
                {result.vout.slice(0, 8).map((vout, i) => {
                  const opReturn = isOpReturn(vout);
                  const proto = opReturn ? detectProtocol(vout.scriptpubkey) : null;
                  return (
                    <div key={i} className={`rounded-lg px-2 py-1.5 text-[10px] ${opReturn ? 'bg-purple-500/10 border border-purple-500/20' : 'bg-surface-700'}`}>
                      {opReturn ? (
                        <div>
                          <div className="flex items-center gap-1.5">
                            <span className="text-purple-300 font-medium">OP_RETURN</span>
                            {proto && <ProtocolBadge match={proto} />}
                          </div>
                          {proto && (
                            <p className="text-gray-400 font-mono mt-0.5 break-all">
                              {proto.protocol === 'NSTR'
                                ? `Event: ${truncateHash(proto.eventId, 8)} (kind ${proto.kind})`
                                : `Hash: ${truncateHash(proto.hash, 8)}`
                              }
                            </p>
                          )}
                        </div>
                      ) : (
                        <>
                          {vout.scriptpubkey_address ? (
                            <button
                              onClick={() => onViewAddr(vout.scriptpubkey_address!)}
                              className="text-gray-300 font-mono break-all text-left hover:text-white transition-colors"
                            >
                              {truncateHash(vout.scriptpubkey_address, 8)}
                            </button>
                          ) : (
                            <span className="text-gray-500 font-mono break-all">{truncateHash(vout.scriptpubkey, 10)}</span>
                          )}
                          <p className="text-green-400 font-mono mt-0.5">{formatBtc(vout.value)} BTC</p>
                        </>
                      )}
                    </div>
                  );
                })}
                {result.vout.length > 8 && (
                  <p className="text-[10px] text-gray-500 text-center">+{result.vout.length - 8} more</p>
                )}
                <div className="text-[10px] text-gray-500 font-mono pt-1">
                  Total: {formatBtc(totalOutput)} BTC
                </div>
              </div>
            </div>
          </div>

          {/* OP_RETURN Details */}
          {result.vout.filter(isOpReturn).map((vout, i) => {
            const proto = detectProtocol(vout.scriptpubkey);
            return (
              <div key={i} className="card border-purple-500/20">
                <div className="flex items-center gap-2 mb-2">
                  <div className="w-1.5 h-1.5 rounded-full bg-purple-400" />
                  <span className="text-[10px] text-gray-500 uppercase tracking-wider">OP_RETURN #{i + 1}</span>
                  {proto && <ProtocolBadge match={proto} />}
                </div>
                <div className="space-y-2">
                  <div>
                    <p className="text-[10px] text-gray-500 mb-0.5">Raw Hex</p>
                    <code className="text-[10px] text-gray-400 font-mono break-all block max-h-16 overflow-y-auto">{vout.scriptpubkey}</code>
                  </div>
                  {proto && (
                    <div className="border-t border-white/5 pt-2">
                      {proto.protocol === 'NSTR' && (
                        <div className="space-y-1.5">
                          <p className="text-xs text-purple-300 font-medium">Nostr Event Reference</p>
                          <div className="flex items-start gap-2">
                            <div className="flex-1 min-w-0">
                              <p className="text-[10px] text-gray-500">Event ID</p>
                              <code className="text-[11px] text-white font-mono break-all">{proto.eventId}</code>
                            </div>
                            <CopyButton text={proto.eventId} />
                          </div>
                          <div>
                            <p className="text-[10px] text-gray-500">Kind</p>
                            <p className="text-sm text-white">{proto.kind}</p>
                          </div>
                        </div>
                      )}
                      {proto.protocol === 'NINV' && (
                        <div className="space-y-1.5">
                          <p className="text-xs text-orange-300 font-medium">Invoice Settlement Proof</p>
                          <div className="flex items-start gap-2">
                            <div className="flex-1 min-w-0">
                              <p className="text-[10px] text-gray-500">SHA-256 Hash</p>
                              <code className="text-[11px] text-white font-mono break-all">{proto.hash}</code>
                            </div>
                            <CopyButton text={proto.hash} />
                          </div>
                        </div>
                      )}
                      {proto.protocol === 'LOPS' && (
                        <div className="space-y-1.5">
                          <p className="text-xs text-blue-300 font-medium">Light OP Proof</p>
                          <div className="flex items-start gap-2">
                            <div className="flex-1 min-w-0">
                              <p className="text-[10px] text-gray-500">SHA-256 Hash</p>
                              <code className="text-[11px] text-white font-mono break-all">{proto.hash}</code>
                            </div>
                            <CopyButton text={proto.hash} />
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                  {!proto && (
                    <p className="text-[11px] text-gray-500">No recognized protocol marker</p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Empty state */}
      {!loading && !error && !result && (
        <div className="flex flex-col items-center justify-center py-16">
          <Search className="w-10 h-10 text-gray-600 mb-3" />
          <p className="text-sm text-gray-400 text-center mb-1">Transaction Lookup</p>
          <p className="text-xs text-gray-600 text-center max-w-[260px]">
            Enter a txid to view details, inputs/outputs, fees, and check for embedded protocol data (NSTR, NINV, LOPS)
          </p>
        </div>
      )}
    </div>
  );
}

// ===========================================================================
// ADDRESS TAB
// ===========================================================================

function AddressTab({
  query,
  setQuery,
  data,
  txs,
  utxos,
  loading,
  error,
  showUtxos,
  setShowUtxos,
  onSearch,
  onViewTx,
  currentHeight,
}: {
  query: string;
  setQuery: (q: string) => void;
  data: AddressData | null;
  txs: TxData[];
  utxos: UTXOData[];
  loading: boolean;
  error: string;
  showUtxos: boolean;
  setShowUtxos: (v: boolean) => void;
  onSearch: () => void;
  onViewTx: (txid: string) => void;
  currentHeight: number;
}) {
  const confirmed = data
    ? data.chain_stats.funded_txo_sum - data.chain_stats.spent_txo_sum
    : 0;
  const unconfirmed = data
    ? data.mempool_stats.funded_txo_sum - data.mempool_stats.spent_txo_sum
    : 0;

  return (
    <div className="p-4 space-y-3">
      {/* Search */}
      <form onSubmit={(e) => { e.preventDefault(); onSearch(); }} className="flex gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Enter Bitcoin address"
            className="input-field !pl-9 !py-2 !min-h-[40px] text-sm font-mono"
          />
        </div>
        <button type="submit" disabled={loading || !query.trim()} className="btn-primary !px-4 !py-2 !min-h-[40px] text-sm">
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Lookup'}
        </button>
      </form>

      {loading && (
        <div className="flex flex-col items-center py-12">
          <Loader2 className="w-8 h-8 text-bitcoin animate-spin mb-3" />
          <p className="text-sm text-gray-400">Fetching address data...</p>
        </div>
      )}

      {error && (
        <div className="card border-red-500/20">
          <div className="flex items-start gap-2.5">
            <AlertCircle className="w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" />
            <p className="text-sm text-red-300">{error}</p>
          </div>
        </div>
      )}

      {data && (
        <div className="space-y-3">
          {/* Address header */}
          <div className="card">
            <div className="flex items-center gap-2 mb-3">
              <div className="w-1.5 h-1.5 rounded-full bg-bitcoin" />
              <span className="text-[10px] text-gray-500 uppercase tracking-wider">Address</span>
              <a
                href={getMempoolAddressUrl(data.address)}
                target="_blank"
                rel="noopener noreferrer"
                className="ml-auto flex items-center gap-1 text-[10px] text-bitcoin hover:text-bitcoin/80"
              >
                mempool.space <ExternalLink className="w-3 h-3" />
              </a>
            </div>

            <div className="flex items-start gap-2 mb-3">
              <code className="text-[11px] text-gray-300 font-mono break-all flex-1">{data.address}</code>
              <CopyButton text={data.address} />
            </div>

            {/* QR code placeholder via API */}
            <div className="flex justify-center mb-3">
              <img
                src={`https://api.qrserver.com/v1/create-qr-code/?size=120x120&data=${encodeURIComponent(data.address)}&bgcolor=1a1a2e&color=ffffff&format=svg`}
                alt="QR"
                className="w-[120px] h-[120px] rounded-lg"
              />
            </div>

            {/* Balance stats */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <p className="text-[10px] text-gray-500 mb-0.5">Confirmed Balance</p>
                <p className="text-sm font-bold text-bitcoin font-mono">{formatSats(confirmed)}</p>
              </div>
              <div>
                <p className="text-[10px] text-gray-500 mb-0.5">Unconfirmed</p>
                <p className="text-sm font-medium text-yellow-400 font-mono">{formatSats(unconfirmed)}</p>
              </div>
              <div>
                <p className="text-[10px] text-gray-500 mb-0.5">Total Received</p>
                <p className="text-sm text-white font-mono">{formatSats(data.chain_stats.funded_txo_sum)}</p>
              </div>
              <div>
                <p className="text-[10px] text-gray-500 mb-0.5">Total Sent</p>
                <p className="text-sm text-white font-mono">{formatSats(data.chain_stats.spent_txo_sum)}</p>
              </div>
              <div>
                <p className="text-[10px] text-gray-500 mb-0.5">Tx Count</p>
                <p className="text-sm text-white font-mono">{data.chain_stats.tx_count}</p>
              </div>
              <div>
                <p className="text-[10px] text-gray-500 mb-0.5">UTXOs</p>
                <p className="text-sm text-white font-mono">{utxos.length}</p>
              </div>
            </div>
          </div>

          {/* UTXO Inspector */}
          <div className="card">
            <button
              onClick={() => setShowUtxos(!showUtxos)}
              className="w-full flex items-center justify-between"
            >
              <span className="text-xs font-semibold text-white flex items-center gap-2">
                <Layers className="w-3.5 h-3.5 text-green-400" />
                UTXO Inspector ({utxos.length})
              </span>
              {showUtxos
                ? <ChevronUp className="w-4 h-4 text-gray-500" />
                : <ChevronDown className="w-4 h-4 text-gray-500" />
              }
            </button>
            {showUtxos && (
              <div className="mt-3 space-y-1.5 max-h-72 overflow-y-auto">
                {utxos.length === 0 ? (
                  <p className="text-[11px] text-gray-500 py-2">No unspent outputs</p>
                ) : utxos.map((u, i) => {
                  const confs = u.status.confirmed && u.status.block_height && currentHeight
                    ? currentHeight - u.status.block_height + 1
                    : 0;
                  return (
                    <div key={i} className="bg-surface-700 rounded-lg px-2.5 py-2 text-[10px]">
                      <div className="flex items-center gap-1.5">
                        <button
                          onClick={() => onViewTx(u.txid)}
                          className="font-mono text-gray-300 hover:text-white transition-colors truncate text-left"
                        >
                          {truncateHash(u.txid, 10)}:{u.vout}
                        </button>
                        <CopyButton text={`${u.txid}:${u.vout}`} />
                      </div>
                      <div className="flex items-center gap-3 mt-1">
                        <span className="text-bitcoin font-mono font-medium">{formatSats(u.value)}</span>
                        <span className="text-gray-500">
                          {confs > 0 ? `${confs.toLocaleString()} confs` : 'unconfirmed'}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Recent Transactions */}
          {txs.length > 0 && (
            <div className="card">
              <p className="text-xs font-semibold text-white mb-3">Recent Transactions</p>
              <div className="space-y-1.5 max-h-80 overflow-y-auto">
                {txs.map((tx) => {
                  const isSend = tx.vin.some((v) => v.prevout?.scriptpubkey_address === data.address);
                  const netValue = tx.vout
                    .filter((v) => isSend ? v.scriptpubkey_address !== data.address : v.scriptpubkey_address === data.address)
                    .reduce((s, v) => s + v.value, 0);
                  return (
                    <button
                      key={tx.txid}
                      onClick={() => onViewTx(tx.txid)}
                      className="w-full flex items-center gap-3 py-2 px-2 rounded-lg hover:bg-surface-700 transition-colors text-left"
                    >
                      <div className={`w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 ${
                        isSend ? 'bg-red-500/15' : 'bg-green-500/15'
                      }`}>
                        {isSend
                          ? <ArrowUpRight className="w-3.5 h-3.5 text-red-400" />
                          : <ArrowDownRight className="w-3.5 h-3.5 text-green-400" />
                        }
                      </div>
                      <div className="flex-1 min-w-0">
                        <code className="text-[11px] text-gray-400 font-mono truncate block">{truncateHash(tx.txid, 10)}</code>
                        <p className="text-[10px] text-gray-500 mt-0.5">
                          {tx.status.confirmed
                            ? tx.status.block_time ? timeAgo(tx.status.block_time) : 'Confirmed'
                            : 'Pending'
                          }
                        </p>
                      </div>
                      <span className={`text-xs font-mono font-medium ${isSend ? 'text-red-400' : 'text-green-400'}`}>
                        {isSend ? '-' : '+'}{formatSats(netValue)}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Empty state */}
      {!loading && !error && !data && (
        <div className="flex flex-col items-center justify-center py-16">
          <Search className="w-10 h-10 text-gray-600 mb-3" />
          <p className="text-sm text-gray-400 text-center mb-1">Address Lookup</p>
          <p className="text-xs text-gray-600 text-center max-w-[260px]">
            Enter a Bitcoin address to view balance, transaction history, and unspent outputs
          </p>
        </div>
      )}
    </div>
  );
}
