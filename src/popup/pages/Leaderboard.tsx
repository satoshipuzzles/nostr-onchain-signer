import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Trophy, Search, Loader2, RefreshCw, ExternalLink, Users, Globe } from 'lucide-react';
import { pubkeyToTaprootAddress } from '@/lib/bitcoin/address';
import { fetchBalance, formatSats, getMempoolAddressUrl } from '@/lib/bitcoin/mempool';
import { pubkeyToNpub, npubToPubkey } from '@/lib/nostr/keys';
import { getCachedProfile } from '@/lib/nostr/cache';
import { type ProfileMetadata } from '@/lib/nostr/social';
import { loadRelayList, getReadRelays } from '@/lib/nostr/relays';
import { useAuth } from '../context/AuthContext';

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

type ViewTab = 'following' | 'global';

const DISCOVERY_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.nostr.band',
];

export function Leaderboard() {
  const navigate = useNavigate();
  const { publicKey, following } = useAuth();
  const [entries, setEntries] = useState<LeaderboardEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [processing, setProcessing] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const [error, setError] = useState('');
  const [activeTab, setActiveTab] = useState<ViewTab>('following');
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
    setLoading(true);
    setError('');
    setEntries([]);
    setProcessing('Loading from your following list...');

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
        throw new Error('No following list found. Follow some users first, or switch to Global.');
      }

      const cached = getCachedLeaderboard(CACHE_KEY);
      if (cached) {
        setEntries(cached);
        setLoading(false);
        setProcessing('');
        return;
      }

      await batchCheckBalances(followingPubkeys, signal, CACHE_KEY);
    } catch (err: any) {
      if (err.name !== 'AbortError') {
        setError(err.message || 'Failed to load from following list');
      }
    } finally {
      if (!signal.aborted) {
        setLoading(false);
        setProcessing('');
      }
    }
  }

  async function loadGlobal(signal: AbortSignal) {
    setLoading(true);
    setError('');
    setEntries([]);

    const cached = getCachedLeaderboard(CACHE_KEY_GLOBAL);
    if (cached) {
      setEntries(cached);
      setLoading(false);
      return;
    }

    setProcessing('Discovering users from relays...');

    try {
      // Gather pubkeys from following list + relay discovery in parallel
      let followingPubkeys: string[] = [];
      if (following instanceof Set && following.size > 0) {
        followingPubkeys = Array.from(following);
      }

      const discoveredPubkeys = await discoverUsers(signal);
      if (signal.aborted) return;

      const allPubkeys = new Set([...followingPubkeys, ...discoveredPubkeys]);
      allPubkeys.delete(publicKey);

      setProcessing(`Found ${allPubkeys.size} users. Checking balances...`);
      await batchCheckBalances(Array.from(allPubkeys), signal, CACHE_KEY_GLOBAL);
    } catch (err: any) {
      if (err.name !== 'AbortError') {
        setError(err.message || 'Failed to load global leaderboard');
      }
    } finally {
      if (!signal.aborted) {
        setLoading(false);
        setProcessing('');
      }
    }
  }

  async function batchCheckBalances(
    pubkeys: string[],
    signal: AbortSignal,
    cacheKey: string,
  ) {
    const results: LeaderboardEntry[] = [];
    const batchSize = 5;
    const total = pubkeys.length;

    for (let i = 0; i < total; i += batchSize) {
      if (signal.aborted) return;

      const batch = pubkeys.slice(i, i + batchSize);
      setProcessing(`Checking ${i + 1}/${total} users...`);

      const batchResults = await Promise.allSettled(
        batch.map(async (pubkey) => {
          const taprootAddress = pubkeyToTaprootAddress(pubkey);
          const bal = await fetchBalance(taprootAddress);
          if (bal.total === 0) return null;

          const profile = await getCachedProfile(pubkey);
          return {
            pubkey,
            npub: pubkeyToNpub(pubkey),
            profile: profile || { name: `User ${pubkey.slice(0, 8)}`, pubkey } as ProfileMetadata,
            taprootAddress,
            balance: bal.total,
          };
        })
      );

      for (const r of batchResults) {
        if (r.status === 'fulfilled' && r.value) {
          results.push(r.value);
        }
      }

      if (!signal.aborted) {
        const sorted = [...results].sort((a, b) => b.balance - a.balance);
        setEntries(sorted);
      }
    }

    if (!signal.aborted) {
      const finalSorted = results.sort((a, b) => b.balance - a.balance);
      setEntries(finalSorted);
      cacheLeaderboard(cacheKey, finalSorted);
    }
  }

  const searchNostr = useCallback(async () => {
    if (!searchTerm.trim()) return;

    setProcessing(`Searching for "${searchTerm}"...`);

    try {
      const relayList = await loadRelayList();
      const relays = getReadRelays(relayList);
      const relayUrls = relays.length > 0 ? relays : DISCOVERY_RELAYS;

      const foundProfiles = await searchRelaysForProfiles(relayUrls, searchTerm);
      const results: LeaderboardEntry[] = [];

      for (const profile of foundProfiles) {
        const taprootAddress = pubkeyToTaprootAddress(profile.pubkey);
        const bal = await fetchBalance(taprootAddress);
        results.push({
          pubkey: profile.pubkey,
          npub: pubkeyToNpub(profile.pubkey),
          profile,
          taprootAddress,
          balance: bal.total,
        });
      }

      const existingPubkeys = new Set(entries.map(e => e.pubkey));
      const newEntries = results.filter(r => !existingPubkeys.has(r.pubkey));
      const merged = [...entries, ...newEntries].sort((a, b) => b.balance - a.balance);
      setEntries(merged);
    } catch (err: any) {
      setError(err.message || 'Search failed');
    } finally {
      setProcessing('');
    }
  }, [searchTerm, entries]);

  const filtered = searchTerm
    ? entries.filter(e => {
        const name = (e.profile?.displayName || e.profile?.name || '').toLowerCase();
        const nip05 = (e.profile?.nip05 || '').toLowerCase();
        return name.includes(searchTerm.toLowerCase()) ||
               nip05.includes(searchTerm.toLowerCase()) ||
               e.npub.includes(searchTerm.toLowerCase());
      })
    : entries;

  const nonZeroCount = entries.filter(e => e.balance > 0).length;

  return (
    <div className="h-full flex flex-col p-4 md:p-6">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Trophy className="w-5 h-5 text-bitcoin" />
          <h1 className="text-lg font-bold">Leaderboard</h1>
        </div>
        <button
          onClick={() => loadTab(activeTab)}
          disabled={loading}
          className="p-2 rounded-lg hover:bg-surface-700 text-gray-400 hover:text-white transition-colors"
          title="Refresh"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* Header stat */}
      {nonZeroCount > 0 && (
        <div className="rounded-xl bg-bitcoin/10 border border-bitcoin/20 px-3 py-2 mb-3">
          <p className="text-xs font-medium text-bitcoin">
            {nonZeroCount} user{nonZeroCount !== 1 ? 's' : ''} with Bitcoin on Taproot
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
          filtered.map((entry, idx) => (
            <div
              key={entry.pubkey}
              onClick={() => navigate(`/discover/${entry.pubkey}`)}
              className="flex items-center gap-3 p-3 rounded-xl hover:bg-surface-700 cursor-pointer transition-colors"
            >
              {/* Rank */}
              <div className="w-8 text-center">
                <span className={`text-sm font-bold ${idx < 3 ? 'text-bitcoin' : 'text-gray-500'}`}>
                  #{idx + 1}
                </span>
              </div>

              {/* Avatar */}
              {entry.profile?.picture ? (
                <img
                  src={entry.profile.picture}
                  alt=""
                  className="w-9 h-9 rounded-full object-cover bg-surface-600 flex-shrink-0"
                  onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                />
              ) : (
                <div className="w-9 h-9 rounded-full bg-gradient-to-br from-bitcoin/30 to-nostr/30 flex items-center justify-center flex-shrink-0">
                  <span className="text-xs font-bold text-white/70">
                    {(entry.profile?.name || '?')[0].toUpperCase()}
                  </span>
                </div>
              )}

              {/* User info */}
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">
                  {entry.profile?.displayName || entry.profile?.name || 'Unknown'}
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
          ))
        )}
      </div>
    </div>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────

function npubToHex(npub: string): string | null {
  try {
    return npubToPubkey(npub);
  } catch {
    return null;
  }
}

function getCachedLeaderboard(key: string): LeaderboardEntry[] | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (Date.now() - parsed.timestamp > CACHE_TTL) return null;
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

async function searchRelaysForProfiles(relayUrls: string[], term: string): Promise<(ProfileMetadata & { pubkey: string })[]> {
  const results: (ProfileMetadata & { pubkey: string })[] = [];
  const seen = new Set<string>();
  const lowerTerm = term.toLowerCase();

  const promises = relayUrls.slice(0, 3).map((url) => {
    return new Promise<void>((resolve) => {
      const timeout = setTimeout(() => resolve(), 6000);

      try {
        const ws = new WebSocket(url);
        const subId = `search_${Math.random().toString(36).slice(2, 8)}`;

        ws.onopen = () => {
          ws.send(JSON.stringify(['REQ', subId, { kinds: [0], limit: 100 }]));
        };

        ws.onmessage = (msg) => {
          try {
            const data = JSON.parse(msg.data);
            if (data[0] === 'EVENT' && data[2]) {
              const event = data[2];
              const content = JSON.parse(event.content);
              const name = (content.name || '').toLowerCase();
              const displayName = (content.display_name || content.displayName || '').toLowerCase();
              const nip05 = (content.nip05 || '').toLowerCase();

              if (name.includes(lowerTerm) || displayName.includes(lowerTerm) || nip05.includes(lowerTerm)) {
                if (!seen.has(event.pubkey)) {
                  seen.add(event.pubkey);
                  results.push({
                    pubkey: event.pubkey,
                    name: content.name,
                    displayName: content.display_name || content.displayName,
                    picture: content.picture,
                    banner: content.banner,
                    about: content.about,
                    nip05: content.nip05,
                    lud16: content.lud16,
                  });
                }
              }
            } else if (data[0] === 'EOSE') {
              ws.close();
              clearTimeout(timeout);
              resolve();
            }
          } catch {}
        };

        ws.onerror = () => { clearTimeout(timeout); resolve(); };
        ws.onclose = () => { clearTimeout(timeout); resolve(); };
      } catch {
        clearTimeout(timeout);
        resolve();
      }
    });
  });

  await Promise.allSettled(promises);
  return results.slice(0, 50);
}
