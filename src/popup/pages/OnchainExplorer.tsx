import { useState } from 'react';
import { decodeNostrOpReturn } from '@/lib/bitcoin/opreturn';
import { getMempoolTxUrl } from '@/lib/bitcoin/mempool';
import {
  ArrowLeft, Search, Loader2, ExternalLink,
  AlertCircle, FileText, Bitcoin,
} from 'lucide-react';

interface Props {
  onBack: () => void;
}

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
    block_time?: number;
  };
  vin: TxVin[];
  vout: TxVout[];
}

interface DecodedResult {
  txid: string;
  tx: TxData;
  opReturnHex: string | null;
  nostrData: {
    eventId: string;
    kind: number;
  } | null;
}

const MEMPOOL_API = 'https://mempool.space/api';

function isHexString(s: string): boolean {
  return /^[0-9a-fA-F]+$/.test(s);
}

function isTxid(s: string): boolean {
  return isHexString(s) && s.length === 64;
}

export function OnchainExplorer({ onBack }: Props) {
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<DecodedResult | null>(null);
  const [error, setError] = useState('');

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    const input = query.trim();
    if (!input) return;

    setLoading(true);
    setError('');
    setResult(null);

    try {
      if (isTxid(input)) {
        await searchByTxid(input);
      } else if (isHexString(input) && input.length === 64) {
        await searchByEventId(input);
      } else {
        await searchByText(input);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Search failed');
    } finally {
      setLoading(false);
    }
  }

  async function searchByTxid(txid: string) {
    const res = await fetch(`${MEMPOOL_API}/tx/${txid}`);
    if (!res.ok) {
      throw new Error(`Transaction not found: ${txid.slice(0, 16)}...`);
    }
    const tx: TxData = await res.json();
    processTransaction(tx);
  }

  async function searchByEventId(eventId: string) {
    const res = await fetch(`${MEMPOOL_API}/tx/${eventId}`);
    if (res.ok) {
      const tx: TxData = await res.json();
      processTransaction(tx);
      return;
    }
    throw new Error(
      'Could not find a transaction matching this event ID. ' +
      'Try searching by txid directly.'
    );
  }

  async function searchByText(text: string) {
    const res = await fetch(`${MEMPOOL_API}/address/${text}`);
    if (res.ok) {
      const addrRes = await fetch(`${MEMPOOL_API}/address/${text}/txs`);
      if (addrRes.ok) {
        const txs: TxData[] = await addrRes.json();
        if (txs.length > 0) {
          for (const tx of txs.slice(0, 10)) {
            const opReturn = findOpReturn(tx);
            if (opReturn) {
              processTransaction(tx);
              return;
            }
          }
          processTransaction(txs[0]);
          return;
        }
      }
    }
    throw new Error(
      'No results found. Try entering a valid txid (64 hex characters), ' +
      'event ID, or Bitcoin address.'
    );
  }

  function findOpReturn(tx: TxData): string | null {
    for (const vout of tx.vout) {
      if (vout.scriptpubkey_type === 'op_return' || vout.scriptpubkey.startsWith('6a')) {
        return vout.scriptpubkey;
      }
    }
    return null;
  }

  function processTransaction(tx: TxData) {
    const opReturnHex = findOpReturn(tx);
    let nostrData = null;

    if (opReturnHex) {
      const decoded = decodeNostrOpReturn(opReturnHex);
      if (decoded) {
        nostrData = {
          eventId: decoded.eventId,
          kind: decoded.kind,
        };
      }
    }

    setResult({
      txid: tx.txid,
      tx,
      opReturnHex,
      nostrData,
    });
  }

  function formatSats(sats: number): string {
    if (sats >= 100_000_000) return `${(sats / 100_000_000).toFixed(8)} BTC`;
    if (sats >= 1_000_000) return `${(sats / 1_000_000).toFixed(2)}M sats`;
    if (sats >= 1_000) return `${(sats / 1_000).toFixed(1)}k sats`;
    return `${sats} sats`;
  }

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="page-header px-4">
        <button onClick={onBack} className="btn-back">
          <ArrowLeft className="w-5 h-5" />
        </button>
        <h1>On-Chain Explorer</h1>
      </div>

      {/* Search */}
      <form onSubmit={handleSearch} className="px-4 pb-3">
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="txid, event ID, or address"
              className="input-field !pl-9 !py-2 !min-h-[40px] text-sm"
            />
          </div>
          <button
            type="submit"
            disabled={loading || !query.trim()}
            className="btn-primary !px-3 !py-2 !min-h-[40px] text-sm"
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Search'}
          </button>
        </div>
      </form>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-4 pb-4">
        {/* Loading */}
        {loading && (
          <div className="flex flex-col items-center justify-center py-12">
            <Loader2 className="w-8 h-8 text-bitcoin animate-spin mb-3" />
            <p className="text-sm text-gray-400">Fetching transaction...</p>
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="card border-red-500/20 mb-3">
            <div className="flex items-start gap-2.5">
              <AlertCircle className="w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" />
              <p className="text-sm text-red-300">{error}</p>
            </div>
          </div>
        )}

        {/* Result */}
        {result && (
          <div className="space-y-3">
            {/* Transaction Overview */}
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
                  mempool.space
                  <ExternalLink className="w-3 h-3" />
                </a>
              </div>

              <div className="space-y-2.5">
                <div>
                  <p className="text-[10px] text-gray-500 mb-0.5">TXID</p>
                  <code className="text-[11px] text-gray-300 font-mono break-all">{result.txid}</code>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <p className="text-[10px] text-gray-500 mb-0.5">Status</p>
                    <p className="text-sm text-white">
                      {result.tx.status.confirmed ? (
                        <span className="text-green-400">Confirmed</span>
                      ) : (
                        <span className="text-bitcoin">Unconfirmed</span>
                      )}
                    </p>
                  </div>
                  <div>
                    <p className="text-[10px] text-gray-500 mb-0.5">Fee</p>
                    <p className="text-sm text-white">{formatSats(result.tx.fee)}</p>
                  </div>
                </div>

                {result.tx.status.block_height && (
                  <div>
                    <p className="text-[10px] text-gray-500 mb-0.5">Block Height</p>
                    <p className="text-sm text-white">{result.tx.status.block_height.toLocaleString()}</p>
                  </div>
                )}

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <p className="text-[10px] text-gray-500 mb-0.5">Size</p>
                    <p className="text-sm text-white">{result.tx.size} bytes</p>
                  </div>
                  <div>
                    <p className="text-[10px] text-gray-500 mb-0.5">Weight</p>
                    <p className="text-sm text-white">{result.tx.weight} WU</p>
                  </div>
                </div>
              </div>
            </div>

            {/* Inputs */}
            <div className="card">
              <div className="flex items-center gap-2 mb-2">
                <div className="w-1.5 h-1.5 rounded-full bg-red-400" />
                <span className="text-[10px] text-gray-500 uppercase tracking-wider">
                  Inputs ({result.tx.vin.length})
                </span>
              </div>
              <div className="space-y-2 max-h-32 overflow-y-auto">
                {result.tx.vin.slice(0, 5).map((vin, i) => (
                  <div key={i} className="text-[11px]">
                    <code className="text-gray-400 font-mono break-all">
                      {vin.prevout?.scriptpubkey_address || `${vin.txid.slice(0, 16)}...:${vin.vout}`}
                    </code>
                    {vin.prevout && (
                      <span className="text-gray-500 ml-1">({formatSats(vin.prevout.value)})</span>
                    )}
                  </div>
                ))}
                {result.tx.vin.length > 5 && (
                  <p className="text-[10px] text-gray-500">+{result.tx.vin.length - 5} more inputs</p>
                )}
              </div>
            </div>

            {/* Outputs */}
            <div className="card">
              <div className="flex items-center gap-2 mb-2">
                <div className="w-1.5 h-1.5 rounded-full bg-green-400" />
                <span className="text-[10px] text-gray-500 uppercase tracking-wider">
                  Outputs ({result.tx.vout.length})
                </span>
              </div>
              <div className="space-y-2 max-h-32 overflow-y-auto">
                {result.tx.vout.slice(0, 5).map((vout, i) => (
                  <div key={i} className="text-[11px]">
                    {vout.scriptpubkey_type === 'op_return' || vout.scriptpubkey.startsWith('6a') ? (
                      <span className="text-nostr font-medium">OP_RETURN</span>
                    ) : (
                      <code className="text-gray-400 font-mono break-all">
                        {vout.scriptpubkey_address || vout.scriptpubkey.slice(0, 32) + '...'}
                      </code>
                    )}
                    <span className="text-gray-500 ml-1">({formatSats(vout.value)})</span>
                  </div>
                ))}
                {result.tx.vout.length > 5 && (
                  <p className="text-[10px] text-gray-500">+{result.tx.vout.length - 5} more outputs</p>
                )}
              </div>
            </div>

            {/* OP_RETURN / Nostr Data */}
            {result.opReturnHex && (
              <div className="card border-nostr/20">
                <div className="flex items-center gap-2 mb-3">
                  <div className="w-1.5 h-1.5 rounded-full bg-nostr" />
                  <span className="text-[10px] text-gray-500 uppercase tracking-wider">OP_RETURN Data</span>
                </div>

                <div className="space-y-2.5">
                  <div>
                    <p className="text-[10px] text-gray-500 mb-0.5">Raw Hex</p>
                    <code className="text-[10px] text-gray-400 font-mono break-all block max-h-16 overflow-y-auto">
                      {result.opReturnHex}
                    </code>
                  </div>

                  {result.nostrData ? (
                    <>
                      <div className="border-t border-surface-200/10 pt-2.5">
                        <div className="flex items-center gap-1.5 mb-2">
                          <FileText className="w-3.5 h-3.5 text-nostr" />
                          <span className="text-xs font-medium text-nostr">Nostr Reference Detected</span>
                        </div>

                        <div className="space-y-2">
                          <div>
                            <p className="text-[10px] text-gray-500 mb-0.5">Event ID</p>
                            <code className="text-[11px] text-white font-mono break-all">
                              {result.nostrData.eventId}
                            </code>
                          </div>
                          <div>
                            <p className="text-[10px] text-gray-500 mb-0.5">Kind</p>
                            <p className="text-sm text-white">{result.nostrData.kind}</p>
                          </div>
                        </div>
                      </div>
                    </>
                  ) : (
                    <p className="text-[11px] text-gray-500">
                      No Nostr protocol data found in OP_RETURN
                    </p>
                  )}
                </div>
              </div>
            )}

            {!result.opReturnHex && (
              <div className="card">
                <div className="flex items-center gap-2.5">
                  <FileText className="w-4 h-4 text-gray-500" />
                  <p className="text-sm text-gray-400">
                    No OP_RETURN output found in this transaction
                  </p>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Default State */}
        {!loading && !error && !result && (
          <div className="flex flex-col items-center justify-center py-12">
            <Bitcoin className="w-12 h-12 text-gray-600 mb-3" />
            <p className="text-sm text-gray-400 text-center mb-1">
              Search for Bitcoin transactions
            </p>
            <p className="text-xs text-gray-600 text-center max-w-[240px]">
              Enter a txid to view transaction details and check for embedded Nostr data in OP_RETURN outputs
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
