/**
 * Wallet config sync via Nostr relays using NIP-78 (kind 30078).
 *
 * Multi-sig wallets are deterministic — given the same pubkeys + threshold,
 * the same address is derived. We only persist the config, not the full
 * wallet object. Content is AES-256-GCM encrypted with a key derived from
 * the user's vault password + public key.
 */

import { encryptContent, decryptContent } from './social-unlock';
import { publishEvent } from './discovery';
import { createMessageId } from '@/shared/messages';
import { loadRelayList, getReadRelays } from './relays';

const WALLET_D_TAG = 'nostr-onchain-wallets';
const KIND_APP_DATA = 30078;

export interface SyncableWalletConfig {
  id: string;
  name: string;
  description?: string;
  threshold: number;
  pubkeys: string[];
  createdAt: number;
}

/**
 * Publish encrypted wallet configs to relays.
 * Uses kind 30078 (replaceable) with d-tag "nostr-onchain-wallets".
 */
export async function publishWalletConfigs(
  configs: SyncableWalletConfig[],
  encryptionKey: string,
): Promise<void> {
  const plaintext = JSON.stringify(configs);
  const { encrypted } = await encryptContent(plaintext, encryptionKey);

  const event = {
    kind: KIND_APP_DATA,
    content: encrypted,
    tags: [['d', WALLET_D_TAG]],
    created_at: Math.floor(Date.now() / 1000),
  };

  const signResponse = await chrome.runtime.sendMessage({
    type: 'nip07:signEvent',
    payload: { event },
    id: createMessageId(),
  });

  if (signResponse.error) throw new Error(signResponse.error);
  await publishEvent(signResponse.result);
}

/**
 * Fetch and decrypt wallet configs from relays.
 * Tries up to 3 read relays, returns the first successful result.
 */
export async function fetchWalletConfigs(
  pubkey: string,
  encryptionKey: string,
): Promise<SyncableWalletConfig[]> {
  const relayList = await loadRelayList();
  const relays = getReadRelays(relayList);

  for (const relayUrl of relays.slice(0, 3)) {
    try {
      const config = await fetchFromRelay(relayUrl, pubkey, encryptionKey);
      if (config) return config;
    } catch {
      // try next relay
    }
  }
  return [];
}

async function fetchFromRelay(
  relayUrl: string,
  pubkey: string,
  encryptionKey: string,
): Promise<SyncableWalletConfig[] | null> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      ws.close();
      resolve(null);
    }, 10000);
    const ws = new WebSocket(relayUrl);
    const subId = Math.random().toString(36).slice(2, 10);

    ws.onopen = () => {
      ws.send(
        JSON.stringify([
          'REQ',
          subId,
          {
            kinds: [KIND_APP_DATA],
            authors: [pubkey],
            '#d': [WALLET_D_TAG],
            limit: 1,
          },
        ]),
      );
    };

    ws.onmessage = (msg) => {
      try {
        const data = JSON.parse(msg.data as string);
        if (data[0] === 'EVENT' && data[1] === subId && data[2]) {
          clearTimeout(timeout);
          ws.close();
          decryptContent(data[2].content, encryptionKey)
            .then((decrypted) => {
              const configs = JSON.parse(decrypted);
              resolve(Array.isArray(configs) ? configs : null);
            })
            .catch(() => resolve(null));
        } else if (data[0] === 'EOSE') {
          clearTimeout(timeout);
          ws.close();
          resolve(null);
        }
      } catch {
        // ignore parse errors
      }
    };

    ws.onerror = () => {
      clearTimeout(timeout);
      ws.close();
      resolve(null);
    };
  });
}
