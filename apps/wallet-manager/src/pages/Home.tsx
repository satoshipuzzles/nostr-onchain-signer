import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, Eye, ChevronRight, RefreshCw } from 'lucide-react';
import { nip19 } from 'nostr-tools';
import { bytesToHex } from '@noble/hashes/utils';
import { getAccounts, accountAddress, generateAccount, addSigningAccount, addWatchOnlyAccount, type VaultAccount } from '../lib/vault';
import { esplora, formatSats } from '../lib/wallet';
import { loadSettings } from '../lib/storage';

interface Balances {
  [accountId: string]: { confirmed: number; unconfirmed: number; total: number } | { error: string };
}

export function Home() {
  const [accounts, setAccounts] = useState<VaultAccount[]>(getAccounts());
  const [balances, setBalances] = useState<Balances>({});
  const [loading, setLoading] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const network = loadSettings().network;

  async function refresh() {
    setLoading(true);
    const client = esplora();
    const next: Balances = {};
    await Promise.all(
      getAccounts().map(async (acct) => {
        try {
          next[acct.id] = await client.getBalance(accountAddress(acct, network));
        } catch (err) {
          next[acct.id] = { error: err instanceof Error ? err.message : 'offline' };
        }
      })
    );
    setBalances(next);
    setLoading(false);
  }

  useEffect(() => {
    setAccounts(getAccounts());
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const totalSats = Object.values(balances).reduce((sum, b) => ('total' in b ? sum + b.total : sum), 0);

  return (
    <div className="space-y-5">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Wallets</h1>
          <p className="text-stone-400 text-sm">
            {formatSats(totalSats)} total{network === 'testnet' ? ' · testnet' : ''}
          </p>
        </div>
        <div className="flex gap-2">
          <button className="btn-ghost" onClick={refresh} disabled={loading} aria-label="Refresh">
            <RefreshCw size={18} className={loading ? 'animate-spin' : ''} />
          </button>
          <button className="btn-primary" onClick={() => setShowAdd(true)}>
            <Plus size={16} /> Add
          </button>
        </div>
      </header>

      <div className="space-y-3">
        {accounts.length === 0 && (
          <div className="card text-center text-stone-400 text-sm py-10">No wallets yet — add one to get started.</div>
        )}
        {accounts.map((acct) => {
          const bal = balances[acct.id];
          return (
            <Link key={acct.id} to={`/wallet/${acct.id}`} className="card flex items-center gap-3 hover:border-accent transition-colors">
              <div className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 ${acct.watchOnly ? 'bg-stone-700' : 'bg-accent/15'}`}>
                {acct.watchOnly ? <Eye size={18} className="text-stone-300" /> : <span className="text-accent font-bold">₿</span>}
              </div>
              <div className="min-w-0 flex-1">
                <div className="font-semibold text-sm truncate">{acct.label}</div>
                <div className="text-xs text-stone-500 font-mono truncate">{accountAddress(acct, network)}</div>
              </div>
              <div className="text-right shrink-0">
                {bal && 'total' in bal ? (
                  <>
                    <div className="text-sm font-semibold">{formatSats(bal.total)}</div>
                    {bal.unconfirmed !== 0 && <div className="text-xs text-amber-400">{formatSats(bal.unconfirmed)} pending</div>}
                  </>
                ) : bal && 'error' in bal ? (
                  <div className="text-xs text-stone-500">offline</div>
                ) : (
                  <div className="text-xs text-stone-500">…</div>
                )}
              </div>
              <ChevronRight size={16} className="text-stone-600 shrink-0" />
            </Link>
          );
        })}
      </div>

      {showAdd && <AddAccountSheet onClose={() => { setShowAdd(false); setAccounts(getAccounts()); refresh(); }} />}
    </div>
  );
}

function AddAccountSheet({ onClose }: { onClose: () => void }) {
  const [mode, setMode] = useState<'create' | 'import' | 'watch'>('create');
  const [label, setLabel] = useState('');
  const [keyInput, setKeyInput] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      if (mode === 'create') {
        await generateAccount(label || 'New wallet');
      } else if (mode === 'import') {
        let hexKey = keyInput.trim();
        if (hexKey.startsWith('nsec1')) {
          const d = nip19.decode(hexKey);
          if (d.type !== 'nsec') throw new Error('Invalid nsec');
          hexKey = bytesToHex(d.data);
        }
        await addSigningAccount(hexKey, label || 'Imported');
      } else {
        const input = keyInput.trim();
        if (/^(bc1|tb1)/i.test(input)) {
          await addWatchOnlyAccount({ address: input, label: label || 'Watch-only' });
        } else {
          let pk = input;
          if (input.startsWith('npub1')) {
            const d = nip19.decode(input);
            if (d.type !== 'npub') throw new Error('Invalid npub');
            pk = d.data;
          }
          await addWatchOnlyAccount({ pubkeyHex: pk, label: label || 'Watch-only' });
        }
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-end md:items-center justify-center" onClick={onClose}>
      <form onSubmit={submit} className="bg-surface-raised border border-stone-700 rounded-t-3xl md:rounded-2xl w-full max-w-md p-5 space-y-4 safe-bottom" onClick={(e) => e.stopPropagation()}>
        <h2 className="font-bold text-lg">Add wallet</h2>
        <div className="flex gap-2">
          {(['create', 'import', 'watch'] as const).map((m) => (
            <button key={m} type="button" onClick={() => setMode(m)} className={`btn text-xs flex-1 ${mode === m ? 'bg-accent text-stone-950' : 'bg-surface-overlay text-stone-300'}`}>
              {m === 'create' ? 'New' : m === 'import' ? 'Import' : 'Watch'}
            </button>
          ))}
        </div>
        <input className="input" placeholder="Label" value={label} onChange={(e) => setLabel(e.target.value)} />
        {mode !== 'create' && (
          <textarea className="input font-mono text-xs" rows={2} placeholder={mode === 'import' ? 'nsec1… or hex key' : 'npub1…, hex pubkey, or bc1…'} value={keyInput} onChange={(e) => setKeyInput(e.target.value)} />
        )}
        {error && <p className="text-red-400 text-sm">{error}</p>}
        <button type="submit" className="btn-primary w-full" disabled={busy}>{busy ? 'Adding…' : 'Add wallet'}</button>
      </form>
    </div>
  );
}
