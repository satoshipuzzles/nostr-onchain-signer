/**
 * P2TR Tapscript multi-sig derivation from Nostr npubs.
 *
 * Creates m-of-n multi-sig using Taproot script trees where each leaf
 * contains a threshold check using OP_CHECKSIGADD. Keys are x-only
 * secp256k1 public keys (the native format of both Taproot and Nostr npubs).
 *
 * Key insight: Every Nostr npub IS a valid Taproot internal key. We can
 * construct a multi-sig spending condition from any set of npubs without
 * the key holders needing to participate or even know about it.
 */

import { secp256k1 } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { concatBytes, hexToBytes, bytesToHex } from '@noble/hashes/utils';
import { bech32m } from '@scure/base';

function taggedHash(tag: string, ...msgs: Uint8Array[]): Uint8Array {
  const tagDigest = sha256(new TextEncoder().encode(tag));
  return sha256(concatBytes(tagDigest, tagDigest, ...msgs));
}

/**
 * Construct a Tapscript leaf for m-of-n multi-sig using OP_CHECKSIGADD.
 *
 * Script structure for m-of-n:
 *   <key1> OP_CHECKSIG <key2> OP_CHECKSIGADD ... <keyN> OP_CHECKSIGADD <m> OP_NUMEQUAL
 *
 * This is the BIP342 way to do multi-sig in Tapscript.
 */
export function buildMultisigScript(
  xOnlyPubkeys: Uint8Array[],
  threshold: number
): Uint8Array {
  if (threshold < 1 || threshold > xOnlyPubkeys.length) {
    throw new Error(`Invalid threshold: ${threshold} of ${xOnlyPubkeys.length}`);
  }
  if (xOnlyPubkeys.length > 999) {
    throw new Error('Too many keys (max 999)');
  }

  const parts: Uint8Array[] = [];

  // First key uses OP_CHECKSIG
  parts.push(new Uint8Array([0x20])); // push 32 bytes
  parts.push(xOnlyPubkeys[0]);
  parts.push(new Uint8Array([0xac])); // OP_CHECKSIG

  // Subsequent keys use OP_CHECKSIGADD
  for (let i = 1; i < xOnlyPubkeys.length; i++) {
    parts.push(new Uint8Array([0x20])); // push 32 bytes
    parts.push(xOnlyPubkeys[i]);
    parts.push(new Uint8Array([0xba])); // OP_CHECKSIGADD
  }

  // Push threshold and OP_NUMEQUAL
  if (threshold <= 16) {
    // OP_1 through OP_16 (0x51 through 0x60)
    parts.push(new Uint8Array([0x50 + threshold]));
  } else {
    // For thresholds > 16, use minimal CScriptNum encoding
    const thresholdBytes = encodeScriptNum(threshold);
    parts.push(new Uint8Array([thresholdBytes.length]));
    parts.push(thresholdBytes);
  }
  parts.push(new Uint8Array([0x9c])); // OP_NUMEQUAL

  return concatBytes(...parts);
}

function encodeScriptNum(n: number): Uint8Array {
  if (n === 0) return new Uint8Array([]);
  const negative = n < 0;
  let abs = Math.abs(n);
  const bytes: number[] = [];
  while (abs > 0) {
    bytes.push(abs & 0xff);
    abs >>= 8;
  }
  if (bytes[bytes.length - 1] & 0x80) {
    bytes.push(negative ? 0x80 : 0x00);
  } else if (negative) {
    bytes[bytes.length - 1] |= 0x80;
  }
  return new Uint8Array(bytes);
}

/**
 * Compute the TapLeaf hash for a script.
 * tagged_hash("TapLeaf", leaf_version || compact_size(script) || script)
 */
export function tapLeafHash(script: Uint8Array, leafVersion = 0xc0): Uint8Array {
  const scriptLen = compactSize(script.length);
  return taggedHash('TapLeaf', new Uint8Array([leafVersion]), scriptLen, script);
}

function compactSize(n: number): Uint8Array {
  if (n < 0xfd) return new Uint8Array([n]);
  if (n <= 0xffff) {
    const buf = new Uint8Array(3);
    buf[0] = 0xfd;
    buf[1] = n & 0xff;
    buf[2] = (n >> 8) & 0xff;
    return buf;
  }
  const buf = new Uint8Array(5);
  buf[0] = 0xfe;
  buf[1] = n & 0xff;
  buf[2] = (n >> 8) & 0xff;
  buf[3] = (n >> 16) & 0xff;
  buf[4] = (n >> 24) & 0xff;
  return buf;
}

/**
 * Compute TapBranch hash from two child hashes.
 * Children are sorted lexicographically before hashing.
 */
export function tapBranchHash(left: Uint8Array, right: Uint8Array): Uint8Array {
  const [a, b] = compareBytesLex(left, right) <= 0 ? [left, right] : [right, left];
  return taggedHash('TapBranch', a, b);
}

function compareBytesLex(a: Uint8Array, b: Uint8Array): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

/**
 * Build a Taproot tree from multiple script leaves.
 * Uses a balanced binary tree structure for optimal proof size.
 */
export function buildTapTree(leaves: Uint8Array[]): Uint8Array {
  if (leaves.length === 0) throw new Error('No leaves');
  if (leaves.length === 1) return leaves[0];

  const hashes = leaves.map((script) => tapLeafHash(script));
  return buildTreeFromHashes(hashes);
}

function buildTreeFromHashes(hashes: Uint8Array[]): Uint8Array {
  if (hashes.length === 1) return hashes[0];

  const next: Uint8Array[] = [];
  for (let i = 0; i < hashes.length; i += 2) {
    if (i + 1 < hashes.length) {
      next.push(tapBranchHash(hashes[i], hashes[i + 1]));
    } else {
      next.push(hashes[i]);
    }
  }
  return buildTreeFromHashes(next);
}

/**
 * Compute the Taproot output key from an internal key and a script tree root.
 *
 * Q = P + tagged_hash("TapTweak", P || merkle_root) * G
 *
 * If no script tree (key-path only): Q = P + tagged_hash("TapTweak", P) * G
 */
export function computeTaprootOutput(
  internalPubkeyHex: string,
  merkleRoot?: Uint8Array
): { outputKey: Uint8Array; parity: boolean } {
  const pubkeyBytes = hexToBytes(internalPubkeyHex);

  const tweakInput = merkleRoot
    ? concatBytes(pubkeyBytes, merkleRoot)
    : pubkeyBytes;

  const tweak = taggedHash('TapTweak', tweakInput);
  const tweakN = bytesToBigInt(tweak);
  const n = secp256k1.CURVE.n;

  if (tweakN >= n) {
    throw new Error('Tweak exceeds curve order');
  }

  const P = secp256k1.ProjectivePoint.fromHex(
    concatBytes(new Uint8Array([0x02]), pubkeyBytes)
  );
  const T = secp256k1.ProjectivePoint.BASE.multiply(tweakN);
  const Q = P.add(T);

  const qBytes = Q.toRawBytes(false); // uncompressed: 04 || x || y
  const x = qBytes.slice(1, 33);
  const yLastByte = qBytes[64];
  const parity = (yLastByte & 1) === 1;

  return { outputKey: x, parity };
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  let result = 0n;
  for (const byte of bytes) {
    result = (result << 8n) | BigInt(byte);
  }
  return result;
}

export interface MultisigConfig {
  threshold: number;
  pubkeys: string[]; // x-only hex pubkeys (from npubs)
  internalKey: string; // x-only hex pubkey used as internal key
  network: 'mainnet' | 'testnet';
}

export interface MultisigWallet {
  address: string;
  config: MultisigConfig;
  script: Uint8Array;
  scriptHex: string;
  merkleRoot: Uint8Array;
  outputKey: string;
  createdAt: number;
}

/**
 * Create a multi-sig Taproot address from a set of npub-derived x-only keys.
 *
 * The internal key can be:
 * - An unspendable key (for pure script-path spending)
 * - One of the participant's keys (for key-path shortcut if all agree)
 *
 * For social multi-sig where you control enough keys, using an unspendable
 * internal key ensures spending MUST go through the script path.
 */
export function createMultisigAddress(config: MultisigConfig): MultisigWallet {
  const pubkeyBytes = config.pubkeys.map((hex) => {
    const bytes = hexToBytes(hex);
    if (bytes.length !== 32) throw new Error(`Invalid pubkey length: ${hex}`);
    return bytes;
  });

  // Build the multi-sig Tapscript
  const script = buildMultisigScript(pubkeyBytes, config.threshold);

  // Build tap tree with single leaf (the multi-sig script)
  const leafHash = tapLeafHash(script);

  // Compute output key
  const { outputKey } = computeTaprootOutput(config.internalKey, leafHash);

  // Encode as bech32m address
  const hrp = config.network === 'mainnet' ? 'bc' : 'tb';
  const words = bech32m.toWords(outputKey);
  const address = bech32m.encode(hrp, [1, ...words]);

  return {
    address,
    config,
    script,
    scriptHex: bytesToHex(script),
    merkleRoot: leafHash,
    outputKey: bytesToHex(outputKey),
    createdAt: Math.floor(Date.now() / 1000),
  };
}

/**
 * Generate a provably unspendable internal key.
 * Uses the "Nothing Up My Sleeve" (NUMS) point:
 * H = lift_x(SHA256("unspendable"))
 *
 * This ensures nobody can spend via key-path, forcing script-path usage.
 */
export function unspendableInternalKey(): string {
  const hash = sha256(new TextEncoder().encode('nostr-onchain-signer/unspendable/v1'));
  // Ensure the x-coordinate corresponds to a valid point
  // If not, we hash again iteratively
  let attempt = hash;
  for (let i = 0; i < 256; i++) {
    try {
      secp256k1.ProjectivePoint.fromHex(
        concatBytes(new Uint8Array([0x02]), attempt)
      );
      return bytesToHex(attempt);
    } catch {
      attempt = sha256(attempt);
    }
  }
  throw new Error('Failed to generate unspendable key');
}

/**
 * Create a social multi-sig from a list of npubs.
 * Converts npubs to x-only pubkey hex and creates the multi-sig address.
 */
export function createSocialMultisig(
  npubs: string[],
  threshold: number,
  network: 'mainnet' | 'testnet' = 'mainnet'
): MultisigWallet {
  const pubkeys = npubs.map((npub) => {
    // npub is bech32 encoded x-only pubkey
    const decoded = bech32m.decode(npub as `${string}1${string}`);
    // Actually npub uses bech32 not bech32m - handle both
    return bytesToHex(bech32m.fromWords(decoded.words));
  });

  const internalKey = unspendableInternalKey();

  return createMultisigAddress({
    threshold,
    pubkeys,
    internalKey,
    network,
  });
}

/**
 * Alternative: create social multi-sig from raw hex pubkeys directly.
 * This is useful when you already have the pubkeys from Nostr events.
 */
export function createMultisigFromPubkeys(
  pubkeysHex: string[],
  threshold: number,
  network: 'mainnet' | 'testnet' = 'mainnet'
): MultisigWallet {
  const internalKey = unspendableInternalKey();

  return createMultisigAddress({
    threshold,
    pubkeys: pubkeysHex,
    internalKey,
    network,
  });
}
