/**
 * Taproot signing with SIGHASH_UNIFIED (XBT chain).
 *
 * @scure/btc-signer only knows the BIP341 message, so inputs whose PSBT
 * sighash type carries the 0x20 opt-in bit are signed here: the unified
 * message is computed by @nostr-onchain/core, signed with BIP340 Schnorr,
 * and the 65-byte signature (sig || hash_type) is written back into the
 * PSBT exactly where scure would put its own. Finalize/extract then work
 * unchanged.
 */

import { schnorr, secp256k1 } from '@noble/curves/secp256k1';
import { Transaction, Script } from '@scure/btc-signer';
import { hex } from '@scure/base';
import { concatBytes } from '@noble/hashes/utils';
import {
  isUnifiedSighash,
  psbtHasUnifiedInputs,
  taggedHash,
  tapLeafHash,
  unifiedKeyPathSighash,
  unifiedTapscriptSighash,
} from './unified-sighash';

const N = secp256k1.CURVE.n;
const bytesToBig = (b: Uint8Array) => BigInt('0x' + hex.encode(b));
const bigToBytes = (n: bigint) => hex.decode(n.toString(16).padStart(64, '0'));

/**
 * BIP341 key-path private key: the BIP340-even form of `priv`, plus
 * TapTweak(P || merkleRoot). Returns the tweaked key and the output key's x.
 */
export function taprootTweakPrivKey(priv: Uint8Array, merkleRoot?: Uint8Array): { priv: Uint8Array; outputKey: Uint8Array } {
  let d = bytesToBig(priv);
  if (d <= 0n || d >= N) throw new Error('invalid private key');
  const P = secp256k1.ProjectivePoint.fromPrivateKey(d).toAffine();
  if (P.y % 2n === 1n) d = N - d;
  const xonly = bigToBytes(P.x);
  const tweak = taggedHash('TapTweak', merkleRoot ? concatBytes(xonly, merkleRoot) : xonly);
  const t = bytesToBig(tweak);
  if (t >= N) throw new Error('tweak exceeds curve order');
  const dq = (d + t) % N;
  const Q = secp256k1.ProjectivePoint.fromPrivateKey(dq).toAffine();
  return { priv: bigToBytes(dq), outputKey: bigToBytes(Q.x) };
}

/** Witness program of a P2TR scriptPubKey (OP_1 PUSH32 <Q>), or null. */
function taprootOutputKey(script: Uint8Array | undefined): Uint8Array | null {
  if (!script || script.length !== 34 || script[0] !== 0x51 || script[1] !== 0x20) return null;
  return script.slice(2);
}

/**
 * Sign every opted-in (unified) KEY-PATH input that `priv` controls.
 * Returns how many inputs were signed. Inputs without the opt-in bit are
 * left for `tx.sign()`.
 */
export function signUnifiedKeyPathInputs(tx: Transaction, priv: Uint8Array): number {
  const xonly = schnorr.getPublicKey(priv);
  let signed = 0;
  for (let i = 0; i < tx.inputsLength; i++) {
    const input = tx.getInput(i);
    const hashType = input.sighashType;
    if (!isUnifiedSighash(hashType)) continue;
    if (input.tapLeafScript && input.tapLeafScript.length > 0 && !input.tapInternalKey) continue;
    const outputKey = taprootOutputKey(input.witnessUtxo?.script as Uint8Array | undefined);
    if (!outputKey) continue;

    // The key must actually control this output: tweak with the PSBT's merkle
    // root (none for BIP-86 single-key) and compare to the witness program.
    const internal = input.tapInternalKey ? Uint8Array.from(input.tapInternalKey) : xonly;
    if (hex.encode(internal) !== hex.encode(xonly)) continue;
    const merkleRoot = input.tapMerkleRoot ? Uint8Array.from(input.tapMerkleRoot) : undefined;
    const tweaked = taprootTweakPrivKey(priv, merkleRoot);
    if (hex.encode(tweaked.outputKey) !== hex.encode(outputKey)) continue;

    const msg = unifiedKeyPathSighash(tx, i, hashType!);
    const sig = schnorr.sign(msg, tweaked.priv);
    if (!schnorr.verify(sig, msg, outputKey)) throw new Error(`unified key-path signature for input ${i} does not verify`);
    tx.updateInput(i, { tapKeySig: concatBytes(sig, new Uint8Array([hashType!])) }, true);
    signed++;
  }
  return signed;
}

/**
 * Add this key's Schnorr signature to every opted-in (unified) TAPSCRIPT
 * input whose leaf script contains its x-only pubkey. Returns the count.
 */
export function signUnifiedTapscriptInputs(tx: Transaction, priv: Uint8Array): number {
  const xonly = schnorr.getPublicKey(priv);
  const xonlyHex = hex.encode(xonly);
  let signed = 0;
  for (let i = 0; i < tx.inputsLength; i++) {
    const input = tx.getInput(i);
    const hashType = input.sighashType;
    if (!isUnifiedSighash(hashType) || !input.tapLeafScript) continue;
    for (const [, scriptWithVer] of input.tapLeafScript) {
      const script = scriptWithVer.subarray(0, -1);
      const ver = scriptWithVer[scriptWithVer.length - 1];
      const hasKey = Script.decode(script).some(
        (op) => op instanceof Uint8Array && op.length === 32 && hex.encode(op) === xonlyHex,
      );
      if (!hasKey) continue;
      const msg = unifiedTapscriptSighash(tx, i, script, ver, hashType!);
      const sig = concatBytes(schnorr.sign(msg, priv), new Uint8Array([hashType!]));
      tx.updateInput(i, { tapScriptSig: [[{ pubKey: xonly, leafHash: tapLeafHash(script, ver) }, sig]] }, true);
      signed++;
    }
  }
  return signed;
}

/**
 * Sign a PSBT with one private key, handling both ordinary (BIP341, via
 * scure) and opted-in (unified) inputs. Returns the number of inputs signed.
 */
export function signPsbtAnySighash(tx: Transaction, priv: Uint8Array): number {
  let signed = 0;
  if (psbtHasUnifiedInputs(tx)) {
    signed += signUnifiedKeyPathInputs(tx, priv);
    signed += signUnifiedTapscriptInputs(tx, priv);
  }
  // Legacy-sighash inputs (if any) go through scure. It throws when nothing
  // matched, which is fine as long as the unified pass signed something.
  try {
    tx.sign(priv);
    signed++;
  } catch (err) {
    if (signed === 0) throw err;
  }
  return signed;
}
