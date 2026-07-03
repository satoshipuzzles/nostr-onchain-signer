/**
 * Mock chrome.* APIs for PWA / standalone web mode.
 *
 * Uses localStorage for persistence (survives page refreshes).
 * Handles signing via the actual signEvent function with real keys.
 */

import { signEvent, type UnsignedEvent } from '@/lib/nostr/events';
import { generateKeyPair, keyPairFromPrivateKey } from '@/lib/nostr/keys';

const STORAGE_PREFIX = 'nostr_onchain_';

function storageGet(key: string): unknown {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + key);
    return raw ? JSON.parse(raw) : undefined;
  } catch { return undefined; }
}

function storageSet(key: string, value: unknown) {
  localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(value));
}

function storageRemove(key: string) {
  localStorage.removeItem(STORAGE_PREFIX + key);
}

function getAllStorage(keys: string | string[]): Record<string, unknown> {
  const keyList = typeof keys === 'string' ? [keys] : keys;
  const result: Record<string, unknown> = {};
  for (const key of keyList) {
    const val = storageGet(key);
    if (val !== undefined) result[key] = val;
  }
  return result;
}

function setAllStorage(items: Record<string, unknown>) {
  for (const [key, value] of Object.entries(items)) {
    storageSet(key, value);
  }
}

// Session state (cleared on tab close but survives refreshes via sessionStorage)
function sessionGet(key: string): unknown {
  try {
    const raw = sessionStorage.getItem(STORAGE_PREFIX + key);
    return raw ? JSON.parse(raw) : undefined;
  } catch { return undefined; }
}

function sessionSet(key: string, value: unknown) {
  sessionStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(value));
}

function sessionRemove(key: string) {
  sessionStorage.removeItem(STORAGE_PREFIX + key);
}

const mockChrome = {
  runtime: {
    id: 'pwa-mode',
    getURL: (path: string) => `/${path}`,
    sendMessage: async (message: { type: string; payload?: unknown; id: string }) => {
      const { type, payload, id } = message;

      switch (type) {
        case 'vault:status': {
          const vault = storageGet('vault');
          const session = sessionGet('session_keys') as Array<{privateKeyHex: string; publicKeyHex: string}> | undefined;
          const activeIdx = (sessionGet('active_index') as number) ?? 0;
          return {
            id,
            result: {
              exists: !!vault,
              unlocked: !!session,
              publicKey: session?.[activeIdx]?.publicKeyHex,
            },
          };
        }

        case 'vault:unlock': {
          const { password } = (payload || {}) as { password?: string };
          const vault = storageGet('vault') as any;
          if (!vault) return { id, error: 'No vault found' };
          try {
            const { decryptVault } = await import('@/lib/crypto/vault');
            const keys = await decryptVault(vault, password!);
            sessionSet('session_keys', keys);
            const idx = (sessionGet('active_index') as number) ?? 0;
            return { id, result: { publicKey: keys[Math.min(idx, keys.length - 1)]?.publicKeyHex } };
          } catch {
            return { id, error: 'Invalid password' };
          }
        }

        case 'vault:lock': {
          sessionRemove('session_keys');
          return { id, result: { locked: true } };
        }

        case 'vault:switchAccount': {
          const { index } = (payload || {}) as { index: number };
          const session = sessionGet('session_keys') as any[];
          if (!session || index < 0 || index >= session.length) return { id, error: 'Invalid index' };
          // Update index synchronously before returning so subsequent signEvent calls use the new key
          sessionSet('active_index', index);
          const newKey = session[index];
          return { id, result: { publicKey: newKey.publicKeyHex, index } };
        }

        case 'nip07:getPublicKey': {
          const session = sessionGet('session_keys') as any[];
          if (!session) return { id, error: 'Vault is locked' };
          const idx = (sessionGet('active_index') as number) ?? 0;
          return { id, result: session[idx].publicKeyHex };
        }

        case 'nip07:signEvent': {
          const session = sessionGet('session_keys') as any[];
          if (!session) return { id, error: 'Vault is locked' };
          const idx = (sessionGet('active_index') as number) ?? 0;
          const key = session[idx];
          const { event } = (payload || {}) as { event: Omit<UnsignedEvent, 'pubkey'> };

          // If no valid private key (NIP-07 login or corrupted), delegate to browser extension
          const hasValidPrivateKey = typeof key.privateKeyHex === 'string' && key.privateKeyHex.length === 64 && /^[0-9a-f]+$/i.test(key.privateKeyHex);
          if (!hasValidPrivateKey) {
            if (typeof (window as any).nostr?.signEvent === 'function') {
              try {
                const signed = await (window as any).nostr.signEvent({ ...event, pubkey: key.publicKeyHex });
                return { id, result: signed };
              } catch (err: any) {
                return { id, error: `NIP-07 sign failed: ${err?.message || err}` };
              }
            }
            return { id, error: 'No private key and no NIP-07 extension available. Install a Nostr signer extension.' };
          }

          const unsigned: UnsignedEvent = { ...event, pubkey: key.publicKeyHex };
          const signed = signEvent(unsigned, key.privateKeyHex);
          return { id, result: signed };
        }

        case 'nip07:getRelays':
          return { id, result: {} };

        case 'btc:getAddress': {
          const session = sessionGet('session_keys') as any[];
          if (!session) return { id, error: 'Vault is locked' };
          const idx = (sessionGet('active_index') as number) ?? 0;
          const { pubkeyToTaprootAddress } = await import('@/lib/bitcoin/address');
          return { id, result: pubkeyToTaprootAddress(session[idx].publicKeyHex) };
        }

        case 'dual:signAndBroadcast': {
          const session = sessionGet('session_keys') as any[];
          if (!session) return { id, error: 'Vault is locked' };
          const idx = (sessionGet('active_index') as number) ?? 0;
          const key = session[idx];
          const { noteContent, recipientAddress, amountSats } = (payload || {}) as any;
          const noteEvent: UnsignedEvent = {
            kind: 1, content: noteContent, tags: [],
            created_at: Math.floor(Date.now() / 1000), pubkey: key.publicKeyHex,
          };

          let signedNote;
          const hasValidKey = typeof key.privateKeyHex === 'string' && key.privateKeyHex.length === 64 && /^[0-9a-f]+$/i.test(key.privateKeyHex);
          if (!hasValidKey) {
            if (typeof (window as any).nostr?.signEvent === 'function') {
              signedNote = await (window as any).nostr.signEvent(noteEvent);
            } else {
              return { id, error: 'No private key and no NIP-07 extension available' };
            }
          } else {
            signedNote = signEvent(noteEvent, key.privateKeyHex);
          }

          const { encodeNostrOpReturn } = await import('@/lib/bitcoin/opreturn');
          const opReturn = encodeNostrOpReturn({ eventId: signedNote.id, kind: signedNote.kind, content: noteContent });
          return { id, result: { signedNote, opReturn: { scriptHex: opReturn.scriptHex, size: opReturn.size }, recipientAddress, amountSats } };
        }

        default:
          console.warn('[PWA Mock] Unhandled:', type);
          return { id, error: `PWA: unhandled ${type}` };
      }
    },
    onMessage: { addListener: () => {} },
  },
  storage: {
    local: {
      get: async (keys: string | string[]) => getAllStorage(keys),
      set: async (items: Record<string, unknown>) => setAllStorage(items),
      remove: async (keys: string | string[]) => {
        const keyList = typeof keys === 'string' ? [keys] : keys;
        for (const key of keyList) storageRemove(key);
      },
    },
    session: {
      get: async (keys: string | string[]) => {
        const keyList = typeof keys === 'string' ? [keys] : keys;
        const result: Record<string, unknown> = {};
        for (const key of keyList) {
          const val = sessionGet(key);
          if (val !== undefined) result[key] = val;
        }
        return result;
      },
      set: async (items: Record<string, unknown>) => {
        for (const [key, value] of Object.entries(items)) sessionSet(key, value);
      },
      remove: async (keys: string | string[]) => {
        const keyList = typeof keys === 'string' ? [keys] : keys;
        for (const key of keyList) sessionRemove(key);
      },
    },
  },
};

if (typeof globalThis.chrome === 'undefined' || !globalThis.chrome?.runtime?.id) {
  (globalThis as unknown as { chrome: typeof mockChrome }).chrome = mockChrome as any;
}

export {};
