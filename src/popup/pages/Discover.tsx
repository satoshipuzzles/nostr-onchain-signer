import { useState, useEffect, useCallback, useRef } from 'react';
import { ArrowLeft, Search, Loader2, UserPlus, UserMinus, BadgeCheck, Zap, Globe, Database, RefreshCw, Clock, Filter } from 'lucide-react';
import { pubkeyToNpub } from '@/lib/nostr/keys';
import { type ProfileMetadata } from '@/lib/nostr/social';
import { loadRelayList, getReadRelays } from '@/lib/nostr/relays';
import { safeImageUrl } from '@/lib/utils';
import {
  fullDiscoverySync, searchProfilesNip50, getAllCachedProfiles,
  getCacheStats, searchLocalCache, type ActivityWindow, type CachedProfile,
} from '@/lib/nostr/cache';
import { type DiscoveredUser } from '@/lib/nostr/discovery';
import { ClickableAvatar } from '@/popup/components/ClickableAvatar';

interface Props {
  publicKey: string;
  following: Set<string>;
  onFollow: (pubkey: string) => void;
  onUnfollow: (pubkey: string) => void;
  onViewProfile: (user: DiscoveredUser) => void;
  onBack: () => void;
}

export function Discover({ publicKey, following, onFollow, onUnfollow, onViewProfile, onBack }: Props) {
  const [profiles, setProfiles] = useState<CachedProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [cacheStats, setCacheStats] = useState({ totalProfiles: 0, active24h: 0, active7d: 0, active30d: 0, lastSync: 0 });
  const [syncProgress, setSyncProgress] = useState('');
  const [activityWindow, setActivityWindow] = useState<ActivityWindow>('7d');
  const [showFilters, setShowFilters] = useState(false);
  const globalSearchTimer = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    init();
  }, []);

  useEffect(() => {
    if (!loading && !syncing && !searchQuery) {
      loadFromCache(activityWindow);
    }
  }, [activityWindow]);

  async function init() {
    const stats = await getCacheStats();
    setCacheStats(stats);

    if (stats.totalProfiles > 0) {
      await loadFromCache(activityWindow);
      setLoading(false);
      if (Date.now() - stats.lastSync > 5 * 60 * 1000) {
        syncFromRelays();
      }
    } else {
      setLoading(false);
      syncFromRelays();
    }
  }

  async function loadFromCache(window: ActivityWindow) {
    const cached = await getAllCachedProfiles(window);
    setProfiles(cached.filter((p) => p.profile.pubkey !== publicKey));
  }

  async function syncFromRelays() {
    setSyncing(true);
    setSyncProgress('Starting discovery...');

    try {
      const results = await fullDiscoverySync(activityWindow, {
        maxUsers: 2000,
        onProgress: (phase, count) => {
          setSyncProgress(`${phase} (${count})`);
        },
      });

      setProfiles(results.filter((p) => p.profile.pubkey !== publicKey));
      const stats = await getCacheStats();
      setCacheStats(stats);
    } catch (err) {
      console.error('Discovery sync failed:', err);
    } finally {
      setSyncing(false);
      setSyncProgress('');
      setLoading(false);
    }
  }

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    if (!searchQuery.trim()) {
      await loadFromCache(activityWindow);
      return;
    }

    setSearching(true);
    try {
      const results = await searchProfilesNip50(searchQuery.trim());
      setProfiles(results.map((p) => ({
        profile: p,
        lastSeen: Math.floor(Date.now() / 1000),
        fetchedAt: Date.now(),
      })).filter((p) => p.profile.pubkey !== publicKey));
    } catch (err) {
      console.error('Search failed:', err);
    } finally {
      setSearching(false);
    }
  }

  const handleLocalSearch = useCallback(async (query: string) => {
    setSearchQuery(query);
    if (globalSearchTimer.current) clearTimeout(globalSearchTimer.current);

    if (!query.trim()) {
      await loadFromCache(activityWindow);
      return;
    }

    // Auto-trigger global search for npub/hex pastes immediately
    if (query.startsWith('npub1') && query.length > 60) {
      setSearching(true);
      try {
        const results = await searchProfilesNip50(query.trim());
        setProfiles(results.map((p) => ({
          profile: p,
          lastSeen: Math.floor(Date.now() / 1000),
          fetchedAt: Date.now(),
        })).filter((p) => p.profile.pubkey !== publicKey));
      } catch {} finally {
        setSearching(false);
      }
      return;
    }

    // Instant local search
    const results = await searchLocalCache(query);
    setProfiles(results.map((p) => ({
      profile: p,
      lastSeen: Math.floor(Date.now() / 1000),
      fetchedAt: Date.now(),
    })).filter((p) => p.profile.pubkey !== publicKey));

    // Debounced global NIP-50 search (fires 800ms after stop typing)
    if (query.length >= 3) {
      globalSearchTimer.current = setTimeout(async () => {
        setSearching(true);
        try {
          const globalResults = await searchProfilesNip50(query.trim());
          if (globalResults.length > 0) {
            setProfiles(globalResults.map((p) => ({
              profile: p,
              lastSeen: Math.floor(Date.now() / 1000),
              fetchedAt: Date.now(),
            })).filter((p) => p.profile.pubkey !== publicKey));
          }
        } catch {} finally {
          setSearching(false);
        }
      }, 800);
    }
  }, [activityWindow, publicKey]);

  function getWindowCount(window: ActivityWindow): number {
    switch (window) {
      case '24h': return cacheStats.active24h;
      case '7d': return cacheStats.active7d;
      case '30d': return cacheStats.active30d;
      case 'all': return cacheStats.totalProfiles;
    }
  }

  function formatLastSeen(ts: number): string {
    const diff = Math.floor(Date.now() / 1000) - ts;
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
  }

  return (
    <div className="h-full flex flex-col p-4 pb-20 md:pb-4">
      {/* Header */}
      <div className="page-header">
        <button onClick={onBack} className="btn-back">
          <ArrowLeft className="w-5 h-5" />
        </button>
        <h1>Discover</h1>
        <button
          onClick={() => setShowFilters(!showFilters)}
          className={`btn-icon ${showFilters ? 'bg-bitcoin/20 text-bitcoin' : 'text-gray-400'}`}
          title="Activity filters"
        >
          <Filter className="w-4 h-4" />
        </button>
        <button
          onClick={syncFromRelays}
          disabled={syncing}
          className="btn-icon"
          title="Full sync from relays"
        >
          <RefreshCw className={`w-4 h-4 text-gray-400 ${syncing ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* Activity window filter */}
      {showFilters && (
        <div className="mb-3 p-3 bg-surface-700/50 rounded-xl space-y-2">
          <div className="flex items-center gap-1.5 mb-2">
            <Clock className="w-3.5 h-3.5 text-gray-400" />
            <span className="text-xs text-gray-400 font-medium">Active within</span>
          </div>
          <div className="grid grid-cols-4 gap-1.5">
            {(['24h', '7d', '30d', 'all'] as ActivityWindow[]).map((w) => (
              <button
                key={w}
                onClick={() => setActivityWindow(w)}
                className={`text-xs py-1.5 px-2 rounded-lg font-medium transition-colors ${
                  activityWindow === w
                    ? 'bg-bitcoin text-white'
                    : 'bg-surface-600 text-gray-400 hover:bg-surface-500'
                }`}
              >
                {w === 'all' ? 'All' : w}
              </button>
            ))}
          </div>
          <div className="text-[10px] text-gray-600 mt-1">
            Showing {getWindowCount(activityWindow).toLocaleString()} users active in {activityWindow === 'all' ? 'all time' : `last ${activityWindow}`}
          </div>
        </div>
      )}

      {/* Cache status */}
      <div className="flex items-center gap-2 mb-2 px-1">
        <Database className="w-3 h-3 text-gray-600" />
        <span className="text-[10px] text-gray-500">
          {cacheStats.totalProfiles.toLocaleString()} profiles cached
          {syncing && ` • ${syncProgress}`}
        </span>
        <span className="text-[10px] text-gray-600 ml-auto">
          {profiles.length.toLocaleString()} shown
        </span>
      </div>

      {/* Search */}
      <form onSubmit={handleSearch} className="relative mb-3">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
        <input
          value={searchQuery}
          onChange={(e) => handleLocalSearch(e.target.value)}
          placeholder="Search names, NIP-05, npubs, about..."
          className="input-field pl-9 pr-24 text-sm"
        />
        <button
          type="submit"
          disabled={searching}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] bg-nostr/20 text-nostr px-2 py-1 rounded font-medium disabled:opacity-50"
        >
          {searching ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Global Search'}
        </button>
      </form>

      {searchQuery && (
        <p className="text-[10px] text-gray-500 mb-2 px-1">
          {searchQuery.startsWith('npub1')
            ? 'Direct npub lookup — will search multiple relays'
            : 'Typing = local filter • Enter = global search • Paste npub for direct lookup'}
        </p>
      )}

      {/* User list */}
      <div className="flex-1 overflow-y-auto space-y-1 min-h-0">
        {loading ? (
          <div className="flex flex-col items-center justify-center py-12">
            <Loader2 className="w-6 h-6 animate-spin text-bitcoin mb-2" />
            <p className="text-sm text-gray-400">Discovering active users...</p>
            {syncProgress && <p className="text-xs text-gray-500 mt-1">{syncProgress}</p>}
          </div>
        ) : profiles.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12">
            <Globe className="w-8 h-8 text-gray-600 mb-2" />
            <p className="text-sm text-gray-500">
              {searchQuery ? 'No results. Press Enter for global search.' : 'No active users found.'}
            </p>
            <button onClick={syncFromRelays} className="text-xs text-bitcoin mt-2 hover:underline">
              Sync from relays
            </button>
          </div>
        ) : (
          profiles.map((entry) => (
            <UserRow
              key={entry.profile.pubkey}
              profile={entry.profile}
              lastSeen={formatLastSeen(entry.lastSeen)}
              isFollowing={following.has(entry.profile.pubkey)}
              onFollow={() => onFollow(entry.profile.pubkey)}
              onUnfollow={() => onUnfollow(entry.profile.pubkey)}
              onViewProfile={() => onViewProfile({
                pubkey: entry.profile.pubkey,
                profile: entry.profile,
                lastActive: entry.lastSeen,
              })}
            />
          ))
        )}
      </div>
    </div>
  );
}

function UserRow({
  profile,
  lastSeen,
  isFollowing,
  onFollow,
  onUnfollow,
  onViewProfile,
}: {
  profile: ProfileMetadata;
  lastSeen: string;
  isFollowing: boolean;
  onFollow: () => void;
  onUnfollow: () => void;
  onViewProfile: () => void;
}) {
  const displayName = (typeof profile.displayName === 'string' ? profile.displayName : '')
    || (typeof profile.name === 'string' ? profile.name : '')
    || profile.pubkey.slice(0, 12);
  const npub = pubkeyToNpub(profile.pubkey);

  return (
    <div className="flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-surface-700/60 transition-colors">
      <ClickableAvatar
        pubkey={profile.pubkey}
        picture={profile.picture}
        name={displayName}
        size="xl"
      />

      <button onClick={onViewProfile} className="flex-1 min-w-0 text-left">
        <div className="flex items-center gap-1.5">
          <p className="text-sm font-medium truncate">{displayName}</p>
          {typeof profile.nip05 === 'string' && profile.nip05 && (
            <span className="flex items-center gap-0.5 flex-shrink-0">
              <BadgeCheck className="w-3.5 h-3.5 text-nostr" />
            </span>
          )}
          {typeof profile.lud16 === 'string' && profile.lud16 && <Zap className="w-3 h-3 text-yellow-500/60 flex-shrink-0" />}
        </div>
        <div className="flex items-center gap-2">
          {typeof profile.nip05 === 'string' && profile.nip05 ? (
            <p className="text-xs text-nostr/70 truncate flex-1">{profile.nip05}</p>
          ) : (
            <p className="text-xs text-gray-500 truncate flex-1">{npub.slice(0, 20)}...</p>
          )}
          <span className="text-[9px] text-gray-600 flex-shrink-0">{lastSeen}</span>
        </div>
      </button>

      <button
        onClick={isFollowing ? onUnfollow : onFollow}
        className={`flex-shrink-0 p-2 rounded-lg transition-colors ${
          isFollowing
            ? 'bg-nostr/20 text-nostr hover:bg-red-500/20 hover:text-red-400'
            : 'bg-bitcoin/20 text-bitcoin hover:bg-bitcoin/30'
        }`}
      >
        {isFollowing ? <UserMinus className="w-4 h-4" /> : <UserPlus className="w-4 h-4" />}
      </button>
    </div>
  );
}
