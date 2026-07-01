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

export function nsecToPrivkey(nsec: string): string {
  const decoded = bech32.decode(nsec as `${string}1${string}`);
  if (!nsec.startsWith('nsec1')) throw new Error('Invalid nsec');
  return bytesToHex(bech32.fromWords(decoded.words));
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
