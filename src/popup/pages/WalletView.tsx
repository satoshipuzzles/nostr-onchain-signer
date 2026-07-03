import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, ExternalLink, RefreshCw, Loader2, ArrowUpRight, ArrowDownLeft, Send } from 'lucide-react';
import { pubkeyToTaprootAddress } from '@/lib/bitcoin/address';
import {
  fetchBalance, fetchTransactions, getCachedBalance, getMempoolAddressUrl, getMempoolTxUrl,
  formatSats, type Transaction,
} from '@/lib/bitcoin/mempool';

interface Props {
  publicKey: string;
  onBack: () => void;
}

export function WalletView({ publicKey, onBack }: Props) {
  const navigate = useNavigate();
  const address = pubkeyToTaprootAddress(publicKey);
  const [balance, setBalance] = useState<{ confirmed: number; unconfirmed: number; total: number } | null>(null);
  const [txs, setTxs] = useState<Transaction[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const receiveRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Instant: show cached data
    const cached = getCachedBalance(address);
    if (cached) setBalance(cached);
    loadData(false);
  }, [publicKey]);

  async function loadData(force = false) {
    setSyncing(true);
    setError('');
    try {
      const [bal, transactions] = await Promise.all([
        fetchBalance(address, { force }),
        fetchTransactions(address, 20, { force }),
      ]);
      setBalance(bal);
      setTxs(transactions);
      if (bal.error && !bal.cached) setError(bal.error);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setSyncing(false);
    }
  }

  async function refresh() {
    setRefreshing(true);
    await loadData(true);
    setRefreshing(false);
  }

  function isSent(tx: Transaction): boolean {
    return tx.vin.some((vin) => vin.prevout?.scriptpubkey_address === address);
  }

  function getTxAmount(tx: Transaction): number {
    if (isSent(tx)) {
      const inputSum = tx.vin
        .filter((vin) => vin.prevout?.scriptpubkey_address === address)
        .reduce((sum, vin) => sum + vin.prevout.value, 0);
      const changeBack = tx.vout
        .filter((vout) => vout.scriptpubkey_address === address)
        .reduce((sum, vout) => sum + vout.value, 0);
      return -(inputSum - changeBack);
    }
    return tx.vout
      .filter((vout) => vout.scriptpubkey_address === address)
      .reduce((sum, vout) => sum + vout.value, 0);
  }

  return (
    <div className="h-full flex flex-col p-4 overflow-y-auto">
      <div className="page-header">
        <button onClick={onBack} className="btn-back">
          <ArrowLeft className="w-5 h-5" />
        </button>
        <h1>Wallet</h1>
        <div className="flex items-center gap-2">
          {syncing && <Loader2 className="w-3 h-3 animate-spin text-nostr" />}
          <button onClick={refresh} disabled={refreshing} className="btn-icon">
            <RefreshCw className={`w-4 h-4 text-gray-400 ${refreshing ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      <div className="card text-center mb-4">
        <p className="text-3xl font-bold text-bitcoin mb-1">
          {balance !== null ? formatSats(balance.total) : '—'}
        </p>
        {balance && balance.unconfirmed !== 0 && (
          <p className="text-xs text-yellow-400">+{formatSats(balance.unconfirmed)} unconfirmed</p>
        )}
        {error && <p className="text-[10px] text-yellow-500 mt-1">API limited — showing cached data</p>}
        <div className="flex gap-2 mt-4">
          <button
            onClick={() => navigate('/send')}
            className="btn-primary flex-1 flex items-center justify-center gap-1.5 text-sm py-2"
          >
            <Send className="w-3.5 h-3.5" />
            Send
          </button>
          <button
            onClick={() => receiveRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })}
            className="btn-secondary flex-1 flex items-center justify-center gap-1.5 text-sm py-2"
          >
            <ArrowDownLeft className="w-3.5 h-3.5" />
            Receive
          </button>
        </div>
      </div>

      <div ref={receiveRef} className="card flex flex-col items-center mb-4">
        <div className="w-40 h-40 bg-white rounded-lg p-2 mb-3 flex items-center justify-center">
          <img
            src={`https://api.qrserver.com/v1/create-qr-code/?size=160x160&data=bitcoin:${address}&format=svg`}
            alt="QR Code"
            className="w-full h-full"
          />
        </div>
        <code className="text-[10px] text-gray-400 text-center break-all px-4 leading-relaxed">{address}</code>
        <a href={getMempoolAddressUrl(address)} target="_blank" rel="noopener"
          className="flex items-center gap-1 text-xs text-bitcoin mt-2 hover:underline">
          View on mempool.space <ExternalLink className="w-3 h-3" />
        </a>
      </div>

      <div className="flex items-center justify-between mb-2">
        <h2 className="text-sm font-medium text-gray-400">Transactions</h2>
        <span className="text-xs text-gray-600">{txs.length} found</span>
      </div>

      {txs.length === 0 ? (
        <p className="text-sm text-gray-600 text-center py-6">
          {syncing ? 'Loading transactions...' : 'No transactions yet'}
        </p>
      ) : (
        <div className="space-y-1">
          {txs.map((tx) => {
            const sent = isSent(tx);
            const amount = getTxAmount(tx);
            return (
              <a key={tx.txid} href={getMempoolTxUrl(tx.txid)} target="_blank" rel="noopener"
                className="flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-surface-700/60 transition-colors">
                <div className={`w-8 h-8 rounded-full flex items-center justify-center ${sent ? 'bg-red-500/15' : 'bg-green-500/15'}`}>
                  {sent ? <ArrowUpRight className="w-4 h-4 text-red-400" /> : <ArrowDownLeft className="w-4 h-4 text-green-400" />}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium">{sent ? 'Sent' : 'Received'}</p>
                  <p className="text-[10px] text-gray-500 font-mono truncate">{tx.txid.slice(0, 16)}...</p>
                </div>
                <div className="text-right">
                  <p className={`text-sm font-medium ${sent ? 'text-red-400' : 'text-green-400'}`}>
                    {sent ? '-' : '+'}{formatSats(Math.abs(amount))}
                  </p>
                  <p className="text-[10px] text-gray-600">
                    {tx.status.confirmed ? `Block ${tx.status.block_height}` : 'Pending'}
                  </p>
                </div>
              </a>
            );
          })}
        </div>
      )}
    </div>
  );
}
