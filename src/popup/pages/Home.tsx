import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Send, Shield, Copy, Check, Wallet, Edit3, Inbox, Fingerprint, Unlock, Blocks, RefreshCw, Zap, Users } from 'lucide-react';
import { loadNwcConnection, getNwcBalance, type LightningChain } from '@/lib/nostr/nwc';
import { streamQuery, relaysForAuthor } from '@/lib/nostr/query';
import { parseZapReceipt } from '@/lib/nostr/zap';
import { safeImageUrl } from '@/lib/utils';
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
  /** Lightning balances in sats; undefined = no wallet connected, null = not answering */
  ln?: Partial<Record<LightningChain, number | null>>;
  updatedAt: number;
}

interface ZapStats { count: number; sats: number; xbt: number; btc: number; last?: number }

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
  const [ln, setLn] = useState<Partial<Record<LightningChain, number | null>>>({});
  const [lnLoading, setLnLoading] = useState(true);
  const [zaps, setZaps] = useState<ZapStats | null>(null);
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
    if (cache.ln) setLn(cache.ln);
  }, []);

  // Lightning balances over NWC, for whichever wallets are connected (XBT and/or BTC)
  const loadLightning = useCallback(async () => {
    setLnLoading(true);
    const out: Partial<Record<LightningChain, number | null>> = {};
    await Promise.all((['xbt', 'btc'] as LightningChain[]).map(async (c) => {
      const conn = await loadNwcConnection(c).catch(() => null);
      if (!conn) return;
      const bal = await getNwcBalance(conn).catch(() => ({ error: 'unreachable' } as { msats?: number; error?: string }));
      out[c] = bal.msats != null ? Math.floor(bal.msats / 1000) : null;
    }));
    setLn(out);
    setLnLoading(false);
    return out;
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

      const lnNow = await loadLightning();
      const cache: DashboardCache = {
        ln: lnNow,
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
  }, [publicKey, btcAddress, balance, loadLightning]);

  // Zaps received: count and sats per chain, from receipts on their relays
  useEffect(() => {
    let stop: (() => void) | null = null;
    let live = true;
    setZaps(null);
    relaysForAuthor(publicKey, { inbox: true }).then((relays) => {
      if (!live) return;
      const t: ZapStats = { count: 0, sats: 0, xbt: 0, btc: 0 };
      const seen = new Set<string>();
      stop = streamQuery({
        relays,
        filters: [{ kinds: [9735], '#p': [publicKey], limit: 500 }],
        timeoutMs: 9000,
        onEvent: (e) => {
          const z = parseZapReceipt(e);
          if (!z || z.recipient !== publicKey || seen.has(z.id)) return;
          seen.add(z.id);
          t.count++; t.sats += z.amountSats; t[z.chain] += z.amountSats;
          t.last = Math.max(t.last ?? 0, z.createdAt);
        },
        onDone: () => { if (live) setZaps({ ...t }); },
      });
    });
    return () => { live = false; stop?.(); };
  }, [publicKey]);

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

  const banner = safeImageUrl(myProfile?.banner || '');
  const fmtLn = (c: LightningChain) => ln[c] === undefined ? null : ln[c] === null ? '—' : formatSats(ln[c] as number);
  const lnConnected = ln.xbt !== undefined || ln.btc !== undefined;
  const ago = (ts?: number) => {
    if (!ts) return '';
    const m = (Date.now() / 1000 - ts) / 60;
    return m < 60 ? `${Math.max(1, Math.round(m))}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
  };

  return (
    // min-h-full, not h-full: with h-full the content overflowed its own box and the last
    // buttons slid under the tab bar on short phones; <main> pads for the bar and home indicator
    <div className="min-h-full flex flex-col p-4 md:p-6 pb-4 md:pb-6">
      {/* Profile hero: their banner behind avatar, name and social stats */}
      <div className="relative -mx-4 -mt-4 md:mx-0 md:mt-0 mb-4 md:rounded-2xl overflow-hidden border-b md:border border-white/10">
        {banner ? (
          <img src={banner} alt="" className="absolute inset-0 w-full h-full object-cover" />
        ) : (
          <div className="absolute inset-0 bg-gradient-to-br from-bitcoin/25 via-nostr/20 to-black" />
        )}
        <div className="absolute inset-0 bg-gradient-to-b from-black/10 via-black/55 to-black/90" />
        <div className="relative px-4 pt-14 pb-4 md:pt-20">
          <div className="flex items-end gap-3">
            {/* the ring sits on a box exactly the avatar's size, so it stays centred on the picture */}
            <div className="relative flex-shrink-0 w-14 h-14 rounded-full ring-2 ring-black/70 shadow-lg shadow-black/50">
              <ClickableAvatar
                key={publicKey}
                pubkey={publicKey}
                picture={myProfile?.picture || accounts[activeAccountIndex]?.picture}
                name={displayName}
                size="2xl"
                className="block w-14 h-14 leading-none"
              />
              <button
                onClick={() => navigate('/settings/profile')}
                aria-label="Edit profile"
                className="absolute -bottom-1 -right-1 w-7 h-7 bg-surface-800 rounded-full flex items-center justify-center z-10 ring-2 ring-black/80 hover:bg-surface-700"
              >
                <Edit3 className="w-3.5 h-3.5 text-white" strokeWidth={2.25} />
              </button>
            </div>
            <div className="flex-1 min-w-0 pb-0.5">
              <p className="text-lg font-semibold truncate drop-shadow">{displayName}</p>
              {myProfile?.nip05 && <p className="text-xs text-gray-300 truncate">{myProfile.nip05.replace(/^_@/, '')}</p>}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-3 text-xs text-gray-300">
            <span className="flex items-center gap-1"><Users className="w-3.5 h-3.5" /><b className="text-white">{following instanceof Set ? following.size : 0}</b> following</span>
            <span className="flex items-center gap-1">
              <Zap className="w-3.5 h-3.5 text-amber-300" />
              {zaps ? <><b className="text-white">{formatSats(zaps.sats)}</b> in {zaps.count} zap{zaps.count === 1 ? '' : 's'}</> : <span className="text-gray-500">zaps…</span>}
            </span>
            <span>{accounts.length} account{accounts.length !== 1 ? 's' : ''}</span>
            {syncing && <span className="text-nostr">syncing</span>}
          </div>
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
        <button
          onClick={() => navigate('/wallets')}
          className="card hover:border-bitcoin/30 transition-colors text-left"
        >
          <div className="flex items-center gap-2 mb-2">
            <div className="w-8 h-8 rounded-lg bg-bitcoin/15 flex items-center justify-center">
              <Wallet className="w-4 h-4 text-bitcoin" />
            </div>
            <span className="text-xs text-gray-500">On-chain</span>
          </div>
          <p className="text-xl font-bold text-bitcoin">
            {balance !== null ? formatSats(balance) : '—'}
          </p>
          <p className="text-[10px] text-gray-500 mt-1">Taproot wallet</p>
        </button>

        <button
          onClick={() => navigate('/lightning')}
          className="card hover:border-amber-400/30 transition-colors text-left"
        >
          <div className="flex items-center gap-2 mb-2">
            <div className="w-8 h-8 rounded-lg bg-amber-400/15 flex items-center justify-center">
              <Zap className="w-4 h-4 text-amber-300" />
            </div>
            <span className="text-xs text-gray-500">Lightning</span>
            {lnLoading && lnConnected && <RefreshCw className="w-3 h-3 text-gray-600 animate-spin ml-auto" />}
          </div>
          {lnConnected ? (
            <div className="space-y-0.5">
              {fmtLn('xbt') !== null && <p className="text-base font-bold text-white leading-tight"><span className="text-[10px] font-medium text-purple-300 mr-1">XBT</span>{fmtLn('xbt')}</p>}
              {fmtLn('btc') !== null && <p className="text-base font-bold text-white leading-tight"><span className="text-[10px] font-medium text-amber-300 mr-1">BTC</span>{fmtLn('btc')}</p>}
            </div>
          ) : (
            <>
              <p className="text-sm font-semibold text-white">{lnLoading ? '…' : 'Not connected'}</p>
              <p className="text-[10px] text-gray-500 mt-1">{lnLoading ? 'Checking wallets' : 'Tap to connect a wallet'}</p>
            </>
          )}
          {lnConnected && zaps && zaps.count > 0 && <p className="text-[10px] text-gray-500 mt-1">last zap {ago(zaps.last)}</p>}
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
