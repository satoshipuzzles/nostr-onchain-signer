/**
 * BIP-352 Silent Payments — SEND support + address encode/decode.
 *
 * A silent payment address (sp1…) encodes two public keys (scan + spend).
 * The sender derives a fresh, unlinkable taproot output for each payment via
 * ECDH between the sum of their input private keys and the receiver's scan
 * key, so nothing on-chain connects payments to the same recipient.
 *
 * Receiving (block scanning) is intentionally out of scope here — it needs a
 * node or indexer and lives in the app layer.
 */

import { secp256k1, schnorr } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { concatBytes, hexToBytes, bytesToHex } from '@noble/hashes/utils';
import { bech32m } from '@scure/base';

const Point = secp256k1.ProjectivePoint;
const CURVE_N = secp256k1.CURVE.n;

function taggedHash(tag: string, ...msgs: Uint8Array[]): Uint8Array {
  const t = sha256(new TextEncoder().encode(tag));
  return sha256(concatBytes(t, t, ...msgs));
}

function bytesToBig(b: Uint8Array): bigint {
  let r = 0n;
  for (const x of b) r = (r << 8n) | BigInt(x);
  return r;
}

function bigToBytes32(v: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let x = v;
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

export interface SilentPaymentAddress {
  version: number;
  scanKey: Uint8Array; // 33-byte compressed
  spendKey: Uint8Array; // 33-byte compressed
  network: 'mainnet' | 'testnet';
}

const SP_BECH32_LIMIT = 1023;

export function decodeSilentPaymentAddress(address: string): SilentPaymentAddress {
  const lower = address.toLowerCase();
  const decoded = bech32m.decode(lower as `${string}1${string}`, SP_BECH32_LIMIT);
  if (decoded.prefix !== 'sp' && decoded.prefix !== 'tsp') {
    throw new Error('Not a silent payment address (expected sp1…/tsp1…)');
  }
  const version = decoded.words[0];
  if (version !== 0) throw new Error(`Unsupported silent payment version: ${version}`);
  const data = new Uint8Array(bech32m.fromWords(decoded.words.slice(1)));
  if (data.length !== 66) throw new Error('Invalid silent payment payload (expected 66 bytes)');
  const scanKey = data.slice(0, 33);
  const spendKey = data.slice(33, 66);
  // validate both points
  Point.fromHex(scanKey);
  Point.fromHex(spendKey);
  return {
    version,
    scanKey,
    spendKey,
    network: decoded.prefix === 'sp' ? 'mainnet' : 'testnet',
  };
}

export function encodeSilentPaymentAddress(
  scanKey: Uint8Array,
  spendKey: Uint8Array,
  network: 'mainnet' | 'testnet' = 'mainnet'
): string {
  if (scanKey.length !== 33 || spendKey.length !== 33) {
    throw new Error('scan/spend keys must be 33-byte compressed pubkeys');
  }
  const words = [0, ...bech32m.toWords(concatBytes(scanKey, spendKey))];
  return bech32m.encode(network === 'mainnet' ? 'sp' : 'tsp', words, SP_BECH32_LIMIT);
}

export function isSilentPaymentAddress(input: string): boolean {
  return /^(sp|tsp)1[a-z0-9]{20,}$/i.test(input.trim());
}

/** Tweak a taproot key-path private key: d' = (d_even + H_TapTweak(P)) mod n. */
export function taprootTweakPrivateKey(privateKeyHex: string): string {
  const d = bytesToBig(hexToBytes(privateKeyHex));
  if (d === 0n || d >= CURVE_N) throw new Error('Invalid private key');
  const P = Point.BASE.multiply(d);
  const dEven = P.hasEvenY() ? d : CURVE_N - d;
  const xOnly = bigToBytes32(P.toAffine().x);
  const t = bytesToBig(taggedHash('TapTweak', xOnly)) % CURVE_N;
  return bytesToHex(bigToBytes32((dEven + t) % CURVE_N));
}

export interface SpInput {
  /** Private key that will SIGN this input. For taproot key-path spends,
   *  this is the TWEAKED output key (see taprootTweakPrivateKey). */
  privateKeyHex: string;
  /** True for P2TR inputs (x-only pubkey semantics: negate if odd Y). */
  isTaproot: boolean;
  txid: string;
  vout: number;
}

function serializeOutpoint(txid: string, vout: number): Uint8Array {
  // txid in internal byte order (reversed display hex) || vout LE
  const txidBytes = hexToBytes(txid).reverse();
  const voutBytes = new Uint8Array(4);
  new DataView(voutBytes.buffer).setUint32(0, vout, true);
  return concatBytes(txidBytes, voutBytes);
}

function lexicographicallySmallest(outpoints: Uint8Array[]): Uint8Array {
  return outpoints.reduce((min, cur) => {
    for (let i = 0; i < 36; i++) {
      if (cur[i] < min[i]) return cur;
      if (cur[i] > min[i]) return min;
    }
    return min;
  });
}

export interface SpDerivedOutput {
  /** x-only output pubkey (hex) — put into a P2TR output. */
  xOnlyPubkeyHex: string;
  /** Index k within this silent payment address. */
  k: number;
}

/**
 * Derive the taproot output key(s) for a payment to a silent payment address
 * (BIP-352 sender side). All inputs the transaction spends MUST be included.
 */
export function deriveSilentPaymentOutputs(
  spAddress: string | SilentPaymentAddress,
  inputs: SpInput[],
  outputCount = 1
): SpDerivedOutput[] {
  if (inputs.length === 0) throw new Error('At least one input is required');
  const addr = typeof spAddress === 'string' ? decodeSilentPaymentAddress(spAddress) : spAddress;

  // a = Σ a_i (each normalized so a_i·G is the even-Y/lifted input pubkey)
  let aSum = 0n;
  for (const input of inputs) {
    let a = bytesToBig(hexToBytes(input.privateKeyHex));
    if (a === 0n || a >= CURVE_N) throw new Error('Invalid input private key');
    if (input.isTaproot) {
      const P = Point.BASE.multiply(a);
      if (!P.hasEvenY()) a = CURVE_N - a;
    }
    aSum = (aSum + a) % CURVE_N;
  }
  if (aSum === 0n) throw new Error('Input private keys sum to zero');

  const ASum = Point.BASE.multiply(aSum);
  const smallestOutpoint = lexicographicallySmallest(
    inputs.map((i) => serializeOutpoint(i.txid, i.vout))
  );
  const inputHash = bytesToBig(
    taggedHash('BIP0352/Inputs', smallestOutpoint, ASum.toRawBytes(true))
  ) % CURVE_N;

  const scanPoint = Point.fromHex(addr.scanKey);
  const spendPoint = Point.fromHex(addr.spendKey);
  const ecdh = scanPoint.multiply((inputHash * aSum) % CURVE_N).toRawBytes(true);

  const outputs: SpDerivedOutput[] = [];
  for (let k = 0; k < outputCount; k++) {
    const kBytes = new Uint8Array(4);
    new DataView(kBytes.buffer).setUint32(0, k, false); // ser32 big-endian
    const tk = bytesToBig(taggedHash('BIP0352/SharedSecret', ecdh, kBytes)) % CURVE_N;
    if (tk === 0n) throw new Error('Degenerate shared secret');
    const outPoint = spendPoint.add(Point.BASE.multiply(tk));
    outputs.push({
      xOnlyPubkeyHex: bytesToHex(bigToBytes32(outPoint.toAffine().x)),
      k,
    });
  }
  return outputs;
}

/**
 * EXPERIMENTAL: derive deterministic silent-payment receiving keys from a
 * nostr private key, so the sp1 address survives nsec-only backups. Scanning
 * for received payments requires a node/indexer (not included here).
 */
export function deriveSpKeysFromNostrKey(nostrPrivateKeyHex: string): {
  scanPrivHex: string;
  spendPrivHex: string;
  scanPub: Uint8Array;
  spendPub: Uint8Array;
  address: string;
} {
  const d = hexToBytes(nostrPrivateKeyHex);
  if (d.length !== 32) throw new Error('Expected 32-byte private key');
  const scanPriv = bytesToBig(taggedHash('NostrOnchain/SP/scan', d)) % CURVE_N;
  const spendPriv = bytesToBig(taggedHash('NostrOnchain/SP/spend', d)) % CURVE_N;
  if (scanPriv === 0n || spendPriv === 0n) throw new Error('Degenerate derived key');
  const scanPub = Point.BASE.multiply(scanPriv).toRawBytes(true);
  const spendPub = Point.BASE.multiply(spendPriv).toRawBytes(true);
  return {
    scanPrivHex: bytesToHex(bigToBytes32(scanPriv)),
    spendPrivHex: bytesToHex(bigToBytes32(spendPriv)),
    scanPub,
    spendPub,
    address: encodeSilentPaymentAddress(scanPub, spendPub),
  };
}

/** Convert an x-only output key to a bc1p address (for SP-derived outputs). */
export function xOnlyToTaprootAddress(xOnlyHex: string, network: 'mainnet' | 'testnet' = 'mainnet'): string {
  const program = hexToBytes(xOnlyHex);
  if (program.length !== 32) throw new Error('Expected 32-byte x-only key');
  schnorr.utils.lift_x(bytesToBig(program)); // validates the key is on-curve
  return bech32m.encode(network === 'mainnet' ? 'bc' : 'tb', [1, ...bech32m.toWords(program)]);
}
