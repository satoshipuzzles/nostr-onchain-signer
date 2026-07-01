/**
 * User discovery — find active Nostr users on relays.
 * "Active" = posted a kind 1 note in the last 7 days.
 * Also handles following/unfollowing and profile publishing.
 */

import { KIND, type UnsignedEvent, type SignedEvent, signEvent, computeEventId } from './events';
import { type ProfileMetadata } from './social';
import { getReadRelays, getWriteRelays, loadRelayList } from './relays';

export interface DiscoveredUser {
  pubkey: string;
  profile?: ProfileMetadata;
  lastActive: number;
}

/**
 * Discover active users on a relay. Fetches recent kind 1 notes
 * and resolves unique authors, then fetches their profiles.
 */
export async function discoverActiveUsers(
  relayUrl?: string,
  limit = 50,
  timeout = 12000
): Promise<DiscoveredUser[]> {
  const relayList = await loadRelayList();
  const relay = relayUrl || getReadRelays(relayList)[0] || 'wss://relay.damus.io';

  const sevenDaysAgo = Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60;

  return new Promise((resolve) => {
    const users = new Map<string, DiscoveredUser>();
    const timer = setTimeout(() => {
      ws.close();
      fetchProfilesForUsers(relay, users, timeout).then(resolve);
    }, timeout);

    let ws: WebSocket;
    try {
      ws = new WebSocket(relay);
    } catch {
      clearTimeout(timer);
      resolve([]);
      return;
    }

    const subId = `discover_${Math.random().toString(36).slice(2, 8)}`;

    ws.onopen = () => {
      ws.send(JSON.stringify(['REQ', subId, {
        kinds: [KIND.TEXT_NOTE],
        since: sevenDaysAgo,
        limit,
      }]));
    };

    ws.onmessage = (msg) => {
      try {
        const data = JSON.parse(msg.data);
        if (data[0] === 'EVENT' && data[1] === subId) {
          const event = data[2];
          if (!users.has(event.pubkey)) {
            users.set(event.pubkey, {
              pubkey: event.pubkey,
              lastActive: event.created_at,
            });
          } else {
            const existing = users.get(event.pubkey)!;
            if (event.created_at > existing.lastActive) {
              existing.lastActive = event.created_at;
            }
          }
        } else if (data[0] === 'EOSE') {
          clearTimeout(timer);
          ws.close();
          fetchProfilesForUsers(relay, users, timeout).then(resolve);
        }
      } catch {}
    };

    ws.onerror = () => {
      clearTimeout(timer);
      resolve([]);
    };
  });
}

async function fetchProfilesForUsers(
  relayUrl: string,
  users: Map<string, DiscoveredUser>,
  timeout: number
): Promise<DiscoveredUser[]> {
  if (users.size === 0) return [];

  const pubkeys = Array.from(users.keys()).slice(0, 100);

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      ws.close();
      resolve(Array.from(users.values()));
    }, timeout);

    let ws: WebSocket;
    try {
      ws = new WebSocket(relayUrl);
    } catch {
      clearTimeout(timer);
      resolve(Array.from(users.values()));
      return;
    }

    const subId = `profiles_${Math.random().toString(36).slice(2, 8)}`;

    ws.onopen = () => {
      ws.send(JSON.stringify(['REQ', subId, {
        kinds: [KIND.METADATA],
        authors: pubkeys,
      }]));
    };

    ws.onmessage = (msg) => {
      try {
        const data = JSON.parse(msg.data);
        if (data[0] === 'EVENT' && data[1] === subId) {
          const event = data[2];
          const user = users.get(event.pubkey);
          if (user) {
            try {
              const content = JSON.parse(event.content);
              user.profile = {
                pubkey: event.pubkey,
                name: content.name,
                displayName: content.display_name,
                picture: content.picture,
                banner: content.banner,
                about: content.about,
                nip05: content.nip05,
                lud16: content.lud16,
                website: content.website,
              };
            } catch {}
          }
        } else if (data[0] === 'EOSE') {
          clearTimeout(timer);
          ws.close();
          resolve(Array.from(users.values()));
        }
      } catch {}
    };

    ws.onerror = () => {
      clearTimeout(timer);
      resolve(Array.from(users.values()));
    };
  });
}

/**
 * Search for a user by NIP-05 identifier or npub.
 */
export async function searchUsers(
  query: string,
  relayUrl?: string,
  timeout = 8000
): Promise<DiscoveredUser[]> {
  const relayList = await loadRelayList();
  const relay = relayUrl || getReadRelays(relayList)[0] || 'wss://relay.damus.io';

  return new Promise((resolve) => {
    const users: DiscoveredUser[] = [];
    const timer = setTimeout(() => {
      ws.close();
      resolve(users);
    }, timeout);

    let ws: WebSocket;
    try {
      ws = new WebSocket(relay);
    } catch {
      clearTimeout(timer);
      resolve([]);
      return;
    }

    const subId = `search_${Math.random().toString(36).slice(2, 8)}`;

    ws.onopen = () => {
      // Search kind 0 profiles by content match (limited relay support)
      // Most relays support NIP-50 search
      ws.send(JSON.stringify(['REQ', subId, {
        kinds: [KIND.METADATA],
        search: query,
        limit: 20,
      }]));
    };

    ws.onmessage = (msg) => {
      try {
        const data = JSON.parse(msg.data);
        if (data[0] === 'EVENT' && data[1] === subId) {
          const event = data[2];
          try {
            const content = JSON.parse(event.content);
            users.push({
              pubkey: event.pubkey,
              lastActive: event.created_at,
              profile: {
                pubkey: event.pubkey,
                name: content.name,
                displayName: content.display_name,
                picture: content.picture,
                about: content.about,
                nip05: content.nip05,
                lud16: content.lud16,
                website: content.website,
              },
            });
          } catch {}
        } else if (data[0] === 'EOSE') {
          clearTimeout(timer);
          ws.close();
          resolve(users);
        }
      } catch {}
    };

    ws.onerror = () => {
      clearTimeout(timer);
      resolve([]);
    };
  });
}

/**
 * Publish a kind 3 contacts event (follow list).
 */
export function createFollowListEvent(
  followPubkeys: string[],
  myPubkey: string
): UnsignedEvent {
  const tags = followPubkeys.map((pk) => ['p', pk]);
  return {
    kind: KIND.CONTACTS,
    content: '',
    tags,
    created_at: Math.floor(Date.now() / 1000),
    pubkey: myPubkey,
  };
}

/**
 * Publish a kind 0 metadata event (profile).
 */
export function createProfileEvent(
  profile: ProfileMetadata,
  myPubkey: string
): UnsignedEvent {
  const { pubkey: _, ...profileData } = profile;
  const content: Record<string, string | undefined> = {};
  if (profileData.name) content.name = profileData.name;
  if (profileData.displayName) content.display_name = profileData.displayName;
  if (profileData.picture) content.picture = profileData.picture;
  if (profileData.about) content.about = profileData.about;
  if (profileData.nip05) content.nip05 = profileData.nip05;
  if (profileData.lud16) content.lud16 = profileData.lud16;
  if (profileData.website) content.website = profileData.website;
  if (profileData.banner) content.banner = profileData.banner;

  return {
    kind: KIND.METADATA,
    content: JSON.stringify(content),
    tags: [],
    created_at: Math.floor(Date.now() / 1000),
    pubkey: myPubkey,
  };
}

/**
 * Publish an event to write relays.
 * Retries failed relays once after a short delay.
 */
export async function publishEvent(event: SignedEvent): Promise<{ success: string[]; failed: string[] }> {
  const relayList = await loadRelayList();
  const writeRelays = getWriteRelays(relayList);

  if (writeRelays.length === 0) {
    // Fall back to defaults if no write relays configured
    writeRelays.push('wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.snort.social');
  }

  const success: string[] = [];
  const failed: string[] = [];

  const promises = writeRelays.map((relayUrl) =>
    publishToRelay(relayUrl, event)
      .then((ok) => { if (ok) success.push(relayUrl); else failed.push(relayUrl); })
      .catch(() => { failed.push(relayUrl); })
  );

  await Promise.allSettled(promises);

  // Retry failed relays once
  if (failed.length > 0 && success.length === 0) {
    await new Promise((r) => setTimeout(r, 1000));
    const retryPromises = failed.splice(0).map((relayUrl) =>
      publishToRelay(relayUrl, event)
        .then((ok) => { if (ok) success.push(relayUrl); else failed.push(relayUrl); })
        .catch(() => { failed.push(relayUrl); })
    );
    await Promise.allSettled(retryPromises);
  }

  return { success, failed };
}

async function publishToRelay(relayUrl: string, event: SignedEvent): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { ws.close(); resolve(false); }, 8000);

    let ws: WebSocket;
    try {
      ws = new WebSocket(relayUrl);
    } catch {
      clearTimeout(timer);
      resolve(false);
      return;
    }

    ws.onopen = () => {
      ws.send(JSON.stringify(['EVENT', event]));
    };

    ws.onmessage = (msg) => {
      try {
        const data = JSON.parse(msg.data);
        if (data[0] === 'OK') {
          clearTimeout(timer);
          ws.close();
          resolve(data[2] === true);
        } else if (data[0] === 'NOTICE') {
          // Some relays send NOTICE before OK
          console.warn(`Relay ${relayUrl} notice:`, data[1]);
        }
      } catch {}
    };

    ws.onerror = () => {
      clearTimeout(timer);
      resolve(false);
    };

    ws.onclose = () => {
      clearTimeout(timer);
    };
  });
}

/**
 * Fetch my own profile from relays.
 */
export async function fetchMyProfile(
  pubkey: string,
  relayUrl?: string,
  timeout = 8000
): Promise<ProfileMetadata | null> {
  const relayList = await loadRelayList();
  const relay = relayUrl || getReadRelays(relayList)[0] || 'wss://relay.damus.io';

  return new Promise((resolve) => {
    const timer = setTimeout(() => { ws.close(); resolve(null); }, timeout);

    let ws: WebSocket;
    try {
      ws = new WebSocket(relay);
    } catch {
      clearTimeout(timer);
      resolve(null);
      return;
    }

    const subId = `myprofile_${Math.random().toString(36).slice(2, 8)}`;

    ws.onopen = () => {
      ws.send(JSON.stringify(['REQ', subId, {
        kinds: [KIND.METADATA],
        authors: [pubkey],
        limit: 1,
      }]));
    };

    ws.onmessage = (msg) => {
      try {
        const data = JSON.parse(msg.data);
        if (data[0] === 'EVENT' && data[1] === subId) {
          const content = JSON.parse(data[2].content);
          clearTimeout(timer);
          ws.close();
          resolve({
            pubkey,
            name: content.name,
            displayName: content.display_name,
            picture: content.picture,
            banner: content.banner,
            about: content.about,
            nip05: content.nip05,
            lud16: content.lud16,
            website: content.website,
          });
        } else if (data[0] === 'EOSE') {
          clearTimeout(timer);
          ws.close();
          resolve(null);
        }
      } catch {}
    };

    ws.onerror = () => {
      clearTimeout(timer);
      resolve(null);
    };
  });
}
