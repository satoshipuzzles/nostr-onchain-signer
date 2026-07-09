/**
 * Relay list management.
 * Users can configure read and write relays independently.
 * Default: wss://relay.damus.io on both.
 */

export interface RelayConfig {
  url: string;
  read: boolean;
  write: boolean;
}

export interface RelayList {
  relays: RelayConfig[];
  updatedAt: number;
}

const DEFAULT_RELAY: RelayConfig = {
  url: 'wss://relay.damus.io',
  read: true,
  write: true,
};

const DEFAULT_RELAYS: RelayConfig[] = [
  { url: 'wss://relay.damus.io', read: true, write: true },
  { url: 'wss://nos.lol', read: true, write: true },
  { url: 'wss://relay.snort.social', read: true, write: true },
];

const SUGGESTED_RELAYS: RelayConfig[] = [
  { url: 'wss://relay.damus.io', read: true, write: true },
  { url: 'wss://nos.lol', read: true, write: true },
  { url: 'wss://relay.nostr.band', read: true, write: false },
  { url: 'wss://purplepag.es', read: true, write: false },
  { url: 'wss://relay.snort.social', read: true, write: true },
  { url: 'wss://nostr.wine', read: true, write: false },
  { url: 'wss://relay.nostr.bg', read: true, write: true },
  { url: 'wss://nostr-pub.wellorder.net', read: true, write: true },
];

export function getDefaultRelayList(): RelayList {
  return {
    relays: DEFAULT_RELAYS,
    updatedAt: Date.now(),
  };
}

export function getSuggestedRelays(): RelayConfig[] {
  return SUGGESTED_RELAYS;
}

export async function loadRelayList(): Promise<RelayList> {
  const result = await chrome.storage.local.get('relayList');
  const list: RelayList = result.relayList ?? getDefaultRelayList();
  const writeCount = list.relays.filter((r) => r.write).length;
  const readCount = list.relays.filter((r) => r.read).length;
  if (writeCount === 0 || readCount === 0 || list.relays.length === 0) {
    const defaults = getDefaultRelayList();
    chrome.storage.local.set({ relayList: defaults }).catch(() => {});
    return defaults;
  }
  return list;
}

export async function saveRelayList(list: RelayList): Promise<void> {
  await chrome.storage.local.set({ relayList: { ...list, updatedAt: Date.now() } });
}

export function getReadRelays(list: RelayList): string[] {
  return list.relays.filter((r) => r.read).map((r) => r.url);
}

export function getWriteRelays(list: RelayList): string[] {
  return list.relays.filter((r) => r.write).map((r) => r.url);
}

export function addRelay(list: RelayList, url: string, read: boolean, write: boolean): RelayList {
  const normalized = normalizeRelayUrl(url);
  if (list.relays.some((r) => r.url === normalized)) {
    return list;
  }
  return {
    ...list,
    relays: [...list.relays, { url: normalized, read, write }],
    updatedAt: Date.now(),
  };
}

export function removeRelay(list: RelayList, url: string): RelayList {
  return {
    ...list,
    relays: list.relays.filter((r) => r.url !== url),
    updatedAt: Date.now(),
  };
}

export function updateRelay(list: RelayList, url: string, read: boolean, write: boolean): RelayList {
  return {
    ...list,
    relays: list.relays.map((r) => (r.url === url ? { ...r, read, write } : r)),
    updatedAt: Date.now(),
  };
}

function normalizeRelayUrl(url: string): string {
  let normalized = url.trim().toLowerCase();
  if (!normalized.startsWith('wss://') && !normalized.startsWith('ws://')) {
    normalized = 'wss://' + normalized;
  }
  if (normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}
