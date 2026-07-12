/**
 * PSBT build + partial sign for NDTM Tapscript multisig wallets.
 */

import { Transaction, p2tr, p2tr_ms, Script, SigHash } from '@scure/btc-signer';
import { tapLeafHash } from '@scure/btc-signer/payment';
import { hex } from '@scure/base';
import { concatBytes } from '@noble/hashes/utils';
import { fetchUTXOs, fetchFeeEstimates } from './mempool';
import type { MultisigWallet } from './multisig';
import type { PsbtResult } from './psbt-builder';

function estimateVsize(numInputs: number, numOutputs: number, hasOpReturn: boolean): number {
  // Tapscript multisig inputs are larger than key-path
  return 11 + numInputs * 120 + numOutputs * 43 + (hasOpReturn ? 50 : 0);
}

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

/** Build p2tr descriptor for a stored multisig wallet (uses stored pubkey order). */
export function multisigTaprootInfo(wallet: MultisigWallet) {
  const pubkeys = wallet.config.pubkeys.map((p) => hex.decode(p));
  const internalKey = hex.decode(wallet.config.internalKey);
  const msScript = p2tr_ms(wallet.config.threshold, pubkeys);
  const tree = { script: msScript.script, leafVersion: 0xc0 as const };
  return p2tr(internalKey, tree);
}

/**
 * Build an unsigned PSBT spending from a multisig Taproot address.
 */
export async function buildMultisigPsbt(params: {
  wallet: MultisigWallet;
  toAddress: string;
  amountSats: number;
  feeRate?: number;
  changeAddress?: string;
  opReturnData?: Uint8Array;
}): Promise<PsbtResult> {
  const { wallet, toAddress, amountSats, feeRate, changeAddress, opReturnData } = params;
  const tap = multisigTaprootInfo(wallet);

  if (tap.address !== wallet.address) {
    throw new Error('Multisig address mismatch — wallet config may be corrupted');
  }

  const utxos = await fetchUTXOs(wallet.address);
  if (utxos.length === 0) {
    throw new Error('No UTXOs available. Fund this multisig address first.');
  }

  let actualFeeRate = feeRate;
  if (!actualFeeRate) {
    const estimates = await fetchFeeEstimates();
    actualFeeRate = estimates.halfHour;
  }

  const sorted = [...utxos].sort((a, b) => b.value - a.value);
  const hasOpReturn = !!opReturnData && opReturnData.length <= 80;

  const selected: typeof utxos = [];
  let totalInput = 0;
  let fee = 0;

  for (const utxo of sorted) {
    selected.push(utxo);
    totalInput += utxo.value;
    const numOutputs = 1 + (hasOpReturn ? 1 : 0) + 1;
    const vsize = estimateVsize(selected.length, numOutputs, hasOpReturn);
    fee = Math.ceil(vsize * actualFeeRate);
    if (totalInput >= amountSats + fee + 546) break;
  }

  const numOutputs = 1 + (hasOpReturn ? 1 : 0) + (totalInput - amountSats - fee >= 546 ? 1 : 0);
  const vsize = estimateVsize(selected.length, numOutputs, hasOpReturn);
  fee = Math.ceil(vsize * actualFeeRate);

  if (totalInput < amountSats + fee) {
    throw new Error(`Insufficient funds. Have ${totalInput} sats, need ${amountSats + fee}`);
  }

  const changeSats = totalInput - amountSats - fee;
  const tx = new Transaction();

  for (const utxo of selected) {
    tx.addInput({
      txid: utxo.txid,
      index: utxo.vout,
      witnessUtxo: { script: tap.script, amount: BigInt(utxo.value) },
      tapInternalKey: tap.tapInternalKey,
      tapLeafScript: tap.tapLeafScript,
      tapMerkleRoot: tap.tapMerkleRoot,
    });
  }

  tx.addOutputAddress(toAddress, BigInt(amountSats));

  if (changeSats >= 546) {
    tx.addOutputAddress(changeAddress || wallet.address, BigInt(changeSats));
  }

  if (hasOpReturn && opReturnData) {
    const opReturnScript = new Uint8Array(2 + opReturnData.length);
    opReturnScript[0] = 0x6a;
    opReturnScript[1] = opReturnData.length;
    opReturnScript.set(opReturnData, 2);
    tx.addOutput({ script: opReturnScript, amount: 0n });
  }

  const psbtBytes = tx.toPSBT();
  return {
    psbtBase64: uint8ToBase64(psbtBytes),
    psbtHex: hex.encode(psbtBytes),
    fee,
    vsize,
    inputCount: selected.length,
    outputCount: numOutputs,
    totalInputSats: totalInput,
    changeSats: changeSats >= 546 ? changeSats : 0,
  };
}

/** Add this signer's Tapscript Schnorr sig to the PSBT (does not finalize). */
export function signMultisigPsbtPartial(psbtHex: string, privateKeyHex: string): string {
  const tx = Transaction.fromPSBT(hex.decode(psbtHex));
  tx.sign(hex.decode(privateKeyHex));
  return hex.encode(tx.toPSBT());
}

/**
 * Try every provided private key against the PSBT and add all signatures
 * that fit. Lets a vault holding multiple accounts sign regardless of which
 * account is currently active.
 */
export function signMultisigPsbtWithKeys(
  psbtHex: string,
  privateKeysHex: string[],
): { psbtHex: string; signedCount: number } {
  const tx = Transaction.fromPSBT(hex.decode(psbtHex));
  let signedCount = 0;
  let lastError: unknown = null;

  for (const keyHex of privateKeysHex) {
    try {
      tx.sign(hex.decode(keyHex));
      signedCount++;
    } catch (err) {
      // Key doesn't match any input — try the next one
      lastError = err;
    }
  }

  if (signedCount === 0) {
    const msg = lastError instanceof Error ? lastError.message : 'no matching key';
    throw new Error(
      `None of your vault keys can sign this PSBT (${msg}). ` +
      'Make sure the co-signer account (with its nsec) is imported in this vault.',
    );
  }

  return { psbtHex: hex.encode(tx.toPSBT()), signedCount };
}

/**
 * Partial-sign a Tapscript multisig PSBT using an EXTERNAL Schnorr signer
 * (NIP-07 `signSchnorr`, e.g. Alby / our extension) — the private key never
 * touches this app. Mirrors what scure's `tx.sign` does for tapLeafScript
 * inputs, but delegates the actual Schnorr signature to the signer callback.
 *
 * This makes signing a PSBT work exactly like signing a Nostr event: the
 * user's existing signer produces a signature for a 32-byte hash.
 */
export async function signMultisigPsbtViaSchnorr(
  psbtHex: string,
  signerPubkeyHex: string,
  signSchnorr: (hashHex: string) => Promise<string>,
): Promise<{ psbtHex: string; signedCount: number }> {
  const tx = Transaction.fromPSBT(hex.decode(psbtHex));
  const signerPub = hex.decode(signerPubkeyHex);
  let signedCount = 0;

  // Preimage needs every input's prevout script + amount
  const prevOutScripts: Uint8Array[] = [];
  const amounts: bigint[] = [];
  for (let i = 0; i < tx.inputsLength; i++) {
    const wu = tx.getInput(i).witnessUtxo;
    if (!wu) throw new Error('PSBT input missing witnessUtxo — cannot compute sighash');
    prevOutScripts.push(wu.script as Uint8Array);
    amounts.push(wu.amount as bigint);
  }

  for (let idx = 0; idx < tx.inputsLength; idx++) {
    const input = tx.getInput(idx);
    if (!input.tapLeafScript) continue;
    const sighash = input.sighashType ?? SigHash.DEFAULT;

    for (const [, scriptWithVer] of input.tapLeafScript) {
      const script = scriptWithVer.subarray(0, -1);
      const ver = scriptWithVer[scriptWithVer.length - 1];

      // Only sign leaves that actually contain this signer's x-only pubkey
      const decoded = Script.decode(script);
      const hasKey = decoded.some(
        (op) => op instanceof Uint8Array && op.length === 32 &&
          hex.encode(op) === signerPubkeyHex.toLowerCase(),
      );
      if (!hasKey) continue;

      const msgHash = tx.preimageWitnessV1(
        idx, prevOutScripts, sighash, amounts, undefined, script, ver,
      );
      const sigHex = await signSchnorr(hex.encode(msgHash));
      const sigBytes = hex.decode(sigHex.replace(/^0x/, '').trim());
      if (sigBytes.length !== 64) {
        throw new Error('Signer returned an invalid Schnorr signature');
      }
      // Verify against the expected pubkey — a signer logged into a different
      // account would otherwise poison the PSBT with an invalid signature
      const { schnorr } = await import('@noble/curves/secp256k1');
      if (!schnorr.verify(sigBytes, msgHash, signerPub)) {
        throw new Error(
          'Your signer is logged into a different account than this co-signer key. ' +
          'Switch accounts in your signer extension and try again.',
        );
      }
      const sig = sighash !== SigHash.DEFAULT
        ? concatBytes(sigBytes, new Uint8Array([sighash]))
        : sigBytes;

      const leafHash = tapLeafHash(script, ver);
      tx.updateInput(idx, { tapScriptSig: [[{ pubKey: signerPub, leafHash }, sig]] }, true);
      signedCount++;
    }
  }

  if (signedCount === 0) {
    throw new Error(
      'Your connected signer\'s key is not one of the co-signers on this transaction.',
    );
  }

  return { psbtHex: hex.encode(tx.toPSBT()), signedCount };
}

export function isRealPsbtHex(value: string): boolean {
  const clean = value.trim();
  if (!clean || clean.startsWith('{')) return false;
  try {
    Transaction.fromPSBT(hex.decode(clean));
    return true;
  } catch {
    return false;
  }
}
