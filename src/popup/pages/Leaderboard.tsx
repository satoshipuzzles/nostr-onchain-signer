import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Trophy, Search, Loader2, RefreshCw, ExternalLink, Users, Globe, GitFork, ChevronDown, ChevronUp } from 'lucide-react';
import { pubkeyToTaprootAddress } from '@/lib/bitcoin/address';
import { fetchBalance, formatSats, getMempoolAddressUrl } from '@/lib/bitcoin/mempool';
import { type Chain } from '@/lib/bitcoin/chain';
import { pubkeyToNpub } from '@/lib/nostr/keys';
import { getCachedProfile, getAllCachedProfiles, searchProfilesNip50 } from '@/lib/nostr/cache';
import { type ProfileMetadata } from '@/lib/nostr/social';
import { toast } from 'sonner';
import { useAuth } from '../context/AuthContext';
import { useProfilePopup } from '../context/ProfilePopupContext';
import { ClickableAvatar } from '@/popup/components/ClickableAvatar';
import { log } from '@/lib/utils/logger';

interface LeaderboardEntry {
  pubkey: string;
  npub: string;
  profile: ProfileMetadata | null;
  taprootAddress: string;
  /** Sats on the XBT (BLAKE2b) chain. */
  xbt: number;
  /** Sats on the BTC (SHA-256) chain. */
  btc: number;
  /** Sats sitting in outpoints that exist on both chains; null when unknown. */
  unsplitSats: number | null;
}

// v2: dual-chain entries. Old single-chain caches carry a different key and are ignored.
const CACHE_KEY = 'leaderboard_v2_following';
const CACHE_KEY_GLOBAL = 'leaderboard_v2_global';
const RANK_CHAIN_KEY = 'leaderboard_v2_rank_chain';
const MAX_PUBKEYS_GLOBAL = 240;
const MAX_PUBKEYS_FOLLOWING = 80;
const KNOWN_PUBKEYS_KEY = 'leaderboard_known_pubkeys';
const BALANCE_CONCURRENCY = 6;

type ViewTab = 'following' | 'global';

const DISCOVERY_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.nostr.band',
];

const CHAIN_NAME: Record<Chain, string> = { xbt: 'XBT', btc: 'BTC' };

export function Leaderboard() {
  const navigate = useNavigate();
  const { publicKey, following } = useAuth();
  const { openProfile } = useProfilePopup();
  const [entries, setEntries] = useState<LeaderboardEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [processing, setProcessing] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const [error, setError] = useState('');
  const [activeTab, setActiveTab] = useState<ViewTab>('following');
  const [rankChain, setRankChainState] = useState<Chain>(() => loadRankChain());
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  function setRankChain(c: Chain) {
    setRankChainState(c);
    try { localStorage.setItem(RANK_CHAIN_KEY, c); } catch {}
  }

  useEffect(() => {
    loadTab(activeTab);
    return () => { abortRef.current?.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

  function loadTab(tab: ViewTab) {
    abortRef.current?.abort();
    abortRef.current = new AbortController();
    if (tab === 'following') {
      loadFromFollowing(abortRef.current.signal);
    } else {
      loadGlobal(abortRef.current.signal);
    }
  }

  function showCache(key: string): boolean {
    const cached = getCachedLeaderboard(key);
    if (cached && cached.entries.length > 0) {
      setEntries(cached.entries);
      setLastUpdated(cached.timestamp);
      setLoading(false);
      return true;
    }
    setLoading(true);
    return false;
  }

  async function loadFromFollowing(signal: AbortSignal) {
    setError('');
    setSyncing(true);
    showCache(CACHE_KEY);

    try {
      let followingPubkeys: string[] = [];
      if (following instanceof Set && following.size > 0) {
        followingPubkeys = Array.from(following);
      } else {
        const stored = await chrome.storage.local.get(`following_${publicKey}`);
        const raw = stored[`following_${publicKey}`];
        if (Array.isArray(raw) && raw.length > 0) followingPubkeys = raw;
      }

      if (!followingPubkeys.includes(publicKey)) followingPubkeys = [publicKey, ...followingPubkeys];

      setProcessing('Checking balances on XBT and BTC…');
      await batchCheckBalances(followingPubkeys.slice(0, MAX_PUBKEYS_FOLLOWING), signal, CACHE_KEY, publicKey);
    } catch (err: any) {
      if (err.name !== 'AbortError') {
        log.error('Leaderboard', 'Following load failed:', err.message);
        setError(plainError(err.message));
      }
    } finally {
      if (!signal.aborted) {
        setLoading(false);
        setSyncing(false);
        setProcessing('');
      }
    }
  }

  async function loadGlobal(signal: AbortSignal) {
    setError('');
    setSyncing(true);
    showCache(CACHE_KEY_GLOBAL);

    try {
      let followingPubkeys: string[] = [];
      if (following instanceof Set && following.size > 0) followingPubkeys = Array.from(following);

      setProcessing('Finding people…');
      const [trending, discovered, cachedProfiles] = await Promise.all([
        fetchTrendingPubkeys(),
        discoverUsers(signal).catch(() => [] as string[]),
        getAllCachedProfiles(),
      ]);

      const cached = getCachedLeaderboard(CACHE_KEY_GLOBAL);
      const cachedPubkeys = (cached?.entries || []).map((e) => e.pubkey);
      const known = loadKnownPubkeys();

      const allPubkeys = new Set([
        publicKey,
        ...cachedPubkeys,
        ...trending,
        ...followingPubkeys,
        ...discovered,
        ...cachedProfiles.map((p) => p.profile.pubkey),
        ...known,
      ]);
      const toCheck = [publicKey, ...Array.from(allPubkeys).filter((p) => p !== publicKey)].slice(0, MAX_PUBKEYS_GLOBAL);
      saveKnownPubkeys(toCheck);

      setProcessing(`Checking ${toCheck.length} people on XBT and BTC…`);
      await batchCheckBalances(toCheck, signal, CACHE_KEY_GLOBAL, publicKey);
    } catch (err: any) {
      if (err.name !== 'AbortError') {
        log.error('Leaderboard', 'Global load failed:', err.message);
        setError(plainError(err.message));
      }
    } finally {
      if (!signal.aborted) {
        setLoading(false);
        setSyncing(false);
        setProcessing('');
      }
    }
  }

  async function entryFor(pubkey: string, address: string, xbt: number, btc: number, unsplitSats: number | null): Promise<LeaderboardEntry> {
    const profile = await getCachedProfile(pubkey);
    return {
      pubkey,
      npub: pubkeyToNpub(pubkey),
      profile: profile || ({ name: pubkey === publicKey ? 'You' : `User ${pubkey.slice(0, 8)}`, pubkey } as ProfileMetadata),
      taprootAddress: address,
      xbt,
      btc,
      unsplitSats,
    };
  }

  async function batchCheckBalances(pubkeys: string[], signal: AbortSignal, cacheKey: string, selfPubkey: string) {
    // Server scan first: one request per 60 addresses, both chains, no browser rate limits.
    const serverResults = await tryServerScan(pubkeys, signal, (done, total) => {
      setProcessing(`Checked ${done} of ${total} people on XBT and BTC…`);
    });
    if (signal.aborted) return;

    const results: LeaderboardEntry[] = [];
    const seen = new Set<string>();
    for (const r of serverResults) {
      if (seen.has(r.pubkey)) continue;
      seen.add(r.pubkey);
      results.push(await entryFor(r.pubkey, r.address, r.xbt, r.btc, r.unsplitSats));
    }

    // Anyone the server did not answer for (or everyone, if the server failed) is checked here.
    const missing = pubkeys.filter((p) => !seen.has(p));
    const serverFailed = serverResults.length === 0 && pubkeys.length > 0;
    const fallbackList = serverFailed ? missing : missing.filter((p) => p === selfPubkey);
    let checked = 0;
    for (let i = 0; i < fallbackList.length; i += BALANCE_CONCURRENCY) {
      if (signal.aborted) return;
      const batch = fallbackList.slice(i, i + BALANCE_CONCURRENCY);
      if (serverFailed) setProcessing(`Checking ${checked + 1}–${Math.min(checked + batch.length, fallbackList.length)} of ${fallbackList.length} in the browser…`);
      await Promise.allSettled(batch.map(async (pubkey) => {
        if (signal.aborted) return;
        const address = pubkeyToTaprootAddress(pubkey);
        const [x, b] = await Promise.all([
          fetchBalance(address, { chain: 'xbt' }),
          fetchBalance(address, { chain: 'btc' }),
        ]);
        checked++;
        if (x.total === 0 && b.total === 0 && pubkey !== selfPubkey) return;
        if (!seen.has(pubkey)) {
          seen.add(pubkey);
          results.push(await entryFor(pubkey, address, x.total, b.total, null));
          if (!signal.aborted) setEntries(finalizeEntries(results, selfPubkey, rankChain));
        }
      }));
    }

    if (!signal.aborted) {
      const finalSorted = finalizeEntries(results, selfPubkey, rankChain);
      setEntries(finalSorted);
      const now = Date.now();
      setLastUpdated(now);
      cacheLeaderboard(cacheKey, finalSorted, now);
      log.info('Leaderboard', 'Scanned', finalSorted.length, 'entries');
    }
  }

  const searchNostr = useCallback(async () => {
    const term = searchTerm.trim();
    if (!term) return;
    setProcessing(`Searching for "${term}"…`);
    try {
      const foundProfiles = await searchProfilesNip50(term, 20);
      if (foundProfiles.length === 0) {
        toast.info(`Nobody found for "${term}"`);
        return;
      }
      const existing = new Set(entries.map((e) => e.pubkey));
      const fresh = foundProfiles.filter((p) => !existing.has(p.pubkey));
      if (fresh.length === 0) return;
      setProcessing(`Checking ${fresh.length} ${fresh.length === 1 ? 'person' : 'people'} on XBT and BTC…`);
      const scanned = await tryServerScan(fresh.map((p) => p.pubkey), new AbortController().signal);
      const byPubkey = new Map(scanned.map((s) => [s.pubkey, s]));
      const newEntries: LeaderboardEntry[] = [];
      for (const profile of fresh) {
        const address = pubkeyToTaprootAddress(profile.pubkey);
        const s = byPubkey.get(profile.pubkey);
        let xbt = s?.xbt ?? 0, btc = s?.btc ?? 0, unsplit: number | null = s?.unsplitSats ?? null;
        if (!s) {
          const [x, b] = await Promise.all([fetchBalance(address, { chain: 'xbt' }), fetchBalance(address, { chain: 'btc' })]);
          xbt = x.total; btc = b.total; unsplit = null;
        }
        newEntries.push({ pubkey: profile.pubkey, npub: pubkeyToNpub(profile.pubkey), profile, taprootAddress: address, xbt, btc, unsplitSats: unsplit });
      }
      setEntries((prev) => sortEntries([...prev, ...newEntries], rankChain));
    } catch (err: any) {
      setError(plainError(err.message || 'Search failed'));
    } finally {
      setProcessing('');
    }
  }, [searchTerm, entries, rankChain]);

  // ─── Derived view ─────────────────────────────────────────────

  const sorted = sortEntries(entries, rankChain);
  const ranked = sorted.filter((e) => e[rankChain] > 0);
  const rankOf = (pubkey: string) => ranked.findIndex((e) => e.pubkey === pubkey) + 1;

  const term = searchTerm.trim().toLowerCase();
  const visible = term
    ? sorted.filter((e) => {
        const name = (e.profile?.displayName || e.profile?.name || '').toLowerCase();
        const nip05 = (e.profile?.nip05 || '').toLowerCase();
        return name.includes(term) || nip05.includes(term) || e.npub.includes(term);
      })
    : sorted.filter((e) => e.xbt > 0 || e.btc > 0);

  const self = entries.find((e) => e.pubkey === publicKey) || null;
  const totals = ranked.reduce(
    (acc, e) => ({ xbt: acc.xbt + e.xbt, btc: acc.btc + e.btc, people: acc.people + 1 }),
    { xbt: 0, btc: 0, people: 0 },
  );
  const peopleWithCoins = entries.filter((e) => e.xbt > 0 || e.btc > 0).length;
  const scope = activeTab === 'following' ? 'among people you follow' : 'across everyone we scanned';

  return (
    <div className="h-full flex flex-col p-4 md:p-6 pb-20 md:pb-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <button onClick={() => navigate('/')} className="btn-back">
            <ArrowLeft className="w-5 h-5" />
          </button>
          <Trophy className="w-5 h-5 text-bitcoin" />
          <h1 className="text-xl font-bold">Leaderboard</h1>
        </div>
        <div className="flex items-center gap-3">
          {lastUpdated && (
            <span className="text-xs text-gray-500 hidden sm:inline">updated {timeAgo(lastUpdated)}</span>
          )}
          <button
            onClick={() => loadTab(activeTab)}
            disabled={syncing}
            className="p-2 rounded-lg hover:bg-surface-700 text-gray-400 hover:text-white transition-colors"
            title="Refresh"
          >
            <RefreshCw className={`w-4 h-4 ${syncing ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* You */}
      <YouCard
        self={self}
        rank={self ? rankOf(self.pubkey) : 0}
        rankChain={rankChain}
        scope={scope}
        loading={loading && !self}
        onSplit={() => navigate('/send?mode=split&chain=xbt')}
      />

      {/* Rank by + tabs */}
      <div className="flex items-center gap-2 mb-3">
        <div className="flex gap-1 flex-1">
          <TabButton active={activeTab === 'following'} onClick={() => setActiveTab('following')} icon={<Users className="w-4 h-4" />} label="People I follow" />
          <TabButton active={activeTab === 'global'} onClick={() => setActiveTab('global')} icon={<Globe className="w-4 h-4" />} label="Everyone" />
        </div>
        <div className="flex bg-surface-700 rounded-lg p-0.5" title="Rank by">
          {(['xbt', 'btc'] as Chain[]).map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setRankChain(c)}
              className={`px-3 py-1.5 rounded-md text-xs font-bold transition-colors ${
                rankChain === c
                  ? c === 'xbt' ? 'bg-purple-600 text-white' : 'bg-bitcoin text-white'
                  : 'text-gray-400 hover:text-white'
              }`}
            >
              {CHAIN_NAME[c]}
            </button>
          ))}
        </div>
      </div>

      {/* Search */}
      <div className="flex gap-2 mb-3">
        <div className="flex-1 relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
          <input
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && searchNostr()}
            placeholder="Find anyone by name, NIP-05 or npub…"
            className="w-full pl-9 pr-3 py-2.5 bg-surface-700 border border-surface-200/10 rounded-xl text-sm focus:ring-1 focus:ring-bitcoin/50 focus:border-bitcoin/50 outline-none"
          />
        </div>
        <button
          onClick={searchNostr}
          disabled={!searchTerm.trim() || !!processing}
          className="px-4 py-2.5 bg-bitcoin text-white rounded-xl text-sm font-medium disabled:opacity-50 hover:bg-bitcoin/90 transition-colors"
        >
          Search
        </button>
      </div>

      {/* Totals / status */}
      <div className="mb-3 min-h-[20px]">
        {processing || syncing ? (
          <p className="text-sm text-gray-400 flex items-center gap-2">
            <Loader2 className="w-3.5 h-3.5 animate-spin text-nostr" />
            {processing || 'Refreshing…'}
          </p>
        ) : peopleWithCoins > 0 ? (
          <p className="text-sm text-gray-400">
            Across <span className="text-white font-medium">{peopleWithCoins} {peopleWithCoins === 1 ? 'person' : 'people'}</span>:{' '}
            <span className="text-purple-300 font-medium">{formatSats(sorted.reduce((s, e) => s + e.xbt, 0))} XBT</span>
            {' · '}
            <span className="text-bitcoin font-medium">{formatSats(sorted.reduce((s, e) => s + e.btc, 0))} BTC</span>
            {lastUpdated && <span className="sm:hidden"> · updated {timeAgo(lastUpdated)}</span>}
          </p>
        ) : null}
      </div>

      {error && (
        <div className="rounded-xl bg-red-500/10 border border-red-500/20 p-3 mb-3">
          <p className="text-sm text-red-300">{error}</p>
        </div>
      )}

      {/* List */}
      <div className="flex-1 overflow-y-auto space-y-1.5">
        {loading && entries.length === 0 ? (
          <SkeletonRows />
        ) : visible.length === 0 ? (
          <p className="text-center text-gray-500 py-10 text-sm leading-relaxed">
            {term
              ? `Nobody matching "${searchTerm}" yet. Press Search to look them up on Nostr.`
              : activeTab === 'following'
                ? 'Nobody you follow holds coins at their npub address yet.'
                : 'No one with coins found yet. Pull to refresh in a moment.'}
          </p>
        ) : (
          visible.map((entry) => {
            const isSelf = entry.pubkey === publicKey;
            const rank = rankOf(entry.pubkey);
            const isOpen = expanded === entry.pubkey;
            const primary = entry[rankChain];
            const secondaryChain: Chain = rankChain === 'xbt' ? 'btc' : 'xbt';
            const secondary = entry[secondaryChain];
            return (
              <div
                key={entry.pubkey}
                className={`rounded-2xl transition-colors ${isSelf ? 'bg-nostr/10 border border-nostr/20' : 'bg-surface-800/40 hover:bg-surface-700'}`}
              >
                <div
                  onClick={() => openProfile(entry.pubkey)}
                  className="flex items-center gap-3 p-3 cursor-pointer"
                >
                  <RankBadge rank={rank} isSelf={isSelf && primary === 0} />
                  <ClickableAvatar
                    pubkey={entry.pubkey}
                    picture={entry.profile?.picture}
                    name={entry.profile?.displayName || entry.profile?.name}
                    size="lg"
                  />
                  <div className="flex-1 min-w-0">
                    <p className="text-[15px] font-medium truncate">
                      {entry.profile?.displayName || entry.profile?.name || 'Unknown'}
                      {isSelf && <span className="ml-1.5 text-xs text-nostr font-semibold">you</span>}
                    </p>
                    <p className="text-xs text-gray-500 truncate">
                      {entry.profile?.nip05 || `${entry.npub.slice(0, 14)}…`}
                    </p>
                  </div>
                  <div className="text-right flex-shrink-0">
                    <p className={`text-[15px] font-mono font-semibold ${rankChain === 'xbt' ? 'text-purple-300' : 'text-bitcoin'}`}>
                      {formatSats(primary)} <span className="text-xs font-sans font-medium">{CHAIN_NAME[rankChain]}</span>
                    </p>
                    <p className="text-xs text-gray-500 font-mono">
                      {formatSats(secondary)} {CHAIN_NAME[secondaryChain]}
                    </p>
                    {entry.unsplitSats != null && entry.unsplitSats > 0 && (
                      <span className="inline-flex items-center gap-1 mt-1 px-1.5 py-0.5 rounded-md bg-amber-500/15 text-amber-300 text-[10px] font-semibold uppercase tracking-wide">
                        <GitFork className="w-2.5 h-2.5" /> unsplit
                      </span>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); setExpanded(isOpen ? null : entry.pubkey); }}
                    className="p-1.5 rounded-lg text-gray-500 hover:text-white hover:bg-white/10"
                    title="Details"
                  >
                    {isOpen ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                  </button>
                </div>
                {isOpen && (
                  <div className="px-4 pb-3 text-xs text-gray-400 space-y-1.5">
                    <p className="font-mono break-all text-gray-500">{entry.taprootAddress}</p>
                    {entry.unsplitSats != null && entry.unsplitSats > 0 && (
                      <p>
                        {formatSats(entry.unsplitSats)} of these coins exist on both chains. An ordinary spend on one chain moves them on the other too.
                      </p>
                    )}
                    <div className="flex gap-4">
                      {(['xbt', 'btc'] as Chain[]).map((c) => (
                        <a
                          key={c}
                          href={getMempoolAddressUrl(entry.taprootAddress, c)}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          className="inline-flex items-center gap-1 hover:text-white"
                        >
                          <ExternalLink className="w-3 h-3" /> {CHAIN_NAME[c]} explorer
                        </a>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

// ─── Pieces ───────────────────────────────────────────────────────

function YouCard({ self, rank, rankChain, scope, loading, onSplit }: {
  self: LeaderboardEntry | null;
  rank: number;
  rankChain: Chain;
  scope: string;
  loading: boolean;
  onSplit: () => void;
}) {
  if (loading) {
    return <div className="rounded-2xl bg-surface-800/60 border border-white/5 p-4 mb-4 h-24 animate-pulse" />;
  }
  if (!self) return null;
  const held = self[rankChain];
  const unsplit = self.unsplitSats ?? 0;
  let sentence: string;
  if (held > 0 && rank > 0) {
    sentence = `You hold ${formatSats(held)} of ${CHAIN_NAME[rankChain]}, rank #${rank} ${scope}.`;
  } else if (self.xbt > 0 || self.btc > 0) {
    sentence = `You hold no ${CHAIN_NAME[rankChain]} at your npub address, but ${formatSats(rankChain === 'xbt' ? self.btc : self.xbt)} of ${rankChain === 'xbt' ? 'BTC' : 'XBT'}.`;
  } else {
    sentence = 'Your npub address holds no coins yet. Send sats to it to join the board.';
  }
  const splitLine = unsplit > 0
    ? ` ${formatSats(unsplit)} are still unsplit — split them on the Send page.`
    : '';
  return (
    <div className="rounded-2xl bg-nostr/10 border border-nostr/20 p-4 mb-4">
      <div className="flex items-start gap-3">
        <ClickableAvatar pubkey={self.pubkey} picture={self.profile?.picture} name={self.profile?.displayName || self.profile?.name} size="lg" />
        <div className="flex-1 min-w-0">
          <p className="text-[15px] leading-relaxed">{sentence}{splitLine}</p>
          <div className="flex gap-4 mt-2 text-sm font-mono">
            <span className="text-purple-300">{formatSats(self.xbt)} <span className="font-sans text-xs">XBT</span></span>
            <span className="text-bitcoin">{formatSats(self.btc)} <span className="font-sans text-xs">BTC</span></span>
          </div>
        </div>
        {rank > 0 && (
          <div className="text-right flex-shrink-0">
            <p className="text-2xl font-bold text-white">#{rank}</p>
            <p className="text-[10px] text-gray-500 uppercase tracking-wide">{CHAIN_NAME[rankChain]}</p>
          </div>
        )}
      </div>
      {unsplit > 0 && (
        <button type="button" onClick={onSplit} className="btn-secondary w-full mt-3 text-sm flex items-center justify-center gap-2">
          <GitFork className="w-4 h-4" /> Split my coins on XBT
        </button>
      )}
    </div>
  );
}

function RankBadge({ rank, isSelf }: { rank: number; isSelf: boolean }) {
  const medal = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : null;
  return (
    <div className="w-9 text-center flex-shrink-0">
      {medal ? (
        <span className="text-xl leading-none">{medal}</span>
      ) : isSelf ? (
        <span className="text-[10px] font-bold text-nostr">you</span>
      ) : (
        <span className="text-sm font-bold text-gray-500">{rank > 0 ? `#${rank}` : '—'}</span>
      )}
    </div>
  );
}

function TabButton({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return (
    <button
      onClick={onClick}
      className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
        active ? 'bg-white/10 text-white' : 'text-gray-500 hover:text-gray-300'
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

function SkeletonRows() {
  return (
    <div className="space-y-1.5">
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className="flex items-center gap-3 p-3 rounded-2xl bg-surface-800/40 animate-pulse">
          <div className="w-9 h-5 rounded bg-white/5" />
          <div className="w-12 h-12 rounded-full bg-white/5" />
          <div className="flex-1 space-y-2">
            <div className="h-3.5 w-1/2 rounded bg-white/5" />
            <div className="h-3 w-1/3 rounded bg-white/5" />
          </div>
          <div className="space-y-2">
            <div className="h-3.5 w-20 rounded bg-white/5" />
            <div className="h-3 w-14 rounded bg-white/5 ml-auto" />
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────

function sortEntries(entries: LeaderboardEntry[], chain: Chain): LeaderboardEntry[] {
  const other: Chain = chain === 'xbt' ? 'btc' : 'xbt';
  return [...entries].sort((a, b) => b[chain] - a[chain] || b[other] - a[other]);
}

/** Everyone with coins on either chain, ranked; the user is kept even at zero. */
function finalizeEntries(entries: LeaderboardEntry[], selfPubkey: string, chain: Chain): LeaderboardEntry[] {
  const withCoins = entries.filter((e) => e.xbt > 0 || e.btc > 0 || e.pubkey === selfPubkey);
  return sortEntries(withCoins, chain);
}

function plainError(msg: string | undefined): string {
  if (!msg) return 'Something went wrong while loading. Try refreshing in a moment.';
  if (/fetch|network|failed to/i.test(msg)) return 'Could not reach the explorers right now. Try refreshing in a moment.';
  return msg;
}

function timeAgo(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

function loadRankChain(): Chain {
  try {
    const v = localStorage.getItem(RANK_CHAIN_KEY);
    return v === 'btc' ? 'btc' : 'xbt';
  } catch {
    return 'xbt';
  }
}

interface CachedBoard { entries: LeaderboardEntry[]; timestamp: number }

function getCachedLeaderboard(key: string): CachedBoard | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.data)) return null;
    // Only trust entries of the dual-chain shape.
    const entries = (parsed.data as LeaderboardEntry[]).filter((e) => typeof e.xbt === 'number' && typeof e.btc === 'number');
    return { entries, timestamp: parsed.timestamp || 0 };
  } catch {
    return null;
  }
}

function cacheLeaderboard(key: string, entries: LeaderboardEntry[], timestamp: number) {
  try {
    localStorage.setItem(key, JSON.stringify({ data: entries, timestamp }));
  } catch {}
}

function loadKnownPubkeys(): string[] {
  try {
    const raw = localStorage.getItem(KNOWN_PUBKEYS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveKnownPubkeys(pubkeys: string[]) {
  try {
    const existing = new Set(loadKnownPubkeys());
    pubkeys.forEach((p) => existing.add(p));
    localStorage.setItem(KNOWN_PUBKEYS_KEY, JSON.stringify(Array.from(existing).slice(0, 1000)));
  } catch {}
}

async function fetchTrendingPubkeys(): Promise<string[]> {
  try {
    const res = await fetch('/api/leaderboard');
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data.pubkeys) && data.pubkeys.length > 0) return data.pubkeys.slice(0, 200);
    }
  } catch {}
  try {
    const res = await fetch('https://api.nostr.band/v0/trending/notes');
    if (!res.ok) return [];
    const data = await res.json();
    const pubkeys = new Set<string>();
    for (const note of data.notes || []) {
      if (note.event?.pubkey) pubkeys.add(note.event.pubkey);
    }
    return Array.from(pubkeys).slice(0, 200);
  } catch {
    return [];
  }
}

interface ServerEntry { pubkey: string; address: string; xbt: number; btc: number; unsplitSats: number | null; txCount: number }

/** Both-chain scan on the server, 60 addresses per request. Entries with no coins and no history are dropped. */
async function tryServerScan(
  pubkeys: string[],
  signal: AbortSignal,
  onProgress?: (done: number, total: number) => void,
): Promise<ServerEntry[]> {
  const addresses = pubkeys.map((pubkey) => ({ pubkey, address: pubkeyToTaprootAddress(pubkey) }));
  const results: ServerEntry[] = [];
  const BATCH = 60;

  for (let i = 0; i < addresses.length; i += BATCH) {
    if (signal.aborted) break;
    const batch = addresses.slice(i, i + BATCH);
    try {
      const res = await fetch('/api/leaderboard', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ addresses: batch }),
        signal,
      });
      if (res.ok) {
        const data = await res.json();
        for (const entry of data.entries || []) {
          const xbt = Number(entry.xbt) || 0;
          const btc = Number(entry.btc) || 0;
          if (xbt > 0 || btc > 0 || (entry.txCount ?? 0) > 0) {
            results.push({
              pubkey: entry.pubkey,
              address: entry.address,
              xbt,
              btc,
              unsplitSats: typeof entry.unsplitSats === 'number' ? entry.unsplitSats : null,
              txCount: entry.txCount ?? 0,
            });
          }
        }
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') throw err;
      log.warn('Leaderboard', 'Server scan batch failed');
    }
    onProgress?.(Math.min(i + BATCH, addresses.length), addresses.length);
  }
  return results;
}

async function discoverUsers(signal: AbortSignal): Promise<string[]> {
  const pubkeys = new Set<string>();

  const relayPromises = DISCOVERY_RELAYS.map((relayUrl) =>
    new Promise<void>((resolve) => {
      if (signal.aborted) { resolve(); return; }
      let ws: WebSocket;
      const timeout = setTimeout(() => { try { ws?.close(); } catch {} resolve(); }, 10000);
      try {
        ws = new WebSocket(relayUrl);
      } catch {
        clearTimeout(timeout);
        resolve();
        return;
      }
      const subId = `disc_${Math.random().toString(36).slice(2, 8)}`;
      signal.addEventListener('abort', () => { clearTimeout(timeout); ws.close(); resolve(); }, { once: true });
      ws.onopen = () => { ws.send(JSON.stringify(['REQ', subId, { kinds: [1], limit: 500 }])); };
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          if (msg[0] === 'EVENT' && msg[2]?.pubkey) pubkeys.add(msg[2].pubkey);
          if (msg[0] === 'EOSE') { clearTimeout(timeout); ws.close(); resolve(); }
        } catch {}
      };
      ws.onerror = () => { clearTimeout(timeout); resolve(); };
      ws.onclose = () => { clearTimeout(timeout); resolve(); };
    })
  );

  await Promise.allSettled(relayPromises);
  return Array.from(pubkeys);
}
