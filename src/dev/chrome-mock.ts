/**
 * Mock chrome.* APIs for PWA / standalone web mode.
 *
 * Uses localStorage for persistence (survives page refreshes).
 * Handles signing via the actual signEvent function with real keys.
 */

import { signEvent, type UnsignedEvent } from '@/lib/nostr/events';
import { generateKeyPair, keyPairFromPrivateKey } from '@/lib/nostr/keys';
import { encryptNip04, decryptNip04, encryptNip44, decryptNip44 } from '@/lib/nostr/dm-crypto';

const STORAGE_PREFIX = 'nostr_onchain_';

// Cache keys that are safe to evict when storage quota is exceeded.
// Ordered by eviction priority (biggest/least-important first).
const EVICTABLE_KEYS = [
  'nostr_onchain_tx_cache',
  'nostr_onchain_profile_cache_v2',
  'nostr_onchain_blocks_cache',
  'nostr_onchain_balance_cache',
  'nostr_onchain_signed_events_log',
  'nostr_onchain_feed_cache',
  'nostr_onchain_dm_cache',
];

function evictCaches(): boolean {
  let evicted = false;
  for (const key of EVICTABLE_KEYS) {
    if (localStorage.getItem(key) !== null) {
      localStorage.removeItem(key);
      evicted = true;
    }
  }
  if (!evicted) {
    // Last resort: remove any non-critical prefixed keys (never vault/accounts)
    const critical = ['nostr_onchain_vault', 'nostr_onchain_activeAccountIndex', 'nostr_onchain_multisig_wallets'];
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && k.includes('cache') && !critical.includes(k)) {
        localStorage.removeItem(k);
        evicted = true;
      }
    }
  }
  return evicted;
}

function logSignedEvent(event: any, origin: string) {
  // Never let bookkeeping break signing
  try {
    const log = (storageGet('signed_events_log') as any[]) || [];
    log.unshift({
      id: event.id,
      kind: event.kind,
      content: (event.content || '').slice(0, 100),
      created_at: event.created_at,
      origin,
      pubkey: event.pubkey,
    });
    if (log.length > 100) log.length = 100;
    storageSet('signed_events_log', log);

    const apps = (storageGet('connected_apps') as any[]) || [];
    const existing = apps.find((a: any) => a.origin === origin);
    if (existing) {
      existing.lastUsed = Date.now();
      existing.signCount++;
    } else {
      apps.push({ origin, name: origin, firstUsed: Date.now(), lastUsed: Date.now(), signCount: 1, permission: 'always' });
    }
    storageSet('connected_apps', apps);
  } catch {}
}

function storageGet(key: string): unknown {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + key);
    return raw ? JSON.parse(raw) : undefined;
  } catch { return undefined; }
}

function storageSet(key: string, value: unknown) {
  const serialized = JSON.stringify(value);
  try {
    localStorage.setItem(STORAGE_PREFIX + key, serialized);
  } catch (err) {
    // QuotaExceededError: evict caches and retry once
    console.warn('[PWA] Storage quota exceeded, evicting caches...');
    if (evictCaches()) {
      try {
        localStorage.setItem(STORAGE_PREFIX + key, serialized);
        return;
      } catch {}
    }
    // Only re-throw for critical data (vault, accounts); drop cache writes silently
    const isCritical = key === 'vault' || key === 'activeAccountIndex' || key.includes('wallet');
    if (isCritical) throw err;
  }
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

function getActiveIndex(): number {
  const stored = storageGet('activeAccountIndex');
  if (typeof stored === 'number' && stored >= 0) {
    sessionSet('active_index', stored);
    return stored;
  }
  const session = sessionGet('active_index');
  if (typeof session === 'number' && session >= 0) return session;
  return 0;
}

interface ExternalNostr {
  getPublicKey?: () => Promise<string>;
  signEvent?: (e: unknown) => Promise<any>;
  signSchnorr?: (h: string) => Promise<string>;
  nip04?: { encrypt?: (pk: string, pt: string) => Promise<string>; decrypt?: (pk: string, ct: string) => Promise<string> };
  nip44?: { encrypt?: (pk: string, pt: string) => Promise<string>; decrypt?: (pk: string, ct: string) => Promise<string> };
}

/** External NIP-07 signer injected by a browser extension (Alby, nos2x, our extension bridge). */
function externalNostr(): ExternalNostr | null {
  const n = (window as any).nostr;
  return n && typeof n === 'object' ? (n as ExternalNostr) : null;
}

/**
 * The per-tab session can vanish while the UI still looks logged in (new tab,
 * mobile PWA process kill). Tell the app shell so it can show the unlock
 * screen instead of letting every action dead-end with "Vault is locked".
 */
function notifySessionLost() {
  try {
    window.dispatchEvent(new CustomEvent('nostr-onchain:session-lost'));
  } catch { /* ignore */ }
}

function isValidPrivHex(k: unknown): k is string {
  return typeof k === 'string' && k.length === 64 && /^[0-9a-f]+$/i.test(k);
}

const mockChrome = {
  runtime: {
    id: 'pwa-mode',
    getURL: (path: string) => `/${path}`,
    connect: () => ({
      onMessage: { addListener: () => {}, removeListener: () => {} },
      onDisconnect: { addListener: () => {} },
      postMessage: () => {},
      disconnect: () => {},
    }),
    sendMessage: async (message: { type: string; payload?: unknown; id: string }) => {
      const { type, payload, id } = message;

      switch (type) {
        case 'vault:status': {
          const vault = storageGet('vault');
          const session = sessionGet('session_keys') as Array<{privateKeyHex: string; publicKeyHex: string}> | undefined;
          const activeIdx = getActiveIndex();
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
            const idx = getActiveIndex();
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
          storageSet('activeAccountIndex', index);
          sessionSet('active_index', index);
          const newKey = session[index];
          return { id, result: { publicKey: newKey.publicKeyHex, index } };
        }

        case 'vault:getPrivateKey': {
          const session = sessionGet('session_keys') as any[];
          if (!session) return { id, error: 'Vault is locked' };
          const idx = getActiveIndex();
          const key = session[idx];
          if (!key?.privateKeyHex || key.privateKeyHex.length !== 64) {
            return { id, error: 'No private key available' };
          }
          return { id, result: key.privateKeyHex };
        }

        case 'nip07:getPublicKey': {
          const session = sessionGet('session_keys') as any[];
          if (session) {
            const idx = getActiveIndex();
            return { id, result: session[idx].publicKeyHex };
          }
          // Session lost — the user's NIP-07 extension can still identify them
          const ext = externalNostr();
          if (typeof ext?.getPublicKey === 'function') {
            try {
              return { id, result: await ext.getPublicKey() };
            } catch { /* fall through to locked error */ }
          }
          notifySessionLost();
          return { id, error: 'Vault is locked — unlock the app to continue' };
        }

        case 'nip07:signEvent': {
          const session = sessionGet('session_keys') as any[];
          const { event } = (payload || {}) as { event: Omit<UnsignedEvent, 'pubkey'> };
          const key = session ? session[getActiveIndex()] : null;

          // 1. Vault key available — sign locally
          if (key && isValidPrivHex(key.privateKeyHex)) {
            const unsigned: UnsignedEvent = { ...event, pubkey: key.publicKeyHex };
            const signed = signEvent(unsigned, key.privateKeyHex);
            logSignedEvent(signed, 'nostr-onchain-pwa');
            return { id, result: signed };
          }

          // 2. External NIP-07 signer — covers extension-linked accounts AND a
          //    lost session (any NIP-07 signer can sign Nostr events)
          const ext = externalNostr();
          if (typeof ext?.signEvent === 'function') {
            try {
              const signed = await ext.signEvent(
                key ? { ...event, pubkey: key.publicKeyHex } : event,
              );
              logSignedEvent(signed, 'nostr-onchain-pwa');
              return { id, result: signed };
            } catch (err: any) {
              if (!session) notifySessionLost();
              return { id, error: `NIP-07 sign failed: ${err?.message || err}` };
            }
          }

          if (!session) {
            notifySessionLost();
            return { id, error: 'Vault is locked — unlock the app to continue' };
          }
          return { id, error: 'No private key and no NIP-07 extension available. Install a Nostr signer extension.' };
        }

        case 'nip07:getRelays':
          return { id, result: {} };

        case 'nip07:signSchnorr': {
          const session = sessionGet('session_keys') as any[];
          const key = session ? session[getActiveIndex()] : null;
          const { hash } = (payload || {}) as { hash: string };
          if (!hash) return { id, error: 'Missing hash' };

          if (key && isValidPrivHex(key.privateKeyHex)) {
            try {
              const { schnorrSign } = await import('@/lib/bitcoin/psbt');
              const { hexToBytes, bytesToHex } = await import('@noble/hashes/utils');
              const sig = schnorrSign(hexToBytes(hash.replace(/^0x/, '')), key.privateKeyHex);
              return { id, result: bytesToHex(sig) };
            } catch (err: any) {
              return { id, error: err?.message || 'Schnorr sign failed' };
            }
          }

          // External NIP-07 signer (Alby, our extension bridge, …) — also the
          // path when the session was lost but a signer extension is present
          const ext = externalNostr();
          if (typeof ext?.signSchnorr === 'function') {
            try {
              const sig = await ext.signSchnorr(hash);
              return { id, result: sig };
            } catch (err: any) {
              return { id, error: `NIP-07 signSchnorr failed: ${err?.message || err}` };
            }
          }
          if (!session) return { id, error: 'Vault is locked — unlock the app to continue' };
          return { id, error: 'No private key and no NIP-07 signSchnorr available' };
        }

        case 'nip07:nip04:encrypt': {
          const session = sessionGet('session_keys') as any[];
          const key = session ? session[getActiveIndex()] : null;
          const { pubkey, plaintext } = (payload || {}) as { pubkey: string; plaintext: string };
          if (key && isValidPrivHex(key.privateKeyHex)) {
            try {
              const encrypted = await encryptNip04(key.privateKeyHex, pubkey, plaintext);
              return { id, result: encrypted };
            } catch (err: any) {
              return { id, error: err?.message || 'NIP-04 encrypt failed' };
            }
          }
          const ext = externalNostr();
          if (typeof ext?.nip04?.encrypt === 'function') {
            try {
              return { id, result: await ext.nip04.encrypt(pubkey, plaintext) };
            } catch (err: any) {
              return { id, error: `NIP-07 nip04 encrypt failed: ${err?.message || err}` };
            }
          }
          return { id, error: session ? 'No private key for DM encryption' : 'Vault is locked — unlock the app to continue' };
        }

        case 'nip07:nip04:decrypt': {
          const session = sessionGet('session_keys') as any[];
          const key = session ? session[getActiveIndex()] : null;
          const { pubkey, ciphertext } = (payload || {}) as { pubkey: string; ciphertext: string };
          if (key && isValidPrivHex(key.privateKeyHex)) {
            try {
              const decrypted = await decryptNip04(key.privateKeyHex, pubkey, ciphertext);
              return { id, result: decrypted };
            } catch (err: any) {
              return { id, error: err?.message || 'NIP-04 decrypt failed' };
            }
          }
          const ext = externalNostr();
          if (typeof ext?.nip04?.decrypt === 'function') {
            try {
              return { id, result: await ext.nip04.decrypt(pubkey, ciphertext) };
            } catch (err: any) {
              return { id, error: `NIP-07 nip04 decrypt failed: ${err?.message || err}` };
            }
          }
          return { id, error: session ? 'No private key for DM decryption' : 'Vault is locked — unlock the app to continue' };
        }

        case 'nip07:nip44:encrypt': {
          const session = sessionGet('session_keys') as any[];
          const key = session ? session[getActiveIndex()] : null;
          const { pubkey, plaintext } = (payload || {}) as { pubkey: string; plaintext: string };
          if (key && isValidPrivHex(key.privateKeyHex)) {
            try {
              const encrypted = encryptNip44(key.privateKeyHex, pubkey, plaintext);
              return { id, result: encrypted };
            } catch (err: any) {
              return { id, error: err?.message || 'NIP-44 encrypt failed' };
            }
          }
          const ext = externalNostr();
          if (typeof ext?.nip44?.encrypt === 'function') {
            try {
              return { id, result: await ext.nip44.encrypt(pubkey, plaintext) };
            } catch (err: any) {
              return { id, error: `NIP-07 nip44 encrypt failed: ${err?.message || err}` };
            }
          }
          return { id, error: session ? 'No private key for DM encryption' : 'Vault is locked — unlock the app to continue' };
        }

        case 'nip07:nip44:decrypt': {
          const session = sessionGet('session_keys') as any[];
          const key = session ? session[getActiveIndex()] : null;
          const { pubkey, ciphertext } = (payload || {}) as { pubkey: string; ciphertext: string };
          if (key && isValidPrivHex(key.privateKeyHex)) {
            try {
              const decrypted = decryptNip44(key.privateKeyHex, pubkey, ciphertext);
              return { id, result: decrypted };
            } catch (err: any) {
              return { id, error: err?.message || 'NIP-44 decrypt failed' };
            }
          }
          const ext = externalNostr();
          if (typeof ext?.nip44?.decrypt === 'function') {
            try {
              return { id, result: await ext.nip44.decrypt(pubkey, ciphertext) };
            } catch (err: any) {
              return { id, error: `NIP-07 nip44 decrypt failed: ${err?.message || err}` };
            }
          }
          return { id, error: session ? 'No private key for DM decryption' : 'Vault is locked — unlock the app to continue' };
        }

        case 'btc:getAddress': {
          const session = sessionGet('session_keys') as any[];
          if (!session) return { id, error: 'Vault is locked' };
          const idx = getActiveIndex();
          const { pubkeyToTaprootAddress } = await import('@/lib/bitcoin/address');
          return { id, result: pubkeyToTaprootAddress(session[idx].publicKeyHex) };
        }

        case 'btc:signPsbtPartial': {
          const session = sessionGet('session_keys') as any[];
          if (!session) return { id, error: 'Vault is locked' };
          const { psbtHex } = (payload || {}) as { psbtHex: string };
          if (!psbtHex) return { id, error: 'Missing psbtHex' };

          // Try every full-key account in the vault, active one first —
          // the co-signer key is often not the currently active account
          const idx = getActiveIndex();
          const ordered = [session[idx], ...session.filter((_, i) => i !== idx)];
          const keys = ordered
            .map((k) => k?.privateKeyHex)
            .filter((k): k is string => typeof k === 'string' && k.length === 64 && /^[0-9a-f]+$/i.test(k));

          if (keys.length === 0) {
            return { id, error: 'No private key in vault — import your nsec to sign PSBTs' };
          }

          try {
            const { signMultisigPsbtWithKeys } = await import('@/lib/bitcoin/multisig-psbt');
            const { psbtHex: signed } = signMultisigPsbtWithKeys(psbtHex, keys);
            return { id, result: { psbtHex: signed } };
          } catch (err: any) {
            return { id, error: err?.message || 'Failed to partial-sign PSBT' };
          }
        }

        case 'btc:signPsbt': {
          const session = sessionGet('session_keys') as any[];
          if (!session) return { id, error: 'Vault is locked' };
          const idx = getActiveIndex();
          const key = session[idx];
          const { psbtHex } = (payload || {}) as { psbtHex: string };
          if (!psbtHex) return { id, error: 'Missing psbtHex' };
          const pubkeyHex = key.publicKeyHex as string;

          const hasValidKey = typeof key.privateKeyHex === 'string' && key.privateKeyHex.length === 64 && /^[0-9a-f]+$/i.test(key.privateKeyHex);
          if (hasValidKey) {
            try {
              const { signAndFinalizePsbt } = await import('@/lib/bitcoin/psbt-builder');
              const result = signAndFinalizePsbt(psbtHex, key.privateKeyHex);
              return { id, result: { ...result, source: 'vault' } };
            } catch (err: any) {
              return { id, error: err?.message || 'Failed to sign PSBT' };
            }
          }

          // NIP-07 path: delegate to browser extension (Alby WebBTC, etc.) — key stays in extension
          try {
            const { tryExternalPsbtSign, externalSignerHelpMessage } = await import('@/lib/bitcoin/psbt-external-sign');
            const external = await tryExternalPsbtSign(psbtHex, pubkeyHex);
            if (external) {
              return { id, result: { txHex: external.txHex, txid: external.txid, source: external.source } };
            }
            return { id, error: externalSignerHelpMessage() || 'No Bitcoin signer available' };
          } catch (err: any) {
            return { id, error: err?.message || 'Extension signing failed' };
          }
        }

        case 'approval:get': {
          const { approvalId } = (payload || {}) as { approvalId: string };
          const pending = sessionGet(`pending_${approvalId}`) as any;
          if (!pending) return { id, error: 'Request not found' };
          return {
            id,
            result: {
              origin: pending.origin,
              type: pending.type,
              preview: pending.preview,
              pubkey: pending.pubkey,
            },
          };
        }

        case 'approval:confirm':
        case 'approval:reject':
          return { id, result: { ok: true } };

        case 'dual:signAndBroadcast': {
          const session = sessionGet('session_keys') as any[];
          if (!session) return { id, error: 'Vault is locked' };
          const idx = getActiveIndex();
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

          logSignedEvent(signedNote, 'nostr-onchain-pwa');

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
