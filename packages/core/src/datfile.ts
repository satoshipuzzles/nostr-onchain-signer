/**
 * EXPERIMENTAL best-effort read-only import of Bitcoin Core wallet.dat files.
 *
 * Core wallets are Berkeley DB (legacy) or SQLite (descriptor) databases.
 * Fully parsing them is out of scope; instead we scan for the DER-encoded EC
 * private key records Core writes (the pywallet approach) and surface any
 * candidate keys so the user can verify and import them. This never writes
 * anything and can miss keys in encrypted wallets (those need the passphrase
 * and Core itself).
 */

import { secp256k1 } from '@noble/curves/secp256k1';
import { bytesToHex } from '@noble/hashes/utils';

export interface DatImportResult {
  container: 'berkeleydb' | 'sqlite' | 'unknown';
  encrypted: boolean;
  /** Candidate raw private keys (hex) found in plaintext key records. */
  candidateKeys: string[];
  warnings: string[];
}

function findSubsequence(haystack: Uint8Array, needle: number[], from: number): number {
  outer: for (let i = from; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

export function importWalletDat(bytes: Uint8Array): DatImportResult {
  const warnings: string[] = [
    'wallet.dat import is experimental and read-only. Verify every recovered key/address before use.',
  ];

  let container: DatImportResult['container'] = 'unknown';
  // Berkeley DB magic 0x00053162 appears at offset 12 (any page size)
  if (bytes.length > 16) {
    const magicAt12 =
      (bytes[12] === 0x62 && bytes[13] === 0x31 && bytes[14] === 0x05 && bytes[15] === 0x00) ||
      (bytes[12] === 0x00 && bytes[13] === 0x05 && bytes[14] === 0x31 && bytes[15] === 0x62);
    if (magicAt12) container = 'berkeleydb';
  }
  const sqliteMagic = 'SQLite format 3';
  if (container === 'unknown' && bytes.length > 16) {
    const header = new TextDecoder().decode(bytes.slice(0, 15));
    if (header === sqliteMagic) container = 'sqlite';
  }

  // Encrypted wallets store "mkey" (master key) records
  const encrypted = findSubsequence(bytes, [0x04, 0x6d, 0x6b, 0x65, 0x79], 0) !== -1; // len-prefixed "mkey"
  if (encrypted) {
    warnings.push('This wallet appears to be encrypted — plaintext keys cannot be recovered without the passphrase. Use Bitcoin Core to decrypt/export.');
  }

  // Plaintext key records embed DER EC private keys: ... 0x04 0x20 <32-byte key> ...
  // Core's DER layout starts with 30 81 d3 02 01 01 04 20 <key>
  const candidateKeys: string[] = [];
  const seen = new Set<string>();
  const derPrefix = [0x30, 0x81, 0xd3, 0x02, 0x01, 0x01, 0x04, 0x20];
  const shortPrefix = [0x02, 0x01, 0x01, 0x04, 0x20];
  for (const prefix of [derPrefix, shortPrefix]) {
    let idx = 0;
    while ((idx = findSubsequence(bytes, prefix, idx)) !== -1) {
      const start = idx + prefix.length;
      const key = bytes.slice(start, start + 32);
      idx = start;
      if (key.length !== 32) continue;
      const hexKey = bytesToHex(key);
      if (seen.has(hexKey)) continue;
      try {
        if (secp256k1.utils.isValidPrivateKey(key)) {
          seen.add(hexKey);
          candidateKeys.push(hexKey);
        }
      } catch {
        // not a valid key — keep scanning
      }
      if (candidateKeys.length >= 200) break;
    }
  }

  if (candidateKeys.length === 0 && !encrypted) {
    warnings.push('No plaintext keys found. Descriptor (SQLite) wallets should be exported from Core with `listdescriptors true` and imported here as descriptors.');
  }

  return { container, encrypted, candidateKeys, warnings };
}
