/**
 * Nostr key management utilities.
 */

import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { secp256k1 } from '@noble/curves/secp256k1';
import { bech32 } from '@scure/base';

export interface NostrKeyPair {
  privateKeyHex: string;
  publicKeyHex: string;
  npub: string;
  nsec: string;
}

export function generateKeyPair(): NostrKeyPair {
  const privateKey = secp256k1.utils.randomPrivateKey();
  const privateKeyHex = bytesToHex(privateKey);
  const publicKey = secp256k1.getPublicKey(privateKey, true).slice(1); // x-only
  const publicKeyHex = bytesToHex(publicKey);

  return {
    privateKeyHex,
    publicKeyHex,
    npub: pubkeyToNpub(publicKeyHex),
    nsec: privkeyToNsec(privateKeyHex),
  };
}

export function keyPairFromPrivateKey(privateKeyHex: string): NostrKeyPair {
  const privateKey = hexToBytes(privateKeyHex);
  const publicKey = secp256k1.getPublicKey(privateKey, true).slice(1);
  const publicKeyHex = bytesToHex(publicKey);

  return {
    privateKeyHex,
    publicKeyHex,
    npub: pubkeyToNpub(publicKeyHex),
    nsec: privkeyToNsec(privateKeyHex),
  };
}

export function pubkeyToNpub(pubkeyHex: string): string {
  const words = bech32.toWords(hexToBytes(pubkeyHex));
  return bech32.encode('npub', words);
}

export function npubToPubkey(npub: string): string {
  const decoded = bech32.decode(npub as `${string}1${string}`);
  if (!npub.startsWith('npub1')) throw new Error('Invalid npub');
  return bytesToHex(bech32.fromWords(decoded.words));
}

export function privkeyToNsec(privkeyHex: string): string {
  const words = bech32.toWords(hexToBytes(privkeyHex));
  return bech32.encode('nsec', words);
}

/**
 * Read a secret key however it was pasted: nsec1…, NSEC1… (QR codes), with a
 * nostr: prefix, wrapped in quotes or whitespace, or as 64-char hex. Anything
 * else gets an error that says what was actually pasted, because "Invalid
 * nsec" for an npub or a bunker link leaves people guessing.
 */
export function nsecToPrivkey(input: string): string {
  const v = input.trim().replace(/^["'`]+|["'`]+$/g, '').replace(/^nostr:/i, '').replace(/\s+/g, '');
  const lower = v.toLowerCase();
  if (lower.startsWith('nsec1')) {
    let words: number[];
    try {
      words = bech32.decode(lower as `${string}1${string}`).words;
    } catch {
      throw new Error('That nsec is mistyped or cut off — check you copied all of it');
    }
    const key = bech32.fromWords(words);
    if (key.length !== 32) throw new Error('That nsec has the wrong length');
    return bytesToHex(Uint8Array.from(key));
  }
  if (/^[0-9a-f]{64}$/.test(lower)) return lower;
  if (lower.startsWith('npub1')) throw new Error('That is a public key (npub). Paste the secret key — it starts with nsec1');
  if (lower.startsWith('ncryptsec1')) throw new Error('That is a password-encrypted key (ncryptsec). Decrypt it in the app that made it, then paste the nsec');
  if (lower.startsWith('bunker://') || lower.startsWith('nostrconnect://')) throw new Error('That is a remote-signer link. Use Add account → "Bunker (NIP-46)" instead');
  if (!v) throw new Error('Paste your nsec');
  throw new Error('Not a secret key. Paste an nsec1… key or 64-character hex');
}

export function isValidNpub(input: string): boolean {
  try {
    npubToPubkey(input);
    return true;
  } catch {
    return false;
  }
}

export function isValidNsec(input: string): boolean {
  try {
    nsecToPrivkey(input);
    return true;
  } catch {
    return false;
  }
}

export function isValidHexPubkey(input: string): boolean {
  return /^[0-9a-f]{64}$/i.test(input);
}
