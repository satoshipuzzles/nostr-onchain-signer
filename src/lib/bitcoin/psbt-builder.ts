/**
 * Real PSBT generation for Sparrow Wallet import.
 *
 * Creates BIP174 PSBTs from Taproot (P2TR) addresses that can be:
 * - Downloaded as .psbt files
 * - Imported into Sparrow, Electrum, or any PSBT-compatible wallet
 * - Signed offline and broadcast
 */

import { Transaction } from '@scure/btc-signer';
import { hex, bech32, bech32m } from '@scure/base';
import { fetchUTXOs, fetchFeeEstimates, type UTXO as MempoolUTXO } from './mempool';

export interface PsbtBuildParams {
  fromAddress: string;
  toAddress: string;
  amountSats: number;
  feeRate?: number;
  changeAddress?: string;
  internalPubkeyHex?: string;
  opReturnData?: Uint8Array;
}

export interface PsbtResult {
  psbtBase64: string;
  psbtHex: string;
  fee: number;
  vsize: number;
  inputCount: number;
  outputCount: number;
  totalInputSats: number;
  changeSats: number;
}

function addressToScriptPubKey(address: string): Uint8Array {
  if (address.startsWith('bc1p') || address.startsWith('tb1p')) {
    // Taproot (bech32m, witness version 1, 32-byte program)
    const decoded = bech32m.decode(address as `${string}1${string}`);
    const program = bech32m.fromWords(decoded.words.slice(1));
    // OP_1 (0x51) + PUSH32 (0x20) + <program>
    const script = new Uint8Array(2 + program.length);
    script[0] = 0x51;
    script[1] = 0x20;
    script.set(program, 2);
    return script;
  }

  if (address.startsWith('bc1q') || address.startsWith('tb1q')) {
    // Native SegWit v0 (bech32, 20 or 32 byte program)
    const decoded = bech32.decode(address as `${string}1${string}`);
    const program = bech32.fromWords(decoded.words.slice(1));
    // OP_0 (0x00) + PUSH (0x14 for 20 bytes) + <program>
    const script = new Uint8Array(2 + program.length);
    script[0] = 0x00;
    script[1] = program.length;
    script.set(program, 2);
    return script;
  }

  throw new Error(`Unsupported address format: ${address.slice(0, 6)}...`);
}

/**
 * Build an unsigned PSBT from a Taproot address.
 * Fetches UTXOs from mempool.space and does coin selection.
 */
export async function buildPsbt(params: PsbtBuildParams): Promise<PsbtResult> {
  const { fromAddress, toAddress, amountSats, feeRate, changeAddress, internalPubkeyHex, opReturnData } = params;

  const utxos = await fetchUTXOs(fromAddress);
  if (utxos.length === 0) {
    throw new Error('No UTXOs available. Fund this address first.');
  }

  let actualFeeRate = feeRate;
  if (!actualFeeRate) {
    const estimates = await fetchFeeEstimates();
    actualFeeRate = estimates.halfHour;
  }

  const sorted = [...utxos].sort((a, b) => b.value - a.value);
  const hasOpReturn = !!opReturnData && opReturnData.length <= 80;

  // Coin selection (largest first)
  const selected: MempoolUTXO[] = [];
  let totalInput = 0;
  let fee = 0;

  for (const utxo of sorted) {
    selected.push(utxo);
    totalInput += utxo.value;

    const numOutputs = 1 + (hasOpReturn ? 1 : 0) + 1; // recipient + op_return? + change
    const vsize = estimateVsize(selected.length, numOutputs, hasOpReturn);
    fee = Math.ceil(vsize * actualFeeRate);

    if (totalInput >= amountSats + fee + 546) break;
  }

  const numOutputs = 1 + (hasOpReturn ? 1 : 0) + (totalInput - amountSats - fee >= 546 ? 1 : 0);
  const vsize = estimateVsize(selected.length, numOutputs, hasOpReturn);
  fee = Math.ceil(vsize * actualFeeRate);

  if (totalInput < amountSats + fee) {
    throw new Error(`Insufficient funds. Have ${totalInput} sats, need ${amountSats + fee} (amount + fee)`);
  }

  const changeSats = totalInput - amountSats - fee;

  // Build PSBT
  const fromScript = addressToScriptPubKey(fromAddress);
  const tx = new Transaction({ allowUnknownOutputs: true, allowUnknownInputs: true });

  for (const utxo of selected) {
    const inputData: Record<string, unknown> = {
      txid: utxo.txid,
      index: utxo.vout,
      witnessUtxo: {
        script: fromScript,
        amount: BigInt(utxo.value),
      },
    };
    if (internalPubkeyHex) {
      inputData.tapInternalKey = hex.decode(internalPubkeyHex);
    }
    tx.addInput(inputData as any);
  }

  // Recipient
  tx.addOutputAddress(toAddress, BigInt(amountSats));

  // Change
  if (changeSats >= 546) {
    tx.addOutputAddress(changeAddress || fromAddress, BigInt(changeSats));
  }

  // OP_RETURN
  if (hasOpReturn && opReturnData) {
    const opReturnScript = new Uint8Array(2 + opReturnData.length);
    opReturnScript[0] = 0x6a;
    opReturnScript[1] = opReturnData.length;
    opReturnScript.set(opReturnData, 2);
    tx.addOutput({ script: opReturnScript, amount: BigInt(0) });
  }

  const psbtBytes = tx.toPSBT();
  const psbtBase64 = uint8ToBase64(psbtBytes);
  const psbtHex = hex.encode(psbtBytes);

  return {
    psbtBase64,
    psbtHex,
    fee,
    vsize,
    inputCount: selected.length,
    outputCount: numOutputs,
    totalInputSats: totalInput,
    changeSats: changeSats >= 546 ? changeSats : 0,
  };
}

function estimateVsize(numInputs: number, numOutputs: number, hasOpReturn: boolean): number {
  return 11 + numInputs * 58 + numOutputs * 43 + (hasOpReturn ? 50 : 0);
}

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Sign a Taproot PSBT with the vault private key, finalize, and return raw tx.
 */
export function signAndFinalizePsbt(
  psbtHex: string,
  privateKeyHex: string
): { txHex: string; txid: string } {
  const tx = Transaction.fromPSBT(hex.decode(psbtHex), { allowUnknownOutputs: true, allowUnknownInputs: true });
  const privKey = hex.decode(privateKeyHex);
  tx.sign(privKey);
  tx.finalize();
  const txBytes = tx.extract();
  return {
    txHex: hex.encode(txBytes),
    txid: tx.id,
  };
}

/**
 * Download PSBT as a binary .psbt file (Sparrow compatible).
 */
export function downloadPsbtFile(psbtBase64: string, filename?: string) {
  const binary = atob(psbtBase64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  const blob = new Blob([bytes], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename || `nostr-onchain-${Date.now()}.psbt`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Download PSBT as base64 text (for clipboard / QR sharing).
 */
export function downloadPsbtText(psbtBase64: string, filename?: string) {
  const blob = new Blob([psbtBase64], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename || `nostr-onchain-${Date.now()}.psbt.txt`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
