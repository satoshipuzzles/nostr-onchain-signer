import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Plus, Wallet, Shield, Loader2, ExternalLink,
  Copy, Check, RefreshCw, Send, ArrowDownLeft,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { pubkeyToTaprootAddress } from '@/lib/bitcoin/address';
import { fetchBalance, formatSats, getCachedBalance } from '@/lib/bitcoin/mempool';
import {
  loadMyMultisigWallets, updateMultisigBalance,
  getPersonalWalletLabel, addressFingerprint,
  type ArchivedMultisig,
} from '@/lib/bitcoin/wallet-store';
import { ClickableAvatar } from '@/popup/components/ClickableAvatar';
import { log } from '@/lib/utils/logger';

export function Wallets() {
  const navigate = useNavigate();
  const { publicKey } = useAuth();
  const [balance, setBalance] = useState<number | null>(null);
  const [wallets, setWallets] = useState<ArchivedMultisig[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [copied, setCopied] = useState(false);
  const [personalLabel, setPersonalLabel] = useState('Personal Wallet');
  const fetchGenRef = useRef(0);

  const address = pubkeyToTaprootAddress(publicKey);

  useEffect(() => {
    loadData();
  }, [publicKey]);

  async function loadData() {
    const gen = ++fetchGenRef.current;
    setLoading(true);

    try {
      // Instant: load wallets from local storage first
      const multisigs = await loadMyMultisigWallets(publicKey);
      setWallets(multisigs.sort((a, b) => b.lastActivityAt - a.lastActivityAt));
      setPersonalLabel(await getPersonalWalletLabel(publicKey));
      log.info('Wallets', 'Loaded', multisigs.length, 'wallets from storage');

      const cachedBal = getCachedBalance(address);
      if (cachedBal) {
        setBalance(cachedBal.total);
      } else {
        setBalance(0);
      }
    } catch (err) {
      log.error('Wallets', 'Storage load failed:', err);
    } finally {
      setLoading(false);
    }

    // Background: fetch live balances without blocking UI
    if (gen === fetchGenRef.current) {
      refreshBalancesInBackground(gen);
    }
  }

  async function refreshBalancesInBackground(gen: number) {
    setSyncing(true);
    try {
      const bal = await fetchBalance(address);
      if (gen !== fetchGenRef.current) return;
      if (bal.total > 0 || !bal.error) {
        setBalance(bal.total);
      } else if (bal.error) {
        log.warn('Wallets', 'Personal balance fetch failed:', bal.error);
      }

      const all = await loadMyMultisigWallets(publicKey);
      // Sequential refresh — global rate limiter handles spacing
      for (const wallet of all) {
        if (gen !== fetchGenRef.current) return;
        try {
          const wbal = await fetchBalance(wallet.wallet.address);
          if (wbal.total !== wallet.currentBalance || wbal.cached) {
            if (!wbal.error || wbal.cached) {
              await updateMultisigBalance(wallet.id, wbal.total);
              setWallets((prev) =>
                prev.map((w) => w.id === wallet.id ? { ...w, currentBalance: wbal.total } : w)
              );
            }
          }
        } catch (err) {
          log.warn('Wallets', `Balance refresh failed for ${wallet.name}:`, err);
        }
      }
    } finally {
      if (gen === fetchGenRef.current) setSyncing(false);
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
      <div className="flex items-center gap-3 mb-4">
        <h1 className="text-lg font-bold flex-1">Wallets</h1>
        {syncing && (
          <span className="text-[10px] text-nostr flex items-center gap-1">
            <Loader2 className="w-3 h-3 animate-spin" /> syncing
          </span>
        )}
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

      {loading && wallets.length === 0 ? (
        <div className="flex-1 flex items-center justify-center">
          <Loader2 className="w-6 h-6 animate-spin text-bitcoin" />
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto space-y-3">
          <div className="card">
            <button
              onClick={() => navigate('/wallets/personal')}
              className="w-full text-left hover:opacity-90 transition-opacity"
            >
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-bitcoin/15 flex items-center justify-center flex-shrink-0">
                  <Wallet className="w-5 h-5 text-bitcoin" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium">{personalLabel}</p>
                    <p className="text-[10px] text-gray-500 font-mono">ID {addressFingerprint(address)}</p>
                    <span className="text-[10px] bg-bitcoin/15 text-bitcoin px-1.5 py-0.5 rounded font-mono">
                      Taproot
                    </span>
                  </div>
                  <p className="text-xs text-gray-500 font-mono truncate">
                    {address.slice(0, 16)}...{address.slice(-6)}
                  </p>
                </div>
                <div className="text-right flex-shrink-0">
                  <p className={`text-sm font-bold ${balance !== null && balance > 0 ? 'text-bitcoin' : 'text-gray-400'}`}>
                    {balance !== null ? formatSats(balance) : '—'}
                  </p>
                </div>
              </div>
            </button>
            <div className="flex gap-2 mt-3 pt-3 border-t border-surface-200/10">
              <button
                onClick={() => navigate('/send')}
                className="btn-primary flex-1 flex items-center justify-center gap-1.5 text-sm py-2"
              >
                <Send className="w-3.5 h-3.5" />
                Send
              </button>
              <button
                onClick={() => navigate('/wallets/personal')}
                className="btn-secondary flex-1 flex items-center justify-center gap-1.5 text-sm py-2"
              >
                <ArrowDownLeft className="w-3.5 h-3.5" />
                Receive
              </button>
            </div>
          </div>

          {wallets.length > 0 && (
            <div className="pt-2">
              <p className="text-[10px] text-gray-500 uppercase tracking-wider px-1 mb-2">
                Multi-Sig Wallets ({wallets.length})
              </p>
              <div className="space-y-2">
                {wallets.map((wallet) => (
                  <div key={wallet.id} className="card hover:border-bitcoin/30 transition-colors">
                    <button
                      onClick={() => navigate(`/wallets/${wallet.id}`)}
                      className="w-full text-left"
                    >
                      <div className="flex items-center gap-3">
                        <div className="flex -space-x-2 flex-shrink-0" onClick={(e) => e.stopPropagation()}>
                          {wallet.keyHolders.slice(0, 3).map((holder, i) => (
                            <div key={holder.pubkey} className="relative" style={{ zIndex: 3 - i }}>
                              <ClickableAvatar
                                pubkey={holder.pubkey}
                                picture={holder.profile?.picture}
                                name={holder.profile?.displayName || holder.profile?.name}
                                size="md"
                                border="border-2 border-surface-800"
                              />
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
                    <div className="flex gap-2 mt-2 pt-2 border-t border-surface-200/10">
                      <button
                        onClick={() => navigate(`/wallets/${wallet.id}`)}
                        className="btn-primary flex-1 text-xs py-1.5 flex items-center justify-center gap-1"
                      >
                        <Send className="w-3 h-3" />
                        Spend
                      </button>
                      <button
                        onClick={() => navigate(`/wallets/${wallet.id}`)}
                        className="btn-secondary flex-1 text-xs py-1.5 flex items-center justify-center gap-1"
                      >
                        <ArrowDownLeft className="w-3 h-3" />
                        Receive
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

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
