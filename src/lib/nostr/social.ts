/**
 * Nostr social graph integration.
 * Fetches following lists and contact data from relays to build
 * the key selection pool for social multi-sig.
 */

import { KIND } from './events';

export interface ContactInfo {
  pubkey: string;
  relay?: string;
  petname?: string;
}

export interface ProfileMetadata {
  pubkey: string;
  name?: string;
  displayName?: string;
  picture?: string;
  banner?: string;
  about?: string;
  nip05?: string;
  lud16?: string;
  website?: string;
}

export interface SocialGraph {
  pubkey: string;
  following: ContactInfo[];
  fetchedAt: number;
}

const DEFAULT_RELAYS = [
  'wss://relay.damus.io',
  'wss://relay.nostr.band',
  'wss://nos.lol',
  'wss://relay.snort.social',
  'wss://purplepag.es',
];

/**
 * Fetch a user's contact list (kind 3) from relays.
 * Returns the list of pubkeys they follow.
 */
export async function fetchFollowingList(
  pubkey: string,
  relays: string[] = DEFAULT_RELAYS,
  timeout = 10000
): Promise<ContactInfo[]> {
  const contacts: ContactInfo[] = [];
  let latestCreatedAt = 0;

  const promises = relays.map((relay) =>
    fetchContactsFromRelay(relay, pubkey, timeout)
  );

  const results = await Promise.allSettled(promises);

  for (const result of results) {
    if (result.status === 'fulfilled' && result.value) {
      if (result.value.createdAt > latestCreatedAt) {
        latestCreatedAt = result.value.createdAt;
        contacts.length = 0;
        contacts.push(...result.value.contacts);
      }
    }
  }

  return contacts;
}

async function fetchContactsFromRelay(
  relayUrl: string,
  pubkey: string,
  timeout: number
): Promise<{ contacts: ContactInfo[]; createdAt: number } | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      ws.close();
      resolve(null);
    }, timeout);

    let ws: WebSocket;
    try {
      ws = new WebSocket(relayUrl);
    } catch {
      clearTimeout(timer);
      resolve(null);
      return;
    }

    const subId = `contacts_${Math.random().toString(36).slice(2, 8)}`;

    ws.onopen = () => {
      const filter = {
        kinds: [KIND.CONTACTS],
        authors: [pubkey],
        limit: 1,
      };
      ws.send(JSON.stringify(['REQ', subId, filter]));
    };

    ws.onmessage = (msg) => {
      try {
        const data = JSON.parse(msg.data);
        if (data[0] === 'EVENT' && data[1] === subId) {
          const event = data[2];
          const contacts: ContactInfo[] = event.tags
            .filter((tag: string[]) => tag[0] === 'p')
            .map((tag: string[]) => ({
              pubkey: tag[1],
              relay: tag[2] || undefined,
              petname: tag[3] || undefined,
            }));
          clearTimeout(timer);
          ws.close();
          resolve({ contacts, createdAt: event.created_at });
        } else if (data[0] === 'EOSE') {
          clearTimeout(timer);
          ws.close();
          resolve(null);
        }
      } catch {
        // ignore parse errors
      }
    };

    ws.onerror = () => {
      clearTimeout(timer);
      resolve(null);
    };
  });
}

/**
 * Fetch full profile metadata (kind 0) for a batch of pubkeys.
 * Returns a map of pubkey -> ProfileMetadata with picture, nip05, etc.
 */
export async function fetchProfiles(
  pubkeys: string[],
  relays: string[] = DEFAULT_RELAYS,
  timeout = 12000
): Promise<Map<string, ProfileMetadata>> {
  const profiles = new Map<string, ProfileMetadata>();
  if (pubkeys.length === 0) return profiles;

  // Query multiple relays for better coverage
  const relaysToQuery = relays.slice(0, 3);
  const promises = relaysToQuery.map((relay) =>
    fetchProfilesFromRelay(relay, pubkeys, timeout)
  );

  const results = await Promise.allSettled(promises);

  for (const result of results) {
    if (result.status === 'fulfilled') {
      for (const [key, profile] of result.value) {
        if (!profiles.has(key)) {
          profiles.set(key, profile);
        }
      }
    }
  }

  return profiles;
}

async function fetchProfilesFromRelay(
  relayUrl: string,
  pubkeys: string[],
  timeout: number
): Promise<Map<string, ProfileMetadata>> {
  const profiles = new Map<string, ProfileMetadata>();

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      ws.close();
      resolve(profiles);
    }, timeout);

    let ws: WebSocket;
    try {
      ws = new WebSocket(relayUrl);
    } catch {
      clearTimeout(timer);
      resolve(profiles);
      return;
    }

    const subId = `profiles_${Math.random().toString(36).slice(2, 8)}`;

    ws.onopen = () => {
      // Batch in chunks of 100 to avoid overwhelming relays
      const batch = pubkeys.slice(0, 150);
      const filter = {
        kinds: [KIND.METADATA],
        authors: batch,
      };
      ws.send(JSON.stringify(['REQ', subId, filter]));
    };

    ws.onmessage = (msg) => {
      try {
        const data = JSON.parse(msg.data);
        if (data[0] === 'EVENT' && data[1] === subId) {
          const event = data[2];
          try {
            const content = JSON.parse(event.content);
            profiles.set(event.pubkey, {
              pubkey: event.pubkey,
              name: content.name,
              displayName: content.display_name,
              picture: content.picture,
              banner: content.banner,
              about: content.about,
              nip05: content.nip05,
              lud16: content.lud16,
              website: content.website,
            });
          } catch {
            // invalid profile JSON
          }
        } else if (data[0] === 'EOSE') {
          clearTimeout(timer);
          ws.close();
          resolve(profiles);
        }
      } catch {
        // ignore
      }
    };

    ws.onerror = () => {
      clearTimeout(timer);
      resolve(profiles);
    };
  });
}

/**
 * Fetch profile metadata for a list of pubkeys (legacy name compat).
 */
export async function fetchProfileNames(
  pubkeys: string[],
  relays: string[] = DEFAULT_RELAYS,
  timeout = 10000
): Promise<Map<string, string>> {
  const profiles = await fetchProfiles(pubkeys, relays, timeout);
  const names = new Map<string, string>();
  for (const [key, profile] of profiles) {
    names.set(key, profile.displayName || profile.name || key.slice(0, 8));
  }
  return names;
}

/**
 * Storage for saved social graphs and custom key groups.
 */
export interface KeyGroup {
  id: string;
  name: string;
  description?: string;
  pubkeys: string[];
  createdAt: number;
}

export async function saveKeyGroup(group: KeyGroup): Promise<void> {
  const existing = await loadKeyGroups();
  const idx = existing.findIndex((g) => g.id === group.id);
  if (idx >= 0) {
    existing[idx] = group;
  } else {
    existing.push(group);
  }
  await chrome.storage.local.set({ keyGroups: existing });
}

export async function loadKeyGroups(): Promise<KeyGroup[]> {
  const result = await chrome.storage.local.get('keyGroups');
  return result.keyGroups ?? [];
}

export async function deleteKeyGroup(id: string): Promise<void> {
  const existing = await loadKeyGroups();
  const filtered = existing.filter((g) => g.id !== id);
  await chrome.storage.local.set({ keyGroups: filtered });
}
