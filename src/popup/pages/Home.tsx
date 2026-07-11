import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Send, Shield, Copy, Check, Wallet, Edit3, Inbox, Fingerprint, Unlock, Blocks, RefreshCw } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { pubkeyToNpub } from '@/lib/nostr/keys';
import { pubkeyToTaprootAddress } from '@/lib/bitcoin/address';
import { fetchBalance, formatSats } from '@/lib/bitcoin/mempool';
import { loadMyMultisigWallets } from '@/lib/bitcoin/wallet-store';
import { loadSigningRounds, type SigningRound } from '@/lib/bitcoin/signing-round';
import { ClickableAvatar } from '@/popup/components/ClickableAvatar';
import { log } from '@/lib/utils/logger';

interface DashboardCache {
  balance: number;
  multisigCount: number;
  multisigTotalSats: number;
  pendingSignatures: number;
  updatedAt: number;
}

function cacheKey(pubkey: string) {
  return `dashboard_cache_${pubkey}`;
}

async function loadDashboardCache(pubkey: string): Promise<DashboardCache | null> {
  const stored = await chrome.storage.local.get(cacheKey(pubkey));
  return stored[cacheKey(pubkey)] ?? null;
}

async function saveDashboardCache(pubkey: string, data: DashboardCache) {
  await chrome.storage.local.set({ [cacheKey(pubkey)]: data });
}

export function Home() {
  const navigate = useNavigate();
  const { publicKey, myProfile, following, accounts, activeAccountIndex } = useAuth();
  const [balance, setBalance] = useState<number | null>(null);
  const [pendingSignatures, setPendingSignatures] = useState(0);
  const [multisigCount, setMultisigCount] = useState(0);
  const [multisigTotalSats, setMultisigTotalSats] = useState(0);
  const [copied, setCopied] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const fetchGenRef = useRef(0);

  const npub = accounts[activeAccountIndex]?.npub || pubkeyToNpub(publicKey);
  const btcAddress = pubkeyToTaprootAddress(publicKey);
  const displayName = myProfile?.displayName || myProfile?.name || accounts[activeAccountIndex]?.displayName || accounts[activeAccountIndex]?.label || 'Anonymous';

  const applyCache = useCallback((cache: DashboardCache) => {
    setBalance(cache.balance);
    setMultisigCount(cache.multisigCount);
    setMultisigTotalSats(cache.multisigTotalSats);
    setPendingSignatures(cache.pendingSignatures);
  }, []);

  const loadDashboardData = useCallback(async (background = false) => {
    const gen = ++fetchGenRef.current;
    if (!background) setRefreshing(true);
    setSyncing(true);

    try {
      // Instant: load wallets from local storage (no network)
      const wallets = await loadMyMultisigWallets(publicKey);
      const walletCount = wallets.length;
      const cachedTotal = wallets.reduce((sum, w) => sum + (w.currentBalance || 0), 0);
      setMultisigCount(walletCount);
      setMultisigTotalSats(cachedTotal);

      const signedRoundsResult = await chrome.storage.local.get(`signed_rounds_${publicKey}`);
      const signedRoundIds: string[] = signedRoundsResult[`signed_rounds_${publicKey}`] ?? [];
      const signedSet = new Set(signedRoundIds);
      const rounds = await loadSigningRounds();
      const pending = rounds.filter(
        (r: SigningRound) => r.status === 'collecting' && !signedSet.has(r.id)
      );
      setPendingSignatures(pending.length);

      // Network: balance fetch in background
      const bal = await fetchBalance(btcAddress);
      if (gen !== fetchGenRef.current) return;

      if (bal.error) {
        log.warn('Dashboard', 'Balance fetch failed:', bal.error);
        if (bal.cached) setBalance(bal.total);
      } else {
        setBalance(bal.total);
      }

      const cache: DashboardCache = {
        balance: bal.error && !bal.cached && balance !== null ? balance : bal.total,
        multisigCount: walletCount,
        multisigTotalSats: cachedTotal,
        pendingSignatures: pending.length,
        updatedAt: Date.now(),
      };
      await saveDashboardCache(publicKey, cache);
      log.info('Dashboard', 'Updated', { balance: cache.balance, wallets: walletCount, pending: pending.length });
    } catch (err) {
      log.error('Dashboard', 'loadDashboardData failed:', err);
    } finally {
      if (gen === fetchGenRef.current) {
        setRefreshing(false);
        setSyncing(false);
      }
    }
  }, [publicKey, btcAddress, balance]);

  useEffect(() => {
    let cancelled = false;

    async function init() {
      const cache = await loadDashboardCache(publicKey);
      if (cache && !cancelled) {
        applyCache(cache);
        log.info('Dashboard', 'Loaded from cache');
      }
      loadDashboardData(true);
    }

    init();
    intervalRef.current = setInterval(() => loadDashboardData(true), 60_000);
    return () => {
      cancelled = true;
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [publicKey, applyCache, loadDashboardData]);

  async function handleManualRefresh() {
    await loadDashboardData(false);
  }

  async function copyToClipboard(text: string, label: string) {
    await navigator.clipboard.writeText(text);
    setCopied(label);
    setTimeout(() => setCopied(''), 2000);
  }

  return (
    <div className="h-full flex flex-col p-4 md:p-6 pb-20 md:pb-6">
      {/* Mobile profile header */}
      <div className="flex items-center gap-3 mb-5 md:mb-6">
        <div className="relative flex-shrink-0">
          <ClickableAvatar
            key={publicKey}
            pubkey={publicKey}
            picture={myProfile?.picture || accounts[activeAccountIndex]?.picture}
            name={displayName}
            size="2xl"
          />
          <button
            onClick={() => navigate('/settings/profile')}
            className="absolute -bottom-0.5 -right-0.5 w-5 h-5 bg-surface-900 rounded-full flex items-center justify-center z-10"
          >
            <Edit3 className="w-3 h-3 text-gray-400" />
          </button>
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-base font-semibold truncate">{displayName}</p>
          <p className="text-xs text-gray-500">
            {following instanceof Set ? following.size : 0} following &bull; {accounts.length} account{accounts.length !== 1 ? 's' : ''}
            {syncing && <span className="text-nostr ml-1">· syncing</span>}
          </p>
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-5">
        <button
          onClick={() => navigate('/wallets')}
          className="card hover:border-bitcoin/30 transition-colors text-left"
        >
          <div className="flex items-center gap-2 mb-2">
            <div className="w-8 h-8 rounded-lg bg-bitcoin/15 flex items-center justify-center">
              <Wallet className="w-4 h-4 text-bitcoin" />
            </div>
            <span className="text-xs text-gray-500">Balance</span>
          </div>
          <p className="text-xl font-bold text-bitcoin">
            {balance !== null ? formatSats(balance) : '—'}
          </p>
          <p className="text-[10px] text-gray-500 mt-1">Taproot wallet</p>
        </button>

        {/* div + role=button instead of <button> so the nested refresh button is valid HTML */}
        <div
          role="button"
          tabIndex={0}
          onClick={() => navigate('/signing')}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); navigate('/signing'); } }}
          className="card hover:border-nostr/30 transition-colors text-left relative cursor-pointer"
        >
          <div className="flex items-center gap-2 mb-2">
            <div className="w-8 h-8 rounded-lg bg-nostr/15 flex items-center justify-center">
              <Inbox className="w-4 h-4 text-nostr" />
            </div>
            <span className="text-xs text-gray-500">Pending</span>
            <button
              onClick={(e) => { e.stopPropagation(); handleManualRefresh(); }}
              className="ml-auto p-1 hover:bg-surface-700 rounded-lg"
              title="Refresh"
            >
              <RefreshCw className={`w-3 h-3 text-gray-500 ${refreshing ? 'animate-spin' : ''}`} />
            </button>
          </div>
          <p className="text-xl font-bold text-white">{pendingSignatures}</p>
          <p className="text-[10px] text-gray-500 mt-1">Signing rounds</p>
        </div>

        <button
          onClick={() => navigate('/wallets')}
          className="card hover:border-green-500/30 transition-colors text-left"
        >
          <div className="flex items-center gap-2 mb-2">
            <div className="w-8 h-8 rounded-lg bg-green-500/15 flex items-center justify-center">
              <Shield className="w-4 h-4 text-green-400" />
            </div>
            <span className="text-xs text-gray-500">Multi-Sig</span>
          </div>
          <p className="text-xl font-bold text-white">{multisigCount}</p>
          <p className="text-[10px] text-gray-500 mt-1">
            {multisigTotalSats > 0 ? formatSats(multisigTotalSats) + ' total' : 'Wallets'}
          </p>
        </button>
      </div>

      {/* Identity cards */}
      <div className="space-y-2 mb-5">
        <div className="card">
          <div className="flex items-center gap-2 mb-1.5">
            <div className="w-1.5 h-1.5 rounded-full bg-nostr" />
            <span className="text-[10px] text-gray-500 uppercase tracking-wider">Nostr</span>
          </div>
          <div className="flex items-center gap-2">
            <code className="text-xs text-gray-300 truncate flex-1 font-mono">
              {npub.slice(0, 22)}...{npub.slice(-6)}
            </code>
            <button onClick={() => copyToClipboard(npub, 'npub')} className="p-1.5 hover:bg-surface-700 rounded-lg">
              {copied === 'npub' ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3 text-gray-500" />}
            </button>
          </div>
        </div>

        <div className="card">
          <div className="flex items-center gap-2 mb-1.5">
            <div className="w-1.5 h-1.5 rounded-full bg-bitcoin" />
            <span className="text-[10px] text-gray-500 uppercase tracking-wider">Bitcoin (Taproot)</span>
          </div>
          <div className="flex items-center gap-2">
            <code className="text-xs text-gray-300 truncate flex-1 font-mono">
              {btcAddress.slice(0, 20)}...{btcAddress.slice(-6)}
            </code>
            <button onClick={() => copyToClipboard(btcAddress, 'btc')} className="p-1.5 hover:bg-surface-700 rounded-lg">
              {copied === 'btc' ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3 text-gray-500" />}
            </button>
          </div>
        </div>
      </div>

      {/* Quick actions */}
      <div className="space-y-2 mt-auto">
        <button
          onClick={() => navigate('/send')}
          className="btn-primary w-full flex items-center justify-center gap-2"
        >
          <Send className="w-4 h-4" />
          Transaction Builder
        </button>

        <div className="grid grid-cols-2 gap-2">
          <button onClick={() => navigate('/wallets/create')} className="btn-secondary flex items-center justify-center gap-1.5 text-sm">
            <Shield className="w-3.5 h-3.5" />
            Create Multi-Sig
          </button>
          <button onClick={() => navigate('/lightops')} className="btn-secondary flex items-center justify-center gap-1.5 text-sm">
            <Fingerprint className="w-3.5 h-3.5" />
            Light OPs
          </button>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <button onClick={() => navigate('/unlocks')} className="btn-secondary flex items-center justify-center gap-1.5 text-sm">
            <Unlock className="w-3.5 h-3.5" />
            Social Unlocks
          </button>
          <button onClick={() => navigate('/explorer')} className="btn-secondary flex items-center justify-center gap-1.5 text-sm">
            <Blocks className="w-3.5 h-3.5" />
            Explorer
          </button>
        </div>
      </div>
    </div>
  );
}
