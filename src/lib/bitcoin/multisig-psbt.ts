/**
 * PSBT build + partial sign for NDTM Tapscript multisig wallets.
 */

import { Transaction, p2tr, p2tr_ms } from '@scure/btc-signer';
import { hex } from '@scure/base';
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
