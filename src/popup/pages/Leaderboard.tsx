import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Trophy, Search, Loader2, RefreshCw, ExternalLink, Users } from 'lucide-react';
import { pubkeyToTaprootAddress } from '@/lib/bitcoin/address';
import { fetchBalance, formatSats, getMempoolAddressUrl } from '@/lib/bitcoin/mempool';
import { pubkeyToNpub, npubToPubkey } from '@/lib/nostr/keys';
import { getCachedProfile } from '@/lib/nostr/cache';
import { type ProfileMetadata } from '@/lib/nostr/social';
import { loadRelayList, getReadRelays } from '@/lib/nostr/relays';

interface LeaderboardEntry {
  pubkey: string;
  npub: string;
  profile: ProfileMetadata | null;
  taprootAddress: string;
  balance: number;
}

const CORNY_CHAT_API = 'https://cornychat.com/_/pantry/api/v1/users/active';
const CORS_PROXY = 'https://corsproxy.io/?';
const CACHE_KEY = 'leaderboard_cache';
const CACHE_TTL = 5 * 60_000; // 5 minutes

type DataSource = 'cornchat' | 'following';

export function Leaderboard() {
  const navigate = useNavigate();
  const [entries, setEntries] = useState<LeaderboardEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [processing, setProcessing] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const [error, setError] = useState('');
  const [dataSource, setDataSource] = useState<DataSource>('cornchat');

  useEffect(() => {
    loadLeaderboard();
  }, []);

  async function fetchWithCorsProxy(url: string, signal: AbortSignal): Promise<Response> {
    try {
      const res = await fetch(url, { signal });
      if (res.ok) return res;
      throw new Error(`HTTP ${res.status}`);
    } catch (directErr: any) {
      if (directErr.name === 'AbortError') throw directErr;
      const proxyRes = await fetch(`${CORS_PROXY}${encodeURIComponent(url)}`, { signal });
      if (!proxyRes.ok) throw new Error(`Proxy also failed: HTTP ${proxyRes.status}`);
      return proxyRes;
    }
  }

  async function loadLeaderboard() {
    setLoading(true);
    setError('');

    const cached = getCachedLeaderboard();
    if (cached) {
      setEntries(cached);
      setLoading(false);
      return;
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      let res: Response;
      try {
        res = await fetchWithCorsProxy(CORNY_CHAT_API, controller.signal);
      } catch (err: any) {
        clearTimeout(timeout);
        if (err.name === 'AbortError') {
          throw new Error('Request timed out — CornChat API may be unavailable');
        }
        throw new Error('Network error — unable to reach CornChat API (direct + CORS proxy failed)');
      }
      clearTimeout(timeout);

      const data = await res.json();

      if (!data?.users || !Array.isArray(data.users)) {
        throw new Error('Unexpected API response');
      }

      const users = data.users.filter(
        (u: { npub?: string }) => u.npub && u.npub.startsWith('npub1')
      );

      setProcessing(`Processing ${users.length} users...`);
      setDataSource('cornchat');

      const results: LeaderboardEntry[] = [];
      const batchSize = 5;

      for (let i = 0; i < users.length; i += batchSize) {
        const batch = users.slice(i, i + batchSize);
        setProcessing(`Processing ${i + 1}-${Math.min(i + batchSize, users.length)} of ${users.length}...`);

        const batchResults = await Promise.allSettled(
          batch.map(async (user: { npub: string; name?: string }) => {
            const pubkey = npubToHex(user.npub);
            if (!pubkey) return null;

            const taprootAddress = pubkeyToTaprootAddress(pubkey);
            const bal = await fetchBalance(taprootAddress);
            const profile = await getCachedProfile(pubkey);

            return {
              pubkey,
              npub: user.npub,
              profile: profile || { name: user.name || `User ${pubkey.slice(0, 8)}` } as ProfileMetadata,
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

        const sorted = [...results].sort((a, b) => b.balance - a.balance);
        setEntries(sorted);
      }

      const finalSorted = results.sort((a, b) => b.balance - a.balance);
      setEntries(finalSorted);
      cacheLeaderboard(finalSorted);
    } catch (err: any) {
      setError(err.message || 'Failed to load leaderboard');
    } finally {
      setLoading(false);
      setProcessing('');
    }
  }

  async function loadFromFollowing() {
    setLoading(true);
    setError('');
    setDataSource('following');
    setProcessing('Loading from your following list...');

    try {
      const relayList = await loadRelayList();
      const relays = getReadRelays(relayList);
      const relayUrls = relays.length > 0
        ? relays
        : ['wss://relay.damus.io', 'wss://nos.lol'];

      const followingPubkeys = await fetchFollowingList(relayUrls);

      if (followingPubkeys.length === 0) {
        throw new Error('No following list found. Log in and follow some users first.');
      }

      const results: LeaderboardEntry[] = [];
      const batchSize = 5;
      const maxUsers = Math.min(followingPubkeys.length, 50);

      for (let i = 0; i < maxUsers; i += batchSize) {
        const batch = followingPubkeys.slice(i, i + batchSize);
        setProcessing(`Checking balances ${i + 1}-${Math.min(i + batchSize, maxUsers)} of ${maxUsers}...`);

        const batchResults = await Promise.allSettled(
          batch.map(async (pubkey) => {
            const taprootAddress = pubkeyToTaprootAddress(pubkey);
            const bal = await fetchBalance(taprootAddress);
            const profile = await getCachedProfile(pubkey);

            return {
              pubkey,
              npub: pubkeyToNpub(pubkey),
              profile: profile || { name: `User ${pubkey.slice(0, 8)}` } as ProfileMetadata,
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

        const sorted = [...results].sort((a, b) => b.balance - a.balance);
        setEntries(sorted);
      }

      const finalSorted = results.sort((a, b) => b.balance - a.balance);
      setEntries(finalSorted);
      cacheLeaderboard(finalSorted);
    } catch (err: any) {
      setError(err.message || 'Failed to load from following list');
    } finally {
      setLoading(false);
      setProcessing('');
    }
  }

  const searchNostr = useCallback(async () => {
    if (!searchTerm.trim()) return;

    setProcessing(`Searching for "${searchTerm}"...`);

    try {
      const relayList = await loadRelayList();
      const relays = getReadRelays(relayList);
      const relayUrls = relays.length > 0
        ? relays
        : ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.nostr.band'];

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
      cacheLeaderboard(merged);
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

  return (
    <div className="h-full flex flex-col p-4 md:p-6">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Trophy className="w-5 h-5 text-bitcoin" />
          <h1 className="text-lg font-bold">Leaderboard</h1>
        </div>
        <button
          onClick={loadLeaderboard}
          disabled={loading}
          className="p-2 rounded-lg hover:bg-surface-700 text-gray-400 hover:text-white transition-colors"
          title="Retry"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      <p className="text-xs text-gray-500 mb-3">
        Nostr users ranked by on-chain Taproot balance
        {dataSource === 'following' && ' (from your following list)'}
      </p>

      {/* Search */}
      <div className="flex gap-2 mb-4">
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
          <div className="flex gap-2 mt-2">
            <button
              onClick={loadLeaderboard}
              disabled={loading}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-medium bg-surface-700 text-gray-300 hover:bg-surface-600 transition-colors"
            >
              <RefreshCw className="w-3 h-3" />
              Retry
            </button>
            <button
              onClick={loadFromFollowing}
              disabled={loading}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-medium bg-bitcoin/15 text-bitcoin hover:bg-bitcoin/25 transition-colors"
            >
              <Users className="w-3 h-3" />
              Use Following List
            </button>
          </div>
        </div>
      )}

      {/* Leaderboard list */}
      <div className="flex-1 overflow-y-auto space-y-1">
        {loading && entries.length === 0 ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-6 h-6 animate-spin text-bitcoin" />
          </div>
        ) : filtered.length === 0 ? (
          <p className="text-center text-gray-500 py-8 text-sm">No users found</p>
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

// Helpers

function npubToHex(npub: string): string | null {
  try {
    return npubToPubkey(npub);
  } catch {
    return null;
  }
}

function getCachedLeaderboard(): LeaderboardEntry[] | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (Date.now() - parsed.timestamp > CACHE_TTL) return null;
    return parsed.data;
  } catch {
    return null;
  }
}

function cacheLeaderboard(entries: LeaderboardEntry[]) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ data: entries, timestamp: Date.now() }));
  } catch {}
}

async function fetchFollowingList(relayUrls: string[]): Promise<string[]> {
  const pubkeys: string[] = [];
  const seen = new Set<string>();

  const promises = relayUrls.slice(0, 3).map((url) => {
    return new Promise<void>((resolve) => {
      const timeout = setTimeout(() => resolve(), 8000);

      try {
        const ws = new WebSocket(url);
        const subId = `follow_${Math.random().toString(36).slice(2, 8)}`;

        ws.onopen = () => {
          ws.send(JSON.stringify(['REQ', subId, { kinds: [3], limit: 1 }]));
        };

        ws.onmessage = (msg) => {
          try {
            const data = JSON.parse(msg.data);
            if (data[0] === 'EVENT' && data[2]) {
              const event = data[2];
              for (const tag of event.tags) {
                if (tag[0] === 'p' && tag[1] && !seen.has(tag[1])) {
                  seen.add(tag[1]);
                  pubkeys.push(tag[1]);
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
  return pubkeys;
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
