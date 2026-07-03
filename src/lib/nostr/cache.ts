/**
 * Profile cache with activity tracking.
 *
 * Strategy:
 * 1. Discover active users by fetching kind 1 notes from multiple relays
 * 2. Resolve their profiles (kind 0)
 * 3. Store with lastSeen timestamps for activity filtering
 * 4. NIP-50 search via relay.nostr.band for global search
 * 5. Local cache search for instant results
 */

import { type ProfileMetadata } from './social';
import { KIND } from './events';
import { getReadRelays, loadRelayList } from './relays';
import { npubToPubkey } from './keys';

const CACHE_KEY = 'profile_cache_v2';
const BATCH_DELAY_MS = 300;

function sanitizeProfile(raw: any, pubkey: string): ProfileMetadata {
  return {
    pubkey: pubkey || raw.pubkey || '',
    name: typeof raw.name === 'string' ? raw.name : '',
    displayName: typeof raw.display_name === 'string' ? raw.display_name : (typeof raw.displayName === 'string' ? raw.displayName : ''),
    about: typeof raw.about === 'string' ? raw.about : '',
    picture: typeof raw.picture === 'string' ? raw.picture : '',
    banner: typeof raw.banner === 'string' ? raw.banner : '',
    nip05: typeof raw.nip05 === 'string' ? raw.nip05 : '',
    lud16: typeof raw.lud16 === 'string' ? raw.lud16 : '',
    website: typeof raw.website === 'string' ? raw.website : '',
  };
}

export type ActivityWindow = '24h' | '7d' | '30d' | 'all';

export interface CachedProfile {
  profile: ProfileMetadata;
  lastSeen: number; // unix timestamp of most recent activity
  fetchedAt: number;
}

interface ProfileCacheStore {
  profiles: Record<string, CachedProfile>;
  lastFullSync: number;
}

function windowToSeconds(window: ActivityWindow): number {
  switch (window) {
    case '24h': return 24 * 60 * 60;
    case '7d': return 7 * 24 * 60 * 60;
    case '30d': return 30 * 24 * 60 * 60;
    case 'all': return Infinity;
  }
}

export async function loadCache(): Promise<ProfileCacheStore> {
  const result = await chrome.storage.local.get(CACHE_KEY);
  return result[CACHE_KEY] ?? { profiles: {}, lastFullSync: 0 };
}

async function saveCache(cache: ProfileCacheStore): Promise<void> {
  await chrome.storage.local.set({ [CACHE_KEY]: cache });
}

export async function getCachedProfile(pubkey: string): Promise<ProfileMetadata | null> {
  const cache = await loadCache();
  const entry = cache.profiles[pubkey];
  if (!entry) return null;
  return entry.profile;
}

export async function getCachedProfiles(pubkeys: string[]): Promise<{
  cached: Map<string, ProfileMetadata>;
  missing: string[];
}> {
  const cache = await loadCache();
  const cached = new Map<string, ProfileMetadata>();
  const missing: string[] = [];

  for (const pk of pubkeys) {
    const entry = cache.profiles[pk];
    if (entry) {
      cached.set(pk, entry.profile);
    } else {
      missing.push(pk);
    }
  }

  return { cached, missing };
}

export async function cacheProfiles(profiles: Map<string, ProfileMetadata>, lastSeen?: number): Promise<void> {
  const cache = await loadCache();
  const now = Date.now();
  const ts = lastSeen ?? Math.floor(now / 1000);

  for (const [pubkey, profile] of profiles) {
    const existing = cache.profiles[pubkey];
    cache.profiles[pubkey] = {
      profile,
      lastSeen: existing ? Math.max(existing.lastSeen, ts) : ts,
      fetchedAt: now,
    };
  }

  await saveCache(cache);
}

export async function updateLastSeen(pubkeys: Map<string, number>): Promise<void> {
  const cache = await loadCache();
  for (const [pubkey, ts] of pubkeys) {
    if (cache.profiles[pubkey]) {
      cache.profiles[pubkey].lastSeen = Math.max(cache.profiles[pubkey].lastSeen, ts);
    } else {
      cache.profiles[pubkey] = {
        profile: { pubkey },
        lastSeen: ts,
        fetchedAt: 0,
      };
    }
  }
  await saveCache(cache);
}

/**
 * Get all cached profiles filtered by activity window.
 * Ranks profiles with pictures and metadata higher.
 */
export async function getAllCachedProfiles(window: ActivityWindow = 'all'): Promise<CachedProfile[]> {
  const cache = await loadCache();
  const now = Math.floor(Date.now() / 1000);
  const maxAge = windowToSeconds(window);

  return Object.values(cache.profiles)
    .filter((entry) => {
      if (maxAge === Infinity) return true;
      return now - entry.lastSeen <= maxAge;
    })
    .sort((a, b) => {
      // Rank: profiles with pictures first, then by recency
      const aHasPic = a.profile.picture ? 1 : 0;
      const bHasPic = b.profile.picture ? 1 : 0;
      if (aHasPic !== bHasPic) return bHasPic - aHasPic;
      return b.lastSeen - a.lastSeen;
    });
}

export async function getCacheStats(): Promise<{
  totalProfiles: number;
  active24h: number;
  active7d: number;
  active30d: number;
  lastSync: number;
}> {
  const cache = await loadCache();
  const now = Math.floor(Date.now() / 1000);
  const profiles = Object.values(cache.profiles);

  return {
    totalProfiles: profiles.length,
    active24h: profiles.filter((e) => now - e.lastSeen <= 24 * 60 * 60).length,
    active7d: profiles.filter((e) => now - e.lastSeen <= 7 * 24 * 60 * 60).length,
    active30d: profiles.filter((e) => now - e.lastSeen <= 30 * 24 * 60 * 60).length,
    lastSync: cache.lastFullSync,
  };
}

export async function markFullSync(): Promise<void> {
  const cache = await loadCache();
  cache.lastFullSync = Date.now();
  await saveCache(cache);
}

export async function clearCache(): Promise<void> {
  await chrome.storage.local.remove(CACHE_KEY);
}

/**
 * Discover active users by fetching kind 1 notes from multiple relays in parallel.
 * This finds *actually active* people, not just profiles that exist.
 *
 * Returns pubkeys with their latest activity timestamps.
 */
export async function discoverActiveUsers(
  relays: string[],
  window: ActivityWindow,
  options: {
    maxUsers?: number;
    onProgress?: (phase: string, count: number) => void;
  } = {}
): Promise<Map<string, number>> {
  const maxUsers = options.maxUsers ?? 2000;
  const since = Math.floor(Date.now() / 1000) - windowToSeconds(window);
  const activeUsers = new Map<string, number>();

  options.onProgress?.('Finding active users...', 0);

  // Fetch kind 1 notes from multiple relays in parallel
  const relaysToUse = relays.slice(0, 8);
  const batchPromises = relaysToUse.map((relay) =>
    fetchActiveAuthors(relay, since, Math.min(maxUsers, 500))
  );

  const results = await Promise.allSettled(batchPromises);

  for (const result of results) {
    if (result.status === 'fulfilled') {
      for (const [pubkey, ts] of result.value) {
        const existing = activeUsers.get(pubkey);
        if (!existing || ts > existing) {
          activeUsers.set(pubkey, ts);
        }
      }
    }
  }

  options.onProgress?.('Found users', activeUsers.size);

  // Store activity timestamps
  if (activeUsers.size > 0) {
    await updateLastSeen(activeUsers);
  }

  return activeUsers;
}

/**
 * Fetch kind 1 note authors from a single relay.
 * Returns map of pubkey -> latest created_at
 */
function fetchActiveAuthors(
  relayUrl: string,
  since: number,
  limit: number
): Promise<Map<string, number>> {
  return new Promise((resolve) => {
    const authors = new Map<string, number>();
    const timer = setTimeout(() => { ws.close(); resolve(authors); }, 15000);

    let ws: WebSocket;
    try {
      ws = new WebSocket(relayUrl);
    } catch {
      clearTimeout(timer);
      resolve(authors);
      return;
    }

    const subId = `active_${Math.random().toString(36).slice(2, 8)}`;

    ws.onopen = () => {
      ws.send(JSON.stringify(['REQ', subId, {
        kinds: [KIND.TEXT_NOTE],
        since,
        limit,
      }]));
    };

    ws.onmessage = (msg) => {
      try {
        const data = JSON.parse(msg.data);
        if (data[0] === 'EVENT' && data[1] === subId) {
          const event = data[2];
          const existing = authors.get(event.pubkey);
          if (!existing || event.created_at > existing) {
            authors.set(event.pubkey, event.created_at);
          }
        } else if (data[0] === 'EOSE') {
          clearTimeout(timer);
          ws.close();
          resolve(authors);
        }
      } catch {}
    };

    ws.onerror = () => { clearTimeout(timer); resolve(authors); };
  });
}

/**
 * Resolve profiles for a list of pubkeys (batch fetch kind 0 from relays).
 */
export async function resolveProfiles(
  pubkeys: string[],
  relays: string[],
  options: {
    onProgress?: (done: number, total: number) => void;
  } = {}
): Promise<Map<string, ProfileMetadata>> {
  const allProfiles = new Map<string, ProfileMetadata>();
  if (pubkeys.length === 0) return allProfiles;

  // Check cache first
  const cache = await loadCache();
  const uncached: string[] = [];

  for (const pk of pubkeys) {
    const entry = cache.profiles[pk];
    if (entry && entry.profile.name) {
      allProfiles.set(pk, entry.profile);
    } else {
      uncached.push(pk);
    }
  }

  if (uncached.length === 0) {
    options.onProgress?.(pubkeys.length, pubkeys.length);
    return allProfiles;
  }

  // Batch fetch from relays (chunks of 150 pubkeys per relay request)
  const CHUNK_SIZE = 150;
  const relaysToUse = relays.slice(0, 3);

  for (let i = 0; i < uncached.length; i += CHUNK_SIZE) {
    const chunk = uncached.slice(i, i + CHUNK_SIZE);

    const chunkPromises = relaysToUse.map((relay) =>
      fetchProfileBatchByAuthors(relay, chunk)
    );

    const results = await Promise.allSettled(chunkPromises);

    for (const result of results) {
      if (result.status === 'fulfilled') {
        for (const [pk, profile] of result.value) {
          if (!allProfiles.has(pk)) {
            allProfiles.set(pk, profile);
          }
        }
      }
    }

    options.onProgress?.(allProfiles.size, pubkeys.length);

    if (i + CHUNK_SIZE < uncached.length) {
      await sleep(BATCH_DELAY_MS);
    }
  }

  // Cache results
  if (allProfiles.size > 0) {
    const toCache = new Map<string, ProfileMetadata>();
    for (const [pk, profile] of allProfiles) {
      if (profile.name || profile.displayName) {
        toCache.set(pk, profile);
      }
    }
    if (toCache.size > 0) await cacheProfiles(toCache);
  }

  return allProfiles;
}

function fetchProfileBatchByAuthors(
  relayUrl: string,
  pubkeys: string[]
): Promise<Map<string, ProfileMetadata>> {
  return new Promise((resolve) => {
    const profiles = new Map<string, ProfileMetadata>();
    const timer = setTimeout(() => { ws.close(); resolve(profiles); }, 12000);

    let ws: WebSocket;
    try {
      ws = new WebSocket(relayUrl);
    } catch {
      clearTimeout(timer);
      resolve(profiles);
      return;
    }

    const subId = `prof_${Math.random().toString(36).slice(2, 8)}`;

    ws.onopen = () => {
      ws.send(JSON.stringify(['REQ', subId, {
        kinds: [0],
        authors: pubkeys,
      }]));
    };

    ws.onmessage = (msg) => {
      try {
        const data = JSON.parse(msg.data);
        if (data[0] === 'EVENT' && data[1] === subId) {
          try {
            const content = JSON.parse(data[2].content);
            profiles.set(data[2].pubkey, sanitizeProfile(content, data[2].pubkey));
          } catch {}
        } else if (data[0] === 'EOSE') {
          clearTimeout(timer);
          ws.close();
          resolve(profiles);
        }
      } catch {}
    };

    ws.onerror = () => { clearTimeout(timer); resolve(profiles); };
  });
}

/**
 * Full discovery pipeline: find active users + resolve their profiles.
 */
export async function fullDiscoverySync(
  window: ActivityWindow = '7d',
  options: {
    maxUsers?: number;
    onProgress?: (phase: string, count: number) => void;
  } = {}
): Promise<CachedProfile[]> {
  const relayList = await loadRelayList();
  const relays = getReadRelays(relayList);
  const allRelays = relays.length > 0 ? relays : ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.snort.social'];

  const discoveryRelays = [...new Set([
    ...allRelays,
    'wss://relay.nostr.band',
    'wss://nostr.wine',
    'wss://relay.snort.social',
  ])];

  // Phase 1: Find active users
  const activeUsers = await discoverActiveUsers(discoveryRelays, window, {
    maxUsers: options.maxUsers ?? 2000,
    onProgress: options.onProgress,
  });

  options.onProgress?.('Resolving profiles...', activeUsers.size);

  // Phase 2: Resolve profiles for active users
  const pubkeys = Array.from(activeUsers.keys());
  await resolveProfiles(pubkeys, discoveryRelays, {
    onProgress: (done, total) => {
      options.onProgress?.(`Profiles: ${done}/${total}`, done);
    },
  });

  await markFullSync();

  // Return filtered results
  return getAllCachedProfiles(window);
}

/**
 * Search profiles using NIP-50 (relay.nostr.band).
 * For npub/hex queries, does a direct author lookup on multiple relays.
 * Ranks profiles with pictures higher.
 */
export async function searchProfilesNip50(
  query: string,
  limit = 30
): Promise<ProfileMetadata[]> {
  const allResults = new Map<string, ProfileMetadata>();

  // Direct npub/hex lookup — highest priority, always works
  if (query.startsWith('npub1') || /^[0-9a-f]{64}$/i.test(query)) {
    let hex = query;
    if (query.startsWith('npub1')) {
      try {
        hex = npubToPubkey(query);
      } catch { return []; }
    }
    hex = hex.toLowerCase();

    // Query multiple relays in parallel for this specific pubkey
    const LOOKUP_RELAYS = [
      'wss://relay.damus.io',
      'wss://purplepag.es',
      'wss://relay.nostr.band',
      'wss://nos.lol',
      'wss://relay.snort.social',
    ];

    const lookupPromises = LOOKUP_RELAYS.map((relay) =>
      fetchProfileBatchByAuthors(relay, [hex])
    );

    const results = await Promise.allSettled(lookupPromises);
    for (const result of results) {
      if (result.status === 'fulfilled') {
        for (const [pk, profile] of result.value) {
          if (!allResults.has(pk) || (profile.picture && !allResults.get(pk)?.picture)) {
            allResults.set(pk, profile);
          }
        }
      }
    }

    // If we still didn't find a profile, return a minimal entry
    if (!allResults.has(hex)) {
      allResults.set(hex, { pubkey: hex });
    }

    const resultArray = Array.from(allResults.values());
    if (resultArray.length > 0) await cacheProfiles(allResults);
    return resultArray;
  }

  // NIP-50 text search on search-capable relays
  const SEARCH_RELAYS = [
    'wss://relay.nostr.band',
    'wss://nostr.wine',
    'wss://purplepag.es',
  ];

  const promises = SEARCH_RELAYS.map((relay) =>
    searchOnRelay(relay, query, limit)
  );

  const results = await Promise.allSettled(promises);

  for (const result of results) {
    if (result.status === 'fulfilled') {
      for (const profile of result.value) {
        if (!allResults.has(profile.pubkey)) {
          allResults.set(profile.pubkey, profile);
        }
      }
    }
  }

  const resultArray = Array.from(allResults.values());

  // Cache results
  if (resultArray.length > 0) {
    await cacheProfiles(allResults);
  }

  // If remote returned nothing, fall back to local cache search
  if (resultArray.length === 0) {
    return searchLocalCache(query);
  }

  // Rank: profiles with pictures first, then by name existence
  resultArray.sort((a, b) => {
    const aScore = (a.picture ? 10 : 0) + (a.displayName || a.name ? 5 : 0) + (a.nip05 ? 3 : 0);
    const bScore = (b.picture ? 10 : 0) + (b.displayName || b.name ? 5 : 0) + (b.nip05 ? 3 : 0);
    return bScore - aScore;
  });

  return resultArray;
}

function searchOnRelay(relayUrl: string, query: string, limit: number): Promise<ProfileMetadata[]> {
  return new Promise((resolve) => {
    const profiles: ProfileMetadata[] = [];
    const timer = setTimeout(() => { ws.close(); resolve(profiles); }, 10000);

    let ws: WebSocket;
    try {
      ws = new WebSocket(relayUrl);
    } catch {
      clearTimeout(timer);
      resolve([]);
      return;
    }

    const subId = `search_${Math.random().toString(36).slice(2, 8)}`;

    ws.onopen = () => {
      ws.send(JSON.stringify(['REQ', subId, {
        kinds: [0],
        search: query,
        limit,
      }]));
    };

    ws.onmessage = (msg) => {
      try {
        const data = JSON.parse(msg.data);
        if (data[0] === 'EVENT' && data[1] === subId) {
          try {
            const content = JSON.parse(data[2].content);
            profiles.push(sanitizeProfile(content, data[2].pubkey));
          } catch {}
        } else if (data[0] === 'EOSE') {
          clearTimeout(timer);
          ws.close();
          resolve(profiles);
        }
      } catch {}
    };

    ws.onerror = () => { clearTimeout(timer); resolve(profiles); };
  });
}

/**
 * Search the local cache by name, displayName, nip05, npub, or about.
 * Ranks profiles with pictures higher.
 */
export async function searchLocalCache(query: string): Promise<ProfileMetadata[]> {
  const all = await getAllCachedProfiles('all');
  const q = query.toLowerCase();
  const matches = all
    .filter((entry) => {
      const p = entry.profile;
      return (
        (p.name && p.name.toLowerCase().includes(q)) ||
        (p.displayName && p.displayName.toLowerCase().includes(q)) ||
        (p.nip05 && p.nip05.toLowerCase().includes(q)) ||
        (p.about && p.about.toLowerCase().includes(q)) ||
        p.pubkey.includes(q)
      );
    })
    .map((entry) => entry.profile);

  // Rank: pictures first, then name match quality
  matches.sort((a, b) => {
    const aScore = (a.picture ? 10 : 0) + (a.displayName || a.name ? 5 : 0) + (a.nip05 ? 3 : 0);
    const bScore = (b.picture ? 10 : 0) + (b.displayName || b.name ? 5 : 0) + (b.nip05 ? 3 : 0);
    return bScore - aScore;
  });

  return matches;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
