/**
 * Taproot address derivation (same as existing app, standalone for the extension).
 */

import { secp256k1 } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { bech32m } from '@scure/base';
import { concatBytes, hexToBytes, bytesToHex } from '@noble/hashes/utils';

function taggedHash(tag: string, ...msgs: Uint8Array[]): Uint8Array {
  const tagDigest = sha256(new TextEncoder().encode(tag));
  return sha256(concatBytes(tagDigest, tagDigest, ...msgs));
}

export function pubkeyToTaprootAddress(
  xOnlyPubkeyHex: string,
  network: 'mainnet' | 'testnet' = 'mainnet'
): string {
  const pubkeyBytes = hexToBytes(xOnlyPubkeyHex);
  if (pubkeyBytes.length !== 32) {
    throw new Error('Invalid x-only public key: must be 32 bytes');
  }

  const tweak = taggedHash('TapTweak', pubkeyBytes);
  const tweakN = bytesToBigInt(tweak);
  const n = secp256k1.CURVE.n;

  if (tweakN >= n) throw new Error('Tweak value exceeds curve order');

  const P = secp256k1.ProjectivePoint.fromHex(
    concatBytes(new Uint8Array([0x02]), pubkeyBytes)
  );
  const T = secp256k1.ProjectivePoint.BASE.multiply(tweakN);
  const Q = P.add(T);

  const qCompressed = Q.toRawBytes(true);
  const xQ = qCompressed.slice(1);

  const hrp = network === 'mainnet' ? 'bc' : 'tb';
  const words = bech32m.toWords(xQ);
  return bech32m.encode(hrp, [1, ...words]);
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  let result = 0n;
  for (const byte of bytes) {
    result = (result << 8n) | BigInt(byte);
  }
  return result;
}
