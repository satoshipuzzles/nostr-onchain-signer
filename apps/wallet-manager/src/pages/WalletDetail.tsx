import { useEffect, useRef, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { ArrowLeft, Copy, Check, Download, Trash2, Hammer } from 'lucide-react';
import QrCreator from 'qr-creator';
import { trDescriptor, type EsploraUtxo, type EsploraTx } from '@nostr-onchain/core';
import { getAccount, accountAddress, removeAccount } from '../lib/vault';
import { esplora, formatSats } from '../lib/wallet';
import { loadSettings } from '../lib/storage';

export function WalletDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const account = getAccount(id ?? '');
  const network = loadSettings().network;
  const [utxos, setUtxos] = useState<EsploraUtxo[]>([]);
  const [txs, setTxs] = useState<EsploraTx[]>([]);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const qrRef = useRef<HTMLDivElement>(null);

  const address = account ? accountAddress(account, network) : '';

  useEffect(() => {
    if (!account) return;
    const client = esplora();
    client.getUtxos(address).then(setUtxos).catch((e) => setError(e.message));
    client.getTransactions(address).then(setTxs).catch(() => {});
  }, [address, account]);

  useEffect(() => {
    if (qrRef.current && address) {
      qrRef.current.innerHTML = '';
      QrCreator.render(
        { text: address, radius: 0.4, ecLevel: 'M', fill: '#e7e5e4', background: null, size: 180 },
        qrRef.current
      );
    }
  }, [address]);

  if (!account) {
    return (
      <div className="space-y-4">
        <p className="text-stone-400">Wallet not found.</p>
        <Link to="/" className="btn-secondary">Back</Link>
      </div>
    );
  }

  const balance = utxos.reduce((sum, u) => sum + u.value, 0);

  function copy(text: string) {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  function downloadDescriptor() {
    if (!account || account.watchOnly) return;
    const desc = trDescriptor(account.publicKeyHex);
    const blob = new Blob([desc + '\n'], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${account.label.replace(/\s+/g, '-')}.descriptor.txt`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    <div className="space-y-5">
      <header className="flex items-center gap-3">
        <button className="btn-ghost" onClick={() => navigate(-1)} aria-label="Back">
          <ArrowLeft size={18} />
        </button>
        <div className="flex-1 min-w-0">
          <h1 className="text-xl font-bold truncate">{account.label}</h1>
          <p className="text-stone-400 text-sm">
            {formatSats(balance)}
            {account.watchOnly ? ' · watch-only' : ''}
          </p>
        </div>
        <Link to="/send" state={{ accountId: account.id }} className="btn-primary">
          <Hammer size={16} /> Send
        </Link>
      </header>

      {/* Receive */}
      <div className="card text-center space-y-3">
        <div className="text-xs uppercase tracking-wide text-stone-500 font-medium">Receive (taproot)</div>
        <div ref={qrRef} className="flex justify-center" />
        <button onClick={() => copy(address)} className="font-mono text-xs text-stone-300 break-all hover:text-accent transition-colors">
          {address}
          {copied ? <Check size={12} className="inline ml-1 text-green-400" /> : <Copy size={12} className="inline ml-1" />}
        </button>
      </div>

      {/* UTXOs */}
      <section>
        <h2 className="text-sm font-semibold text-stone-300 mb-2">Coins ({utxos.length})</h2>
        {error && <p className="text-red-400 text-xs mb-2">{error}</p>}
        <div className="space-y-2">
          {utxos.map((u) => (
            <div key={`${u.txid}:${u.vout}`} className="card py-3 flex items-center justify-between text-xs">
              <span className="font-mono text-stone-400 truncate mr-3">
                {u.txid.slice(0, 12)}…:{u.vout}
                {!u.status.confirmed && <span className="text-amber-400 ml-2">pending</span>}
              </span>
              <span className="font-semibold shrink-0">{formatSats(u.value)}</span>
            </div>
          ))}
          {utxos.length === 0 && !error && <div className="card text-stone-500 text-sm text-center py-6">No spendable coins</div>}
        </div>
      </section>

      {/* Recent transactions */}
      <section>
        <h2 className="text-sm font-semibold text-stone-300 mb-2">Recent activity</h2>
        <div className="space-y-2">
          {txs.slice(0, 10).map((tx) => {
            const received = tx.vout.filter((v) => v.scriptpubkey_address === address).reduce((s, v) => s + v.value, 0);
            const spent = tx.vin.filter((v) => v.prevout?.scriptpubkey_address === address).reduce((s, v) => s + (v.prevout?.value ?? 0), 0);
            const net = received - spent;
            return (
              <a
                key={tx.txid}
                href={`https://mempool.space/tx/${tx.txid}`}
                target="_blank"
                rel="noreferrer"
                className="card py-3 flex items-center justify-between text-xs hover:border-accent transition-colors"
              >
                <span className="font-mono text-stone-400 truncate mr-3">
                  {tx.txid.slice(0, 16)}…
                  {!tx.status.confirmed && <span className="text-amber-400 ml-2">unconfirmed</span>}
                </span>
                <span className={`font-semibold shrink-0 ${net >= 0 ? 'text-green-400' : 'text-stone-200'}`}>
                  {net >= 0 ? '+' : ''}
                  {formatSats(net)}
                </span>
              </a>
            );
          })}
        </div>
      </section>

      {/* Actions */}
      <section className="flex flex-wrap gap-2">
        {!account.watchOnly && (
          <button className="btn-secondary text-xs" onClick={downloadDescriptor}>
            <Download size={14} /> Export descriptor
          </button>
        )}
        <button
          className="btn-secondary text-xs text-red-400"
          onClick={async () => {
            if (window.confirm(`Remove "${account.label}" from this device? Funds stay on-chain; you need the key to re-add it.`)) {
              await removeAccount(account.id);
              navigate('/');
            }
          }}
        >
          <Trash2 size={14} /> Remove wallet
        </button>
      </section>
    </div>
  );
}
