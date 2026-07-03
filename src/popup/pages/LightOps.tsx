import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeft, Hash, Copy, Check, Download, ExternalLink,
  Loader2, Search, CheckCircle2, XCircle, FileDown, Compass,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import {
  encodeLightOp, decodeLightOp, verifyLightOp,
  decodeNostrOpReturn, decodeInvoiceOpReturn,
} from '@/lib/bitcoin/opreturn';
import { buildPsbt, downloadPsbtFile, type PsbtResult } from '@/lib/bitcoin/psbt-builder';
import { pubkeyToTaprootAddress } from '@/lib/bitcoin/address';
import { fetchFeeEstimates, formatSats, fetchAddressTransactions, type Transaction } from '@/lib/bitcoin/mempool';
import { resolveNip05 } from '@/lib/nostr/nip05';
import { nip19 } from 'nostr-tools';

type Tab = 'create' | 'verify' | 'history' | 'discover';

interface LightOpEntry {
  eventId: string;
  hash: string;
  opReturnHex: string;
  txid?: string;
  confirmed?: boolean;
  createdAt: number;
}

interface FetchedEvent {
  id: string;
  pubkey: string;
  kind: number;
  content: string;
  created_at: number;
  tags: string[][];
}

const RELAYS = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.nostr.band'];

async function fetchFromRelay(relayUrl: string, eventId: string): Promise<FetchedEvent | null> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => { ws.close(); resolve(null); }, 8000);
    const ws = new WebSocket(relayUrl);
    const subId = Math.random().toString(36).slice(2, 10);

    ws.onopen = () => {
      ws.send(JSON.stringify(['REQ', subId, { ids: [eventId] }]));
    };

    ws.onmessage = (msg) => {
      try {
        const data = JSON.parse(msg.data);
        if (data[0] === 'EVENT' && data[1] === subId && data[2]) {
          clearTimeout(timeout);
          ws.close();
          resolve(data[2] as FetchedEvent);
        }
        if (data[0] === 'EOSE') {
          clearTimeout(timeout);
          ws.close();
          resolve(null);
        }
      } catch {}
    };

    ws.onerror = () => { clearTimeout(timeout); ws.close(); resolve(null); };
  });
}

async function fetchEventById(eventId: string): Promise<FetchedEvent | null> {
  for (const relay of RELAYS) {
    try {
      const event = await fetchFromRelay(relay, eventId);
      if (event) return event;
    } catch {}
  }
  return null;
}

function decodeNoteId(input: string): string | null {
  const trimmed = input.trim();
  if (/^[0-9a-f]{64}$/i.test(trimmed)) return trimmed;

  try {
    if (trimmed.startsWith('note1')) {
      const decoded = nip19.decode(trimmed);
      if (decoded.type === 'note') return decoded.data as string;
    }
    if (trimmed.startsWith('nevent1')) {
      const decoded = nip19.decode(trimmed);
      if (decoded.type === 'nevent') return (decoded.data as { id: string }).id;
    }
  } catch {}

  return null;
}

export function LightOps() {
  const navigate = useNavigate();
  const { publicKey } = useAuth();
  const [tab, setTab] = useState<Tab>('create');

  return (
    <div className="h-full flex flex-col pb-24">
      {/* Header */}
      <div className="page-header">
        <button onClick={() => navigate('/')} className="btn-back">
          <ArrowLeft className="w-5 h-5" />
        </button>
        <h1 className="text-lg font-bold">Light OPs</h1>
        <div className="w-11" />
      </div>

      {/* Tabs */}
      <div className="flex mx-4 mb-4 bg-surface-800 rounded-xl p-1">
        {(['create', 'verify', 'history', 'discover'] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`flex-1 py-2 text-sm font-medium rounded-lg transition-colors ${
              tab === t ? 'bg-white text-black font-semibold' : 'text-gray-400 hover:text-white'
            }`}
          >
            {t === 'create' ? 'Create' : t === 'verify' ? 'Verify' : t === 'history' ? 'History' : 'Discover'}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-y-auto px-4">
        {tab === 'create' && <CreateTab publicKey={publicKey} />}
        {tab === 'verify' && <VerifyTab />}
        {tab === 'history' && <HistoryTab publicKey={publicKey} />}
        {tab === 'discover' && <DiscoverTab publicKey={publicKey} />}
      </div>
    </div>
  );
}

function CreateTab({ publicKey }: { publicKey: string }) {
  const [eventInput, setEventInput] = useState('');
  const [fetchedEvent, setFetchedEvent] = useState<FetchedEvent | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [opResult, setOpResult] = useState<ReturnType<typeof encodeLightOp> | null>(null);
  const [psbtResult, setPsbtResult] = useState<PsbtResult | null>(null);
  const [psbtLoading, setPsbtLoading] = useState(false);
  const [psbtError, setPsbtError] = useState('');
  const [feeRate, setFeeRate] = useState(5);
  const [copied, setCopied] = useState('');

  const address = pubkeyToTaprootAddress(publicKey);

  useEffect(() => {
    fetchFeeEstimates().then((f) => setFeeRate(f.hour));
  }, []);

  async function handleFetch() {
    setError('');
    setFetchedEvent(null);
    setOpResult(null);
    setPsbtResult(null);

    const eventId = decodeNoteId(eventInput);
    if (!eventId) {
      setError('Invalid event ID. Provide a 64-char hex ID, note1..., or nevent1...');
      return;
    }

    setLoading(true);
    try {
      const event = await fetchEventById(eventId);
      if (!event) {
        setError('Event not found on relays. Verify the ID is correct.');
        return;
      }
      setFetchedEvent(event);
      const result = encodeLightOp(event.id);
      setOpResult(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch event');
    } finally {
      setLoading(false);
    }
  }

  async function handleGeneratePsbt() {
    if (!opResult) return;
    setPsbtError('');
    setPsbtLoading(true);
    try {
      const result = await Promise.race([
        buildPsbt({
          fromAddress: address,
          toAddress: address,
          amountSats: 546,
          feeRate,
          internalPubkeyHex: publicKey,
          opReturnData: opResult.script.slice(2),
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Timed out fetching UTXOs. Make sure your Taproot address is funded.')), 15000)
        ),
      ]) as PsbtResult;
      setPsbtResult(result);

      if (fetchedEvent) {
        saveLightOp(publicKey, {
          eventId: fetchedEvent.id,
          hash: opResult.hash,
          opReturnHex: opResult.scriptHex,
          createdAt: Date.now(),
        });
      }
    } catch (err: any) {
      setPsbtError(err.message || 'PSBT generation failed');
    } finally {
      setPsbtLoading(false);
    }
  }

  async function copyText(text: string, label: string) {
    await navigator.clipboard.writeText(text);
    setCopied(label);
    setTimeout(() => setCopied(''), 2000);
  }

  return (
    <div className="space-y-4">
      <div className="card">
        <label className="text-xs text-gray-400 mb-2 block">Nostr Event ID</label>
        <div className="flex gap-2">
          <input
            type="text"
            value={eventInput}
            onChange={(e) => setEventInput(e.target.value)}
            placeholder="Hex ID, note1..., or nevent1..."
            className="input-field flex-1 text-sm"
          />
          <button
            onClick={handleFetch}
            disabled={loading || !eventInput.trim()}
            className="btn-primary px-4 text-sm flex items-center gap-1.5"
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
            Fetch
          </button>
        </div>
        {error && <p className="text-red-400 text-xs mt-2">{error}</p>}
      </div>

      {/* Event preview */}
      {fetchedEvent && (
        <div className="card">
          <div className="flex items-center gap-2 mb-2">
            <div className="w-2 h-2 rounded-full bg-nostr" />
            <span className="text-xs text-gray-400">Event Preview</span>
          </div>
          <div className="space-y-1.5">
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-gray-500 uppercase w-14">Kind</span>
              <span className="text-sm font-mono">{fetchedEvent.kind}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-gray-500 uppercase w-14">Author</span>
              <span className="text-sm font-mono text-gray-300 truncate">
                {fetchedEvent.pubkey.slice(0, 12)}...{fetchedEvent.pubkey.slice(-6)}
              </span>
            </div>
            <div className="flex items-start gap-2">
              <span className="text-[10px] text-gray-500 uppercase w-14 pt-0.5">Content</span>
              <p className="text-sm text-gray-300 line-clamp-3 break-all">
                {fetchedEvent.content.slice(0, 200) || '(empty)'}
                {fetchedEvent.content.length > 200 ? '...' : ''}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* OP_RETURN result */}
      {opResult && (
        <div className="card">
          <div className="flex items-center gap-2 mb-3">
            <Hash className="w-4 h-4 text-bitcoin" />
            <span className="text-xs text-gray-400">Generated OP_RETURN</span>
          </div>

          <div className="font-mono bg-surface-700 rounded-lg p-3 text-xs text-green-300 break-all mb-3">
            {opResult.scriptHex}
          </div>

          <div className="space-y-1.5 mb-3">
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-gray-500">Size</span>
              <span className="text-xs font-mono">{opResult.size} bytes</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-gray-500">SHA-256 Hash</span>
              <span className="text-xs font-mono text-gray-300 truncate ml-4">
                {opResult.hash.slice(0, 16)}...{opResult.hash.slice(-8)}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-gray-500">Protocol</span>
              <span className="text-xs font-mono">LOPS v1</span>
            </div>
          </div>

          <div className="flex gap-2">
            <button
              onClick={() => copyText(opResult.scriptHex, 'hex')}
              className="btn-secondary flex-1 text-xs flex items-center justify-center gap-1.5"
            >
              {copied === 'hex' ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5" />}
              Copy Hex
            </button>
            <button
              onClick={handleGeneratePsbt}
              disabled={psbtLoading}
              className="btn-primary flex-1 text-xs flex items-center justify-center gap-1.5"
            >
              {psbtLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FileDown className="w-3.5 h-3.5" />}
              Generate PSBT
            </button>
          </div>

          <div className="mt-2 p-2 bg-surface-700/50 rounded-lg">
            <span className="text-[10px] text-gray-500 block mb-0.5">Your Taproot Address (fund this first)</span>
            <p className="text-[11px] font-mono text-gray-300 break-all">{address}</p>
          </div>

          <div className="flex items-center justify-between mt-2">
            <span className="text-[10px] text-gray-500">Est. fee rate</span>
            <span className="text-xs font-mono">{feeRate} sat/vB</span>
          </div>

          {psbtError && <p className="text-red-400 text-xs mt-2">{psbtError}</p>}
        </div>
      )}

      {/* PSBT result */}
      {psbtResult && (
        <div className="card">
          <div className="flex items-center gap-2 mb-3">
            <CheckCircle2 className="w-4 h-4 text-green-400" />
            <span className="text-sm font-medium text-green-400">PSBT Generated</span>
          </div>

          <div className="space-y-1.5 mb-3">
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-gray-500">Fee</span>
              <span className="text-xs">{formatSats(psbtResult.fee)}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-gray-500">Virtual size</span>
              <span className="text-xs font-mono">{psbtResult.vsize} vB</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-gray-500">Inputs / Outputs</span>
              <span className="text-xs font-mono">{psbtResult.inputCount} / {psbtResult.outputCount}</span>
            </div>
          </div>

          <div className="space-y-2">
            <button
              onClick={() => downloadPsbtFile(psbtResult.psbtBase64, `lightop-${Date.now()}.psbt`)}
              className="btn-primary w-full text-sm flex items-center justify-center gap-2"
            >
              <Download className="w-4 h-4" />
              Download .psbt
            </button>
            <button
              onClick={() => copyText(psbtResult.psbtBase64, 'psbt')}
              className="btn-secondary w-full text-sm flex items-center justify-center gap-2"
            >
              {copied === 'psbt' ? <Check className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4" />}
              Copy Base64
            </button>
            <a
              href="https://mempool.space/tx/push"
              target="_blank"
              rel="noopener noreferrer"
              className="btn-secondary w-full text-sm flex items-center justify-center gap-2"
            >
              <ExternalLink className="w-4 h-4" />
              Push to Mempool
            </a>
          </div>
        </div>
      )}
    </div>
  );
}

function VerifyTab() {
  const [txid, setTxid] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [foundHash, setFoundHash] = useState<string | null>(null);
  const [verifyInput, setVerifyInput] = useState('');
  const [verifyResult, setVerifyResult] = useState<boolean | null>(null);
  const [foundScriptHex, setFoundScriptHex] = useState('');

  async function handleSearch() {
    setError('');
    setFoundHash(null);
    setVerifyResult(null);
    setFoundScriptHex('');

    if (!/^[0-9a-f]{64}$/i.test(txid.trim())) {
      setError('Invalid transaction ID');
      return;
    }

    setLoading(true);
    try {
      const res = await fetch(`https://mempool.space/api/tx/${txid.trim()}`);
      if (!res.ok) {
        setError('Transaction not found');
        return;
      }
      const tx = await res.json();

      for (const vout of tx.vout) {
        if (vout.scriptpubkey && vout.scriptpubkey.startsWith('6a')) {
          const decoded = decodeLightOp(vout.scriptpubkey);
          if (decoded) {
            setFoundHash(decoded.hash);
            setFoundScriptHex(vout.scriptpubkey);
            return;
          }
        }
      }

      setError('No Light OP found in this transaction');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch transaction');
    } finally {
      setLoading(false);
    }
  }

  function handleVerify() {
    if (!foundScriptHex || !verifyInput.trim()) return;
    const eventId = decodeNoteId(verifyInput) || verifyInput.trim();
    const result = verifyLightOp(foundScriptHex, eventId);
    setVerifyResult(result);
  }

  return (
    <div className="space-y-4">
      <div className="card">
        <label className="text-xs text-gray-400 mb-2 block">Bitcoin Transaction ID</label>
        <div className="flex gap-2">
          <input
            type="text"
            value={txid}
            onChange={(e) => setTxid(e.target.value)}
            placeholder="64-character hex txid"
            className="input-field flex-1 text-sm"
          />
          <button
            onClick={handleSearch}
            disabled={loading || !txid.trim()}
            className="btn-primary px-4 text-sm flex items-center gap-1.5"
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
            Scan
          </button>
        </div>
        {error && <p className="text-red-400 text-xs mt-2">{error}</p>}
      </div>

      {foundHash && (
        <div className="card">
          <div className="flex items-center gap-2 mb-3">
            <CheckCircle2 className="w-5 h-5 text-green-400" />
            <span className="text-sm font-medium text-green-400">Light OP Found!</span>
          </div>

          <div className="space-y-1.5 mb-4">
            <span className="text-[10px] text-gray-500 block">Stored Hash (SHA-256)</span>
            <div className="font-mono bg-surface-700 rounded-lg p-3 text-xs text-green-300 break-all">
              {foundHash}
            </div>
          </div>

          <div>
            <label className="text-xs text-gray-400 mb-2 block">
              Verify against Nostr Event ID
            </label>
            <input
              type="text"
              value={verifyInput}
              onChange={(e) => { setVerifyInput(e.target.value); setVerifyResult(null); }}
              placeholder="Paste event ID to verify"
              className="input-field w-full text-sm mb-2"
            />
            <button
              onClick={handleVerify}
              disabled={!verifyInput.trim()}
              className="btn-primary w-full text-sm"
            >
              Verify Match
            </button>

            {verifyResult === true && (
              <div className="flex items-center gap-2 mt-3 p-3 bg-green-500/10 rounded-xl border border-green-500/20">
                <CheckCircle2 className="w-5 h-5 text-green-400 animate-pulse" />
                <span className="text-sm text-green-400 font-medium">Match confirmed!</span>
              </div>
            )}
            {verifyResult === false && (
              <div className="flex items-center gap-2 mt-3 p-3 bg-red-500/10 rounded-xl border border-red-500/20">
                <XCircle className="w-5 h-5 text-red-400" />
                <span className="text-sm text-red-400 font-medium">No match — event ID does not correspond to this hash</span>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function HistoryTab({ publicKey }: { publicKey: string }) {
  const [entries, setEntries] = useState<LightOpEntry[]>([]);
  const [copied, setCopied] = useState('');

  useEffect(() => {
    loadHistory();
  }, [publicKey]);

  async function loadHistory() {
    const stored = await loadLightOps(publicKey);
    setEntries(stored.sort((a, b) => b.createdAt - a.createdAt));
  }

  async function copyText(text: string, label: string) {
    await navigator.clipboard.writeText(text);
    setCopied(label);
    setTimeout(() => setCopied(''), 2000);
  }

  if (entries.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-gray-500">
        <Hash className="w-10 h-10 mb-3 opacity-30" />
        <p className="text-sm">No Light OPs created yet</p>
        <p className="text-xs mt-1">Create your first proof-of-existence above</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {entries.map((entry, i) => (
        <div key={`${entry.eventId}-${entry.createdAt}`} className="card">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[10px] text-gray-500">
              {new Date(entry.createdAt).toLocaleDateString()} {new Date(entry.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </span>
            <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${
              entry.confirmed
                ? 'bg-green-500/15 text-green-400'
                : entry.txid
                  ? 'bg-yellow-500/15 text-yellow-400'
                  : 'bg-surface-700 text-gray-400'
            }`}>
              {entry.confirmed ? 'Confirmed' : entry.txid ? 'Broadcast' : 'Created'}
            </span>
          </div>
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-gray-500 w-12">Event</span>
              <span className="text-xs font-mono text-gray-300 truncate">
                {entry.eventId.slice(0, 16)}...{entry.eventId.slice(-8)}
              </span>
              <button onClick={() => copyText(entry.eventId, `ev-${i}`)} className="p-1 hover:bg-surface-700 rounded">
                {copied === `ev-${i}` ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3 text-gray-500" />}
              </button>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-gray-500 w-12">Hash</span>
              <span className="text-xs font-mono text-gray-300 truncate">
                {entry.hash.slice(0, 16)}...{entry.hash.slice(-8)}
              </span>
            </div>
            {entry.txid && (
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-gray-500 w-12">Txid</span>
                <a
                  href={`https://mempool.space/tx/${entry.txid}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs font-mono text-bitcoin truncate hover:underline"
                >
                  {entry.txid.slice(0, 16)}...{entry.txid.slice(-8)}
                </a>
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Discover Tab ───────────────────────────────────────────────

type ProtocolType = 'NSTR' | 'NINV' | 'LOPS';

interface DiscoveredOpReturn {
  protocol: ProtocolType;
  hash: string;
  txid: string;
  confirmed: boolean;
  blockHeight?: number;
  time?: number;
}

const PROTOCOL_STYLES: Record<ProtocolType, { label: string; color: string; bg: string; icon: string }> = {
  NSTR: { label: 'NSTR', color: 'text-purple-400', bg: 'bg-purple-500/10', icon: '🟣' },
  NINV: { label: 'NINV', color: 'text-orange-400', bg: 'bg-orange-500/10', icon: '🟠' },
  LOPS: { label: 'LOPS', color: 'text-blue-400', bg: 'bg-blue-500/10', icon: '🔵' },
};

function scanTransactionForProtocols(tx: Transaction): DiscoveredOpReturn[] {
  const results: DiscoveredOpReturn[] = [];

  for (const vout of tx.vout) {
    if (!vout.scriptpubkey || !vout.scriptpubkey.startsWith('6a')) continue;

    const nstr = decodeNostrOpReturn(vout.scriptpubkey);
    if (nstr) {
      results.push({
        protocol: 'NSTR',
        hash: nstr.eventId,
        txid: tx.txid,
        confirmed: tx.status.confirmed,
        blockHeight: tx.status.block_height,
        time: tx.status.block_time,
      });
      continue;
    }

    const ninv = decodeInvoiceOpReturn(vout.scriptpubkey);
    if (ninv) {
      results.push({
        protocol: 'NINV',
        hash: ninv.hash,
        txid: tx.txid,
        confirmed: tx.status.confirmed,
        blockHeight: tx.status.block_height,
        time: tx.status.block_time,
      });
      continue;
    }

    const lops = decodeLightOp(vout.scriptpubkey);
    if (lops) {
      results.push({
        protocol: 'LOPS',
        hash: lops.hash,
        txid: tx.txid,
        confirmed: tx.status.confirmed,
        blockHeight: tx.status.block_height,
        time: tx.status.block_time,
      });
      continue;
    }
  }

  return results;
}

async function discoverOpReturns(address: string): Promise<DiscoveredOpReturn[]> {
  const txs = await fetchAddressTransactions(address);
  const results: DiscoveredOpReturn[] = [];
  for (const tx of txs) {
    results.push(...scanTransactionForProtocols(tx));
  }
  return results;
}

function resolvePubkeyInput(input: string): string | null {
  const trimmed = input.trim();
  if (/^[0-9a-f]{64}$/i.test(trimmed)) return trimmed;
  try {
    if (trimmed.startsWith('npub1')) {
      const decoded = nip19.decode(trimmed);
      if (decoded.type === 'npub') return decoded.data as string;
    }
  } catch {}
  return null;
}

function timeAgo(unixSeconds: number): string {
  const diff = Math.floor(Date.now() / 1000) - unixSeconds;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(unixSeconds * 1000).toLocaleDateString();
}

function DiscoverTab({ publicKey }: { publicKey: string }) {
  const [searchInput, setSearchInput] = useState('');
  const [searchMode, setSearchMode] = useState<'author' | 'txid'>('author');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [results, setResults] = useState<DiscoveredOpReturn[]>([]);
  const [resolvedAddress, setResolvedAddress] = useState('');
  const [ownResults, setOwnResults] = useState<DiscoveredOpReturn[]>([]);
  const [ownLoading, setOwnLoading] = useState(true);
  const [copied, setCopied] = useState('');

  useEffect(() => {
    loadOwnOpReturns();
  }, [publicKey]);

  async function loadOwnOpReturns() {
    setOwnLoading(true);
    try {
      const address = pubkeyToTaprootAddress(publicKey);
      const discovered = await discoverOpReturns(address);
      setOwnResults(discovered);
    } catch {
    } finally {
      setOwnLoading(false);
    }
  }

  async function handleSearch() {
    setError('');
    setResults([]);
    setResolvedAddress('');

    if (!searchInput.trim()) {
      setError('Enter a search query');
      return;
    }

    setLoading(true);
    try {
      if (searchMode === 'txid') {
        await searchByTxid();
      } else {
        await searchByAuthor();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Search failed');
    } finally {
      setLoading(false);
    }
  }

  async function searchByAuthor() {
    let pubkey: string | null = null;

    pubkey = resolvePubkeyInput(searchInput);

    if (!pubkey && searchInput.includes('@')) {
      const nip05Result = await resolveNip05(searchInput);
      if (nip05Result) pubkey = nip05Result.pubkey;
    }

    if (!pubkey) {
      setError('Could not resolve pubkey. Provide an npub, 64-char hex, or NIP-05 address.');
      return;
    }

    const address = pubkeyToTaprootAddress(pubkey);
    setResolvedAddress(address);

    const discovered = await discoverOpReturns(address);
    if (discovered.length === 0) {
      setError(`No protocol OP_RETURNs found for address ${address.slice(0, 12)}...`);
      return;
    }
    setResults(discovered);
  }

  async function searchByTxid() {
    const txid = searchInput.trim();
    if (!/^[0-9a-f]{64}$/i.test(txid)) {
      setError('Invalid transaction ID — must be 64-character hex');
      return;
    }

    const res = await fetch(`https://mempool.space/api/tx/${txid}`);
    if (!res.ok) {
      setError('Transaction not found');
      return;
    }
    const tx: Transaction = await res.json();
    const discovered = scanTransactionForProtocols(tx);
    if (discovered.length === 0) {
      setError('No NSTR/NINV/LOPS protocol data found in this transaction');
      return;
    }
    setResults(discovered);
  }

  async function copyText(text: string, label: string) {
    await navigator.clipboard.writeText(text);
    setCopied(label);
    setTimeout(() => setCopied(''), 2000);
  }

  const allResults = results.length > 0 ? results : ownResults;
  const showingOwn = results.length === 0 && ownResults.length > 0;

  return (
    <div className="space-y-4">
      {/* Search section */}
      <div className="card">
        <div className="flex items-center gap-2 mb-3">
          <Compass className="w-4 h-4 text-nostr" />
          <span className="text-xs text-gray-400">Discover On-Chain Proofs</span>
        </div>

        <div className="flex gap-1.5 mb-3">
          <button
            onClick={() => setSearchMode('author')}
            className={`px-3 py-1.5 text-xs rounded-lg transition-colors ${
              searchMode === 'author' ? 'bg-nostr/20 text-nostr font-medium' : 'bg-surface-700 text-gray-400'
            }`}
          >
            By Author
          </button>
          <button
            onClick={() => setSearchMode('txid')}
            className={`px-3 py-1.5 text-xs rounded-lg transition-colors ${
              searchMode === 'txid' ? 'bg-bitcoin/20 text-bitcoin font-medium' : 'bg-surface-700 text-gray-400'
            }`}
          >
            By Transaction
          </button>
        </div>

        <div className="flex gap-2">
          <input
            type="text"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
            placeholder={searchMode === 'author' ? 'npub, hex pubkey, or NIP-05...' : '64-character txid...'}
            className="input-field flex-1 text-sm"
          />
          <button
            onClick={handleSearch}
            disabled={loading || !searchInput.trim()}
            className="btn-primary px-4 text-sm flex items-center gap-1.5"
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
            Scan
          </button>
        </div>

        {resolvedAddress && (
          <div className="mt-2 p-2 bg-surface-700/50 rounded-lg">
            <span className="text-[10px] text-gray-500 block">Taproot Address</span>
            <p className="text-[11px] font-mono text-gray-300 break-all">{resolvedAddress}</p>
          </div>
        )}

        {error && <p className="text-red-400 text-xs mt-2">{error}</p>}
      </div>

      {/* Results */}
      {allResults.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-2 px-1">
            <span className="text-xs text-gray-400">
              {showingOwn ? 'Your On-Chain Proofs' : `Found ${allResults.length} result${allResults.length !== 1 ? 's' : ''}`}
            </span>
            {showingOwn && (
              <span className="text-[10px] text-gray-500">{ownResults.length} total</span>
            )}
          </div>

          <div className="space-y-2">
            {allResults.map((item, i) => {
              const style = PROTOCOL_STYLES[item.protocol];
              return (
                <div key={`${item.txid}-${i}`} className="card">
                  <div className="flex items-center gap-2 mb-2">
                    <span className={`text-xs font-mono font-bold px-2 py-0.5 rounded-md ${style.color} ${style.bg}`}>
                      {style.icon} {style.label}
                    </span>
                    <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ml-auto ${
                      item.confirmed
                        ? 'bg-green-500/15 text-green-400'
                        : 'bg-yellow-500/15 text-yellow-400'
                    }`}>
                      {item.confirmed ? 'Confirmed' : 'Unconfirmed'}
                    </span>
                  </div>

                  <div className="space-y-1.5">
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] text-gray-500 w-12 flex-shrink-0">
                        {item.protocol === 'NSTR' ? 'Event' : item.protocol === 'NINV' ? 'Invoice' : 'Hash'}
                      </span>
                      <span className="text-xs font-mono text-gray-300 truncate">
                        {item.hash.slice(0, 16)}...{item.hash.slice(-8)}
                      </span>
                      <button onClick={() => copyText(item.hash, `hash-${i}`)} className="p-1 hover:bg-surface-700 rounded flex-shrink-0">
                        {copied === `hash-${i}` ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3 text-gray-500" />}
                      </button>
                    </div>

                    <div className="flex items-center gap-2">
                      <span className="text-[10px] text-gray-500 w-12 flex-shrink-0">Txid</span>
                      <span className="text-xs font-mono text-gray-300 truncate">
                        {item.txid.slice(0, 16)}...{item.txid.slice(-8)}
                      </span>
                      <button onClick={() => copyText(item.txid, `txid-${i}`)} className="p-1 hover:bg-surface-700 rounded flex-shrink-0">
                        {copied === `txid-${i}` ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3 text-gray-500" />}
                      </button>
                    </div>

                    <div className="flex items-center gap-2 text-[10px] text-gray-500">
                      {item.blockHeight && (
                        <span>Block {item.blockHeight.toLocaleString()}</span>
                      )}
                      {item.blockHeight && item.time && <span>·</span>}
                      {item.time && <span>{timeAgo(item.time)}</span>}
                    </div>
                  </div>

                  <div className="flex gap-2 mt-3">
                    {(item.protocol === 'NSTR' || item.protocol === 'LOPS') && (
                      <button
                        onClick={() => {
                          const tab = document.querySelector('[data-tab="verify"]') as HTMLButtonElement;
                          tab?.click();
                        }}
                        className="btn-secondary flex-1 text-xs flex items-center justify-center gap-1.5"
                      >
                        <CheckCircle2 className="w-3.5 h-3.5" />
                        Verify
                      </button>
                    )}
                    <a
                      href={`https://mempool.space/tx/${item.txid}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="btn-secondary flex-1 text-xs flex items-center justify-center gap-1.5"
                    >
                      <ExternalLink className="w-3.5 h-3.5" />
                      Mempool
                    </a>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Empty state for own results */}
      {!loading && results.length === 0 && ownResults.length === 0 && !ownLoading && (
        <div className="flex flex-col items-center justify-center py-12 text-gray-500">
          <Compass className="w-10 h-10 mb-3 opacity-30" />
          <p className="text-sm">No on-chain proofs found yet</p>
          <p className="text-xs mt-1">Search by author or transaction to discover NSTR/NINV/LOPS data</p>
        </div>
      )}

      {ownLoading && results.length === 0 && (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="w-5 h-5 animate-spin text-gray-500 mr-2" />
          <span className="text-sm text-gray-500">Scanning your address...</span>
        </div>
      )}
    </div>
  );
}

// Storage helpers

const STORAGE_PREFIX = 'light_ops_';

async function loadLightOps(pubkey: string): Promise<LightOpEntry[]> {
  try {
    const key = `${STORAGE_PREFIX}${pubkey}`;
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      const result = await chrome.storage.local.get(key);
      return result[key] || [];
    }
    const stored = localStorage.getItem(key);
    return stored ? JSON.parse(stored) : [];
  } catch {
    return [];
  }
}

async function saveLightOp(pubkey: string, entry: LightOpEntry): Promise<void> {
  try {
    const key = `${STORAGE_PREFIX}${pubkey}`;
    const existing = await loadLightOps(pubkey);
    const updated = [...existing, entry];
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      await chrome.storage.local.set({ [key]: updated });
    } else {
      localStorage.setItem(key, JSON.stringify(updated));
    }
  } catch {}
}
