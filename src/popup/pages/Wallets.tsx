import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Plus, Wallet, Shield, Loader2, ExternalLink,
  Copy, Check, RefreshCw,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { pubkeyToTaprootAddress } from '@/lib/bitcoin/address';
import { fetchBalance, formatSats, getMempoolAddressUrl } from '@/lib/bitcoin/mempool';
import {
  loadMultisigWallets, loadMyMultisigWallets, updateMultisigBalance,
  type ArchivedMultisig,
} from '@/lib/bitcoin/wallet-store';

export function Wallets() {
  const navigate = useNavigate();
  const { publicKey } = useAuth();
  const [balance, setBalance] = useState<number | null>(null);
  const [wallets, setWallets] = useState<ArchivedMultisig[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [copied, setCopied] = useState(false);

  const address = pubkeyToTaprootAddress(publicKey);

  useEffect(() => {
    loadData();
  }, [publicKey]);

  async function loadData() {
    setLoading(true);
    try {
      const [bal, multisigs] = await Promise.allSettled([
        fetchBalance(address),
        loadMyMultisigWallets(publicKey),
      ]);
      if (bal.status === 'fulfilled') setBalance(bal.value.total);
      if (multisigs.status === 'fulfilled') {
        console.log('[Wallets] Found', multisigs.value.length, 'wallets for', publicKey.slice(0, 8));
        setWallets(multisigs.value.sort((a, b) => b.lastActivityAt - a.lastActivityAt));
      } else {
        console.error('[Wallets] Failed to load:', multisigs.reason);
      }
    } catch {} finally {
      setLoading(false);
    }

    refreshMultisigBalances();
  }

  async function refreshMultisigBalances() {
    const all = await loadMyMultisigWallets(publicKey);
    for (const wallet of all) {
      try {
        const bal = await fetchBalance(wallet.wallet.address);
        if (bal.total !== wallet.currentBalance) {
          await updateMultisigBalance(wallet.id, bal.total);
          setWallets((prev) =>
            prev.map((w) => w.id === wallet.id ? { ...w, currentBalance: bal.total } : w)
          );
        }
      } catch {}
    }
  }

  async function handleRefresh() {
    setRefreshing(true);
    await loadData();
    setRefreshing(false);
  }

  async function copyAddress() {
    await navigator.clipboard.writeText(address);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="h-full flex flex-col p-4 md:p-6 pb-20 md:pb-6">
      {/* Header */}
      <div className="flex items-center gap-3 mb-4">
        <h1 className="text-lg font-bold flex-1">Wallets</h1>
        <button
          onClick={handleRefresh}
          disabled={refreshing}
          className="btn-icon"
          title="Refresh"
        >
          <RefreshCw className={`w-4 h-4 text-gray-400 ${refreshing ? 'animate-spin' : ''}`} />
        </button>
        <button
          onClick={() => navigate('/wallets/create')}
          className="btn-icon bg-bitcoin/20 text-bitcoin"
          title="Create Multi-Sig"
        >
          <Plus className="w-5 h-5" />
        </button>
      </div>

      {loading ? (
        <div className="flex-1 flex items-center justify-center">
          <Loader2 className="w-6 h-6 animate-spin text-bitcoin" />
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto space-y-3">
          {/* Personal Taproot wallet */}
          <button
            onClick={() => navigate('/wallets/personal')}
            className="card w-full text-left hover:border-bitcoin/30 transition-colors"
          >
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-bitcoin/15 flex items-center justify-center flex-shrink-0">
                <Wallet className="w-5 h-5 text-bitcoin" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-medium">Personal Wallet</p>
                  <span className="text-[10px] bg-bitcoin/15 text-bitcoin px-1.5 py-0.5 rounded font-mono">
                    Taproot
                  </span>
                </div>
                <p className="text-xs text-gray-500 font-mono truncate">
                  {address.slice(0, 16)}...{address.slice(-6)}
                </p>
              </div>
              <div className="text-right flex-shrink-0">
                <p className={`text-sm font-bold ${balance && balance > 0 ? 'text-bitcoin' : 'text-gray-500'}`}>
                  {balance !== null ? formatSats(balance) : '—'}
                </p>
              </div>
            </div>
          </button>

          {/* Multi-sig wallets */}
          {wallets.length > 0 && (
            <div className="pt-2">
              <p className="text-[10px] text-gray-500 uppercase tracking-wider px-1 mb-2">
                Multi-Sig Wallets ({wallets.length})
              </p>
              <div className="space-y-2">
                {wallets.map((wallet) => (
                  <button
                    key={wallet.id}
                    onClick={() => navigate(`/wallets/${wallet.id}`)}
                    className="card w-full text-left hover:border-bitcoin/30 transition-colors"
                  >
                    <div className="flex items-center gap-3">
                      {/* Key holder avatars */}
                      <div className="flex -space-x-2 flex-shrink-0">
                        {wallet.keyHolders.slice(0, 3).map((holder, i) => (
                          <div key={holder.pubkey} className="relative" style={{ zIndex: 3 - i }}>
                            {holder.profile?.picture ? (
                              <img
                                src={holder.profile.picture}
                                alt=""
                                className="w-8 h-8 rounded-full object-cover border-2 border-surface-800 bg-surface-700"
                              />
                            ) : (
                              <div className="w-8 h-8 rounded-full bg-gradient-to-br from-bitcoin/30 to-nostr/30 border-2 border-surface-800 flex items-center justify-center">
                                <span className="text-[10px] font-bold text-white/70">
                                  {(holder.profile?.displayName || holder.profile?.name || '?').charAt(0)}
                                </span>
                              </div>
                            )}
                          </div>
                        ))}
                        {wallet.keyHolders.length > 3 && (
                          <div className="w-8 h-8 rounded-full bg-surface-700 border-2 border-surface-800 flex items-center justify-center">
                            <span className="text-[10px] text-gray-400">+{wallet.keyHolders.length - 3}</span>
                          </div>
                        )}
                      </div>

                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-medium truncate">{wallet.name}</p>
                          <span className="text-[10px] bg-bitcoin/15 text-bitcoin px-1.5 py-0.5 rounded font-mono">
                            {wallet.wallet.config.threshold}/{wallet.wallet.config.pubkeys.length}
                          </span>
                        </div>
                        <p className="text-xs text-gray-500 font-mono truncate">
                          {wallet.wallet.address.slice(0, 16)}...
                        </p>
                      </div>

                      <div className="text-right flex-shrink-0">
                        <p className={`text-sm font-medium ${wallet.currentBalance > 0 ? 'text-bitcoin' : 'text-gray-500'}`}>
                          {formatSats(wallet.currentBalance)}
                        </p>
                        <p className="text-[10px] text-gray-600">
                          {new Date(wallet.createdAt).toLocaleDateString()}
                        </p>
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Empty state for multisig */}
          {wallets.length === 0 && (
            <div className="flex flex-col items-center justify-center py-8">
              <Shield className="w-10 h-10 text-gray-700 mb-3" />
              <p className="text-sm text-gray-500 mb-1">No multi-sig wallets yet</p>
              <p className="text-xs text-gray-600 mb-4">Create one with your Nostr contacts</p>
              <button
                onClick={() => navigate('/wallets/create')}
                className="btn-primary text-sm px-6"
              >
                Create Multi-Sig
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
