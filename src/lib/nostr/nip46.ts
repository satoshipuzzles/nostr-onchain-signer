/**
 * NIP-46 remote signer (Nostr Connect) client — used to sign with Amber.
 *
 * Amber is a NIP-46 signer that, in addition to the usual Nostr methods,
 * implements `sign_psbt` (Amber v6.1.0+). That lets a user keep their key on
 * their phone / in Amber and sign Bitcoin PSBTs here without the nsec ever
 * touching this app.
 *
 * We connect over a `bunker://` URL (or a NIP-05 bunker identifier) and persist
 * a locally-generated client key so the session survives reloads. The remote
 * signer (Amber) is itself the approval surface — every request pops up on the
 * user's device — so we do NOT expose these primitives to web pages; this
 * module only ever runs in our own UI (popup / PWA).
 */

import { BunkerSigner, parseBunkerInput, type BunkerPointer } from 'nostr-tools/nip46';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { SimplePool } from 'nostr-tools/pool';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';

const STORAGE_KEY = 'nip46_connection';

export interface RemoteSignerConnection {
  /** Local client key used to encrypt the NIP-46 channel (hex). */
  clientSecretKeyHex: string;
  /** Remote signer (bunker) pubkey + relays + optional secret. */
  bunker: BunkerPointer;
  /** The user pubkey the remote signer signs as (hex). */
  userPubkey: string;
  connectedAt: number;
}

const CLIENT_METADATA = {
  name: 'Nostr Onchain Signer',
  url: 'https://nostrfreaks.com',
};

// Reuse one relay pool for all remote-signer traffic.
let pool: SimplePool | null = null;
function getPool(): SimplePool {
  if (!pool) pool = new SimplePool();
  return pool;
}

let activeSigner: BunkerSigner | null = null;

export async function loadRemoteConnection(): Promise<RemoteSignerConnection | null> {
  try {
    const result = await chrome.storage.local.get(STORAGE_KEY);
    return (result[STORAGE_KEY] as RemoteSignerConnection) ?? null;
  } catch {
    return null;
  }
}

export async function isRemoteSignerConnected(): Promise<boolean> {
  const conn = await loadRemoteConnection();
  return !!conn?.userPubkey;
}

/** Parse a bunker:// URL or a name@domain NIP-05 bunker identifier. */
export async function parseRemoteSignerInput(input: string): Promise<BunkerPointer | null> {
  return parseBunkerInput(input.trim());
}

/**
 * Connect to a remote signer (Amber). Generates a fresh client key, performs
 * the NIP-46 `connect` handshake, resolves the user pubkey, and persists the
 * session. `onAuthUrl` is called if the signer requires the user to approve
 * the connection at a URL (some bunkers do this on first connect).
 */
export async function connectRemoteSigner(
  input: string,
  onAuthUrl?: (url: string) => void,
): Promise<RemoteSignerConnection> {
  const bunker = await parseRemoteSignerInput(input);
  if (!bunker) {
    throw new Error('Invalid bunker URL. Paste a bunker:// string or NIP-05 bunker identifier from Amber.');
  }
  if (!bunker.relays || bunker.relays.length === 0) {
    throw new Error('This bunker URL has no relays — copy the full bunker:// string from Amber.');
  }

  const clientSecretKey = generateSecretKey();
  const signer = BunkerSigner.fromBunker(clientSecretKey, bunker, {
    pool: getPool(),
    onauth: (url) => onAuthUrl?.(url),
  });

  await signer.connect(CLIENT_METADATA);
  const userPubkey = await signer.getPublicKey();

  const connection: RemoteSignerConnection = {
    clientSecretKeyHex: bytesToHex(clientSecretKey),
    bunker,
    userPubkey,
    connectedAt: Date.now(),
  };

  await chrome.storage.local.set({ [STORAGE_KEY]: connection });
  activeSigner = signer;
  return connection;
}

/** Rehydrate (or reuse) the BunkerSigner for the persisted connection. */
export async function getActiveRemoteSigner(): Promise<BunkerSigner | null> {
  if (activeSigner) return activeSigner;
  const conn = await loadRemoteConnection();
  if (!conn) return null;
  activeSigner = BunkerSigner.fromBunker(
    hexToBytes(conn.clientSecretKeyHex),
    conn.bunker,
    { pool: getPool() },
  );
  return activeSigner;
}

export async function disconnectRemoteSigner(): Promise<void> {
  try {
    await activeSigner?.close();
  } catch {
    /* best effort */
  }
  activeSigner = null;
  await chrome.storage.local.remove(STORAGE_KEY);
}

/**
 * Ask the remote signer (Amber) to sign a PSBT. Sends the base64-encoded PSBT
 * via the NIP-46 `sign_psbt` method and returns the base64-encoded signed PSBT.
 */
export async function signPsbtBase64ViaRemote(psbtBase64: string): Promise<string> {
  const signer = await getActiveRemoteSigner();
  if (!signer) throw new Error('No remote signer connected. Pair Amber in Settings first.');

  const result = await signer.sendRequest('sign_psbt', [psbtBase64]);
  if (!result || typeof result !== 'string') {
    throw new Error('Remote signer returned no signed PSBT');
  }
  // Some signers wrap the result as JSON ({ "psbt": "..." }); accept both.
  const trimmed = result.trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as { psbt?: string; result?: string };
      return parsed.psbt ?? parsed.result ?? trimmed;
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}
