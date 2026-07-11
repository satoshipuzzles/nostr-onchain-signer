import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Trophy, Search, Loader2, RefreshCw, ExternalLink, Users, Globe } from 'lucide-react';
import { pubkeyToTaprootAddress } from '@/lib/bitcoin/address';
import { fetchBalance, formatSats, getMempoolAddressUrl } from '@/lib/bitcoin/mempool';
import { pubkeyToNpub, npubToPubkey } from '@/lib/nostr/keys';
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
  balance: number;
}

const CACHE_KEY = 'leaderboard_cache';
const CACHE_KEY_GLOBAL = 'leaderboard_cache_global';
const CACHE_TTL = 5 * 60_000; // 5 minutes
const MAX_PUBKEYS_GLOBAL = 300;
const MAX_PUBKEYS_FOLLOWING = 80;
const KNOWN_PUBKEYS_KEY = 'leaderboard_known_pubkeys';
const BALANCE_CONCURRENCY = 8;

type ViewTab = 'following' | 'global';

const DISCOVERY_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.nostr.band',
];

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
  const [activeTab, setActiveTab] = useState<ViewTab>('global');
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    loadTab(activeTab);
    return () => { abortRef.current?.abort(); };
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

  async function loadFromFollowing(signal: AbortSignal) {
    setError('');
    setSyncing(true);

    // Show cache immediately
    const cached = getCachedLeaderboard(CACHE_KEY);
    if (cached && cached.length > 0) {
      setEntries(cached);
      setLoading(false);
    } else {
      setLoading(true);
    }

    try {
      let followingPubkeys: string[] = [];
      if (following instanceof Set && following.size > 0) {
        followingPubkeys = Array.from(following);
      } else {
        const stored = await chrome.storage.local.get(`following_${publicKey}`);
        const raw = stored[`following_${publicKey}`];
        if (Array.isArray(raw) && raw.length > 0) {
          followingPubkeys = raw;
        }
      }

      if (followingPubkeys.length === 0) {
        followingPubkeys = [publicKey];
      } else if (!followingPubkeys.includes(publicKey)) {
        followingPubkeys = [publicKey, ...followingPubkeys];
      }

      setProcessing('Checking balances...');
      await batchCheckBalances(followingPubkeys.slice(0, MAX_PUBKEYS_FOLLOWING), signal, CACHE_KEY, publicKey);
    } catch (err: any) {
      if (err.name !== 'AbortError') {
        log.error('Leaderboard', 'Following load failed:', err.message);
        setError(err.message || 'Failed to load from following list');
      }
    } finally {
      setLoading(false);
      setSyncing(false);
      setProcessing('');
    }
  }

  async function loadGlobal(signal: AbortSignal) {
    setError('');

    // Always show stale cache first for instant UX
    const cached = getCachedLeaderboard(CACHE_KEY_GLOBAL);
    if (cached && cached.length > 0) {
      setEntries(cached);
      setLoading(false);
      log.info('Leaderboard', 'Showing cached global data:', cached.length, 'entries');
    } else {
      setLoading(true);
    }
    setSyncing(true);

    try {
      let followingPubkeys: string[] = [];
      if (following instanceof Set && following.size > 0) {
        followingPubkeys = Array.from(following);
      }

      setProcessing('Discovering users...');
      const [trending, discovered, cachedProfiles] = await Promise.all([
        fetchTrendingPubkeys(),
        discoverUsers(signal).catch(() => [] as string[]),
        getAllCachedProfiles(),
      ]);

      const cached = getCachedLeaderboard(CACHE_KEY_GLOBAL);
      const cachedPubkeys = (cached || []).map((e) => e.pubkey);
      const known = loadKnownPubkeys();

      const allPubkeys = new Set([
        publicKey,
        ...trending,
        ...discovered,
        ...followingPubkeys,
        ...cachedProfiles.map((p) => p.profile.pubkey),
        ...known,
        ...cachedPubkeys,
      ]);
      const toCheck = [publicKey, ...Array.from(allPubkeys).filter((p) => p !== publicKey)].slice(0, MAX_PUBKEYS_GLOBAL);
      saveKnownPubkeys(toCheck);

      if (toCheck.length === 0) {
        throw new Error('No users found yet. Try again in a moment.');
      }

      setProcessing(`Scanning ${toCheck.length} users...`);
      log.info('Leaderboard', `Scanning ${toCheck.length} global users`);
      await batchCheckBalances(toCheck, signal, CACHE_KEY_GLOBAL, publicKey);
    } catch (err: any) {
      if (err.name !== 'AbortError') {
        log.error('Leaderboard', 'Global load failed:', err.message);
        setError(err.message || 'Failed to load global leaderboard');
      }
    } finally {
      setLoading(false);
      setSyncing(false);
      setProcessing('');
    }
  }

  async function batchCheckBalances(
    pubkeys: string[],
    signal: AbortSignal,
    cacheKey: string,
    selfPubkey: string,
  ) {
    // Try server-side scan first (fast, no browser rate limits)
    const serverResults = await tryServerScan(pubkeys, signal);
    if (!signal.aborted && serverResults.length > 0) {
      const results: LeaderboardEntry[] = [];
      for (const r of serverResults) {
        const profile = await getCachedProfile(r.pubkey);
        results.push({
          pubkey: r.pubkey,
          npub: pubkeyToNpub(r.pubkey),
          profile: profile || { name: `User ${r.pubkey.slice(0, 8)}`, pubkey: r.pubkey } as ProfileMetadata,
          taprootAddress: r.address,
          balance: r.balance,
        });
      }

      if (!results.some((r) => r.pubkey === selfPubkey)) {
        const taprootAddress = pubkeyToTaprootAddress(selfPubkey);
        const bal = await fetchBalance(taprootAddress);
        const profile = await getCachedProfile(selfPubkey);
        results.push({
          pubkey: selfPubkey,
          npub: pubkeyToNpub(selfPubkey),
          profile: profile || { name: `You`, pubkey: selfPubkey } as ProfileMetadata,
          taprootAddress,
          balance: bal.total,
        });
      }

      const sorted = finalizeLeaderboardEntries(results, selfPubkey);
      setEntries(sorted);
      cacheLeaderboard(cacheKey, sorted);
      log.info('Leaderboard', 'Server scan:', sorted.length, 'entries');
      return;
    }

    // Fallback: client-side balance checks
    const results: LeaderboardEntry[] = [];
    const seen = new Set<string>();
    let checked = 0;

    for (let i = 0; i < pubkeys.length; i += BALANCE_CONCURRENCY) {
      if (signal.aborted) return;

      const batch = pubkeys.slice(i, i + BALANCE_CONCURRENCY);
      setProcessing(`Checking ${checked + 1}–${Math.min(checked + batch.length, pubkeys.length)} of ${pubkeys.length}...`);

      await Promise.allSettled(
        batch.map(async (pubkey) => {
          if (signal.aborted) return;
          const taprootAddress = pubkeyToTaprootAddress(pubkey);
          const bal = await fetchBalance(taprootAddress);
          checked++;
          if (bal.error) {
            log.warn('Leaderboard', `Balance error for ${pubkey.slice(0, 8)}:`, bal.error);
          }
          if (bal.total === 0 && !bal.cached && pubkey !== selfPubkey) return;

          const profile = await getCachedProfile(pubkey);
          const entry: LeaderboardEntry = {
            pubkey,
            npub: pubkeyToNpub(pubkey),
            profile: profile || { name: `User ${pubkey.slice(0, 8)}`, pubkey } as ProfileMetadata,
            taprootAddress,
            balance: bal.total,
          };

          if (!signal.aborted && !seen.has(pubkey)) {
            seen.add(pubkey);
            results.push(entry);
            const sorted = finalizeLeaderboardEntries(results, selfPubkey);
            setEntries(sorted);
          }
        })
      );
    }

    if (!signal.aborted) {
      const finalSorted = finalizeLeaderboardEntries(results, selfPubkey);
      setEntries(finalSorted);
      cacheLeaderboard(cacheKey, finalSorted);
      log.info('Leaderboard', 'Cached', finalSorted.length, 'entries');
    }
  }

  const searchNostr = useCallback(async () => {
    if (!searchTerm.trim()) return;

    setProcessing(`Searching for "${searchTerm}"...`);

    try {
      // Same NIP-50 search as Discover — finds anyone by name/nip05/npub
      const foundProfiles = await searchProfilesNip50(searchTerm, 20);
      const results: LeaderboardEntry[] = [];

      await Promise.allSettled(foundProfiles.map(async (profile) => {
        const taprootAddress = pubkeyToTaprootAddress(profile.pubkey);
        const bal = await fetchBalance(taprootAddress);
        results.push({
          pubkey: profile.pubkey,
          npub: pubkeyToNpub(profile.pubkey),
          profile,
          taprootAddress,
          balance: bal.total,
        });
      }));

      const existingPubkeys = new Set(entries.map(e => e.pubkey));
      const newEntries = results.filter(r => !existingPubkeys.has(r.pubkey));
      const merged = [...entries, ...newEntries].sort((a, b) => b.balance - a.balance);
      setEntries(merged);
      if (results.length === 0) {
        toast.info(`No users found for "${searchTerm}"`);
      }
    } catch (err: any) {
      setError(err.message || 'Search failed');
    } finally {
      setProcessing('');
    }
  }, [searchTerm, entries]);

  // When searching, show matched users even with 0 balance so anyone is findable
  const filtered = searchTerm
    ? entries.filter(e => {
        const name = (e.profile?.displayName || e.profile?.name || '').toLowerCase();
        const nip05 = (e.profile?.nip05 || '').toLowerCase();
        return name.includes(searchTerm.toLowerCase()) ||
               nip05.includes(searchTerm.toLowerCase()) ||
               e.npub.includes(searchTerm.toLowerCase());
      })
    : entries.filter((e) => e.balance > 0 || e.pubkey === publicKey);

  const nonZeroCount = entries.filter(e => e.balance > 0).length;

  return (
    <div className="h-full flex flex-col p-4 md:p-6 pb-20 md:pb-6">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <button onClick={() => navigate('/')} className="btn-back">
            <ArrowLeft className="w-5 h-5" />
          </button>
          <Trophy className="w-5 h-5 text-bitcoin" />
          <h1 className="text-lg font-bold">Leaderboard</h1>
        </div>
        <button
          onClick={() => loadTab(activeTab)}
          disabled={syncing}
          className="p-2 rounded-lg hover:bg-surface-700 text-gray-400 hover:text-white transition-colors"
          title="Refresh"
        >
          <RefreshCw className={`w-4 h-4 ${syncing ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* Status bar */}
      {(processing || syncing) && (
        <div className="rounded-xl bg-nostr/10 border border-nostr/20 px-3 py-2 mb-3 flex items-center gap-2">
          <Loader2 className="w-3 h-3 animate-spin text-nostr flex-shrink-0" />
          <p className="text-xs text-nostr">{processing || 'Syncing...'}</p>
        </div>
      )}

      {/* Live counter */}
      {nonZeroCount > 0 && (
        <div className="rounded-xl bg-bitcoin/10 border border-bitcoin/20 px-3 py-2 mb-3 flex items-center gap-2">
          <p className="text-xs font-medium text-bitcoin">
            {nonZeroCount} user{nonZeroCount !== 1 ? 's' : ''} with Bitcoin
          </p>
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1 mb-3">
        <button
          onClick={() => setActiveTab('following')}
          className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium transition-colors ${
            activeTab === 'following'
              ? 'bg-white/10 text-white'
              : 'text-gray-500 hover:text-gray-300'
          }`}
        >
          <Users className="w-3.5 h-3.5" />
          My Network
        </button>
        <button
          onClick={() => setActiveTab('global')}
          className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium transition-colors ${
            activeTab === 'global'
              ? 'bg-white/10 text-white'
              : 'text-gray-500 hover:text-gray-300'
          }`}
        >
          <Globe className="w-3.5 h-3.5" />
          Global
        </button>
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
            placeholder="Search by name or npub..."
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

      {/* Status */}
      {processing && (
        <div className="flex items-center gap-2 text-xs text-gray-400 mb-3">
          <Loader2 className="w-3 h-3 animate-spin" />
          {processing}
        </div>
      )}
      {error && (
        <div className="rounded-lg bg-red-500/10 border border-red-500/20 p-3 mb-3">
          <p className="text-xs text-red-400">{error}</p>
          <p className="text-[10px] text-gray-500 mt-1">
            Try refreshing or search for users directly by npub.
          </p>
        </div>
      )}

      {/* Leaderboard list */}
      <div className="flex-1 overflow-y-auto space-y-1">
        {loading && entries.length === 0 ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-6 h-6 animate-spin text-bitcoin" />
          </div>
        ) : filtered.length === 0 ? (
          <p className="text-center text-gray-500 py-8 text-sm">
            {activeTab === 'following'
              ? 'No users with balance found in your network'
              : 'No users found'}
          </p>
        ) : (
          filtered.map((entry, idx) => {
            const isSelf = entry.pubkey === publicKey;
            const rank = entries
              .filter((e) => e.balance > 0)
              .sort((a, b) => b.balance - a.balance)
              .findIndex((e) => e.pubkey === entry.pubkey) + 1;

            return (
            <div
              key={entry.pubkey}
              onClick={() => openProfile(entry.pubkey)}
              className={`flex items-center gap-3 p-3 rounded-xl hover:bg-surface-700 cursor-pointer transition-colors ${
                isSelf ? 'bg-nostr/10 border border-nostr/20' : ''
              }`}
            >
              {/* Rank */}
              <div className="w-8 text-center">
                {isSelf && entry.balance === 0 ? (
                  <span className="text-[10px] font-bold text-nostr">You</span>
                ) : (
                  <span className={`text-sm font-bold ${rank > 0 && rank <= 3 ? 'text-bitcoin' : 'text-gray-500'}`}>
                    {rank > 0 ? `#${rank}` : '—'}
                  </span>
                )}
              </div>

              {/* Avatar */}
              <ClickableAvatar
                pubkey={entry.pubkey}
                picture={entry.profile?.picture}
                name={entry.profile?.displayName || entry.profile?.name}
                size="lg"
              />

              {/* User info */}
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">
                  {entry.profile?.displayName || entry.profile?.name || 'Unknown'}
                  {isSelf && <span className="ml-1.5 text-[10px] text-nostr font-semibold">(You)</span>}
                </p>
                {entry.profile?.nip05 && (
                  <p className="text-[10px] text-gray-500 truncate">{entry.profile.nip05}</p>
                )}
              </div>

              {/* Balance */}
              <div className="text-right flex-shrink-0">
                <p className="text-sm font-mono font-medium text-bitcoin">
                  {formatSats(entry.balance)}
                </p>
                <a
                  href={getMempoolAddressUrl(entry.taprootAddress)}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  className="text-[10px] text-gray-500 hover:text-bitcoin flex items-center gap-0.5 justify-end"
                >
                  <ExternalLink className="w-2.5 h-2.5" />
                  mempool
                </a>
              </div>
            </div>
            );
          })
        )}
      </div>
    </div>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────

function finalizeLeaderboardEntries(
  entries: LeaderboardEntry[],
  selfPubkey: string,
): LeaderboardEntry[] {
  const ranked = entries
    .filter((e) => e.balance > 0)
    .sort((a, b) => b.balance - a.balance);
  const self = entries.find((e) => e.pubkey === selfPubkey);
  if (!self || self.balance > 0 || ranked.some((e) => e.pubkey === selfPubkey)) {
    return ranked;
  }
  return [...ranked, self];
}

function npubToHex(npub: string): string | null {
  try {
    return npubToPubkey(npub);
  } catch {
    return null;
  }
}

function getCachedLeaderboard(key: string, allowStale = true): LeaderboardEntry[] | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!allowStale && Date.now() - parsed.timestamp > CACHE_TTL) return null;
    return parsed.data;
  } catch {
    return null;
  }
}

function cacheLeaderboard(key: string, entries: LeaderboardEntry[]) {
  try {
    localStorage.setItem(key, JSON.stringify({ data: entries, timestamp: Date.now() }));
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
      if (Array.isArray(data.pubkeys) && data.pubkeys.length > 0) {
        return data.pubkeys.slice(0, 200);
      }
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

async function tryServerScan(
  pubkeys: string[],
  signal: AbortSignal,
): Promise<{ pubkey: string; balance: number; address: string }[]> {
  const addresses = pubkeys.map((pubkey) => ({
    pubkey,
    address: pubkeyToTaprootAddress(pubkey),
  }));

  const results: { pubkey: string; balance: number; address: string }[] = [];

  for (let i = 0; i < addresses.length; i += 100) {
    if (signal.aborted) break;
    const batch = addresses.slice(i, i + 100);
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
          if (entry.balance > 0 || (entry.txCount ?? 0) > 0) {
            results.push({
              pubkey: entry.pubkey,
              balance: entry.balance ?? 0,
              address: entry.address,
            });
          }
        }
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') throw err;
      log.warn('Leaderboard', 'Server scan batch failed');
    }
  }

  return results;
}

async function discoverUsers(signal: AbortSignal): Promise<string[]> {
  const pubkeys = new Set<string>();

  const relayPromises = DISCOVERY_RELAYS.map((relayUrl) =>
    new Promise<void>((resolve) => {
      if (signal.aborted) { resolve(); return; }

      const timeout = setTimeout(() => { ws.close(); resolve(); }, 10000);

      let ws: WebSocket;
      try {
        ws = new WebSocket(relayUrl);
      } catch {
        clearTimeout(timeout);
        resolve();
        return;
      }

      const subId = `disc_${Math.random().toString(36).slice(2, 8)}`;

      signal.addEventListener('abort', () => {
        clearTimeout(timeout);
        ws.close();
        resolve();
      }, { once: true });

      ws.onopen = () => {
        ws.send(JSON.stringify(['REQ', subId, { kinds: [1], limit: 500 }]));
      };

      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          if (msg[0] === 'EVENT' && msg[2]?.pubkey) {
            pubkeys.add(msg[2].pubkey);
          }
          if (msg[0] === 'EOSE') {
            clearTimeout(timeout);
            ws.close();
            resolve();
          }
        } catch {}
      };

      ws.onerror = () => { clearTimeout(timeout); resolve(); };
      ws.onclose = () => { clearTimeout(timeout); resolve(); };
    })
  );

  await Promise.allSettled(relayPromises);
  return Array.from(pubkeys);
}

