/**
 * PSBT (Partially Signed Bitcoin Transaction) construction and signing.
 *
 * Handles both single-sig Taproot key-path spends and multi-sig
 * Tapscript spends with OP_RETURN Nostr note embedding.
 */

import { sha256 } from '@noble/hashes/sha256';
import { concatBytes, hexToBytes, bytesToHex } from '@noble/hashes/utils';
import { schnorr } from '@noble/curves/secp256k1';

export interface UTXO {
  txid: string;
  vout: number;
  value: number; // satoshis
  scriptPubKey: string;
  witnessUtxo?: {
    script: Uint8Array;
    value: number;
  };
}

export interface TxOutput {
  address?: string;
  script?: Uint8Array;
  value: number;
}

export interface TransactionPlan {
  inputs: UTXO[];
  outputs: TxOutput[];
  fee: number;
  changeIndex?: number;
  opReturnIndex?: number;
}

export interface SignedInput {
  index: number;
  signature: Uint8Array;
  pubkey: Uint8Array;
}

/**
 * Estimate transaction virtual size for fee calculation.
 * Taproot key-path: ~58 vbytes per input, 43 per output
 * Taproot script-path: varies based on script + control block
 */
export function estimateVsize(
  numInputs: number,
  numOutputs: number,
  hasOpReturn: boolean,
  isScriptPath: boolean = false
): number {
  const overhead = 10.5; // version(4) + locktime(4) + segwit marker/flag(0.5) + input/output counts
  const inputWeight = isScriptPath ? 100 : 58; // script-path inputs are larger
  const outputWeight = 43; // P2TR output
  const opReturnWeight = hasOpReturn ? 50 : 0; // OP_RETURN output ~50 vbytes

  return Math.ceil(
    overhead + numInputs * inputWeight + numOutputs * outputWeight + opReturnWeight
  );
}

/**
 * Select UTXOs for a transaction using a simple largest-first strategy.
 */
export function selectUtxos(
  utxos: UTXO[],
  targetAmount: number,
  feeRate: number,
  numOutputs: number,
  hasOpReturn: boolean
): { selected: UTXO[]; fee: number; change: number } | null {
  const sorted = [...utxos].sort((a, b) => b.value - a.value);
  const selected: UTXO[] = [];
  let totalInput = 0;

  for (const utxo of sorted) {
    selected.push(utxo);
    totalInput += utxo.value;

    const vsize = estimateVsize(selected.length, numOutputs + 1, hasOpReturn);
    const fee = Math.ceil(vsize * feeRate);
    const change = totalInput - targetAmount - fee;

    if (change >= 0) {
      // If change is dust (< 546 sats for P2TR), donate to fee
      if (change < 546) {
        return { selected, fee: fee + change, change: 0 };
      }
      return { selected, fee, change };
    }
  }

  return null; // Insufficient funds
}

/**
 * Create a BIP341 signature hash for Taproot key-path spending.
 * This is a simplified version — full implementation would use
 * the complete sighash algorithm from BIP341.
 */
export function createTaprootKeyPathSighash(
  _tx: Uint8Array,
  _inputIndex: number,
  _prevouts: UTXO[]
): Uint8Array {
  // Placeholder: In production, this implements the full BIP341 sighash
  // algorithm including epoch, sighash type, and all transaction data.
  // We'll use @scure/btc-signer for the actual implementation.
  throw new Error('Use @scure/btc-signer for full sighash computation');
}

/**
 * Sign a hash with a Schnorr signature (BIP340).
 */
export function schnorrSign(
  messageHash: Uint8Array,
  privateKeyHex: string
): Uint8Array {
  const privkey = hexToBytes(privateKeyHex);
  return schnorr.sign(messageHash, privkey);
}

/**
 * Verify a Schnorr signature.
 */
export function schnorrVerify(
  signature: Uint8Array,
  messageHash: Uint8Array,
  pubkeyHex: string
): boolean {
  const pubkey = hexToBytes(pubkeyHex);
  return schnorr.verify(signature, messageHash, pubkey);
}

/**
 * Aggregate partial signatures for Tapscript multi-sig spending.
 * In Tapscript multi-sig, each signer provides their own signature
 * independently (not aggregated like MuSig2). The witness stack contains
 * all individual signatures in reverse order.
 */
export function buildMultisigWitness(
  signatures: Map<string, Uint8Array>, // pubkey hex -> signature
  allPubkeys: string[],                // all pubkeys in script order
  threshold: number,
  script: Uint8Array,
  controlBlock: Uint8Array
): Uint8Array[] {
  // Witness stack for Tapscript multi-sig (BIP342):
  // [sig_n] [sig_n-1] ... [sig_1] [script] [control_block]
  //
  // For keys that DON'T sign, push empty bytes.
  // Signatures are in the same order as keys in the script.

  const witnessStack: Uint8Array[] = [];

  // Push signatures in reverse order (last key first)
  for (let i = allPubkeys.length - 1; i >= 0; i--) {
    const sig = signatures.get(allPubkeys[i]);
    witnessStack.push(sig ?? new Uint8Array([])); // empty for non-signers
  }

  witnessStack.push(script);
  witnessStack.push(controlBlock);

  return witnessStack;
}

/**
 * Build the control block for a Tapscript spend.
 * Format: <leaf_version | parity_bit> <internal_key> <merkle_path>
 */
export function buildControlBlock(
  internalKeyHex: string,
  outputParity: boolean,
  merklePath: Uint8Array[],
  leafVersion: number = 0xc0
): Uint8Array {
  const parityBit = outputParity ? 1 : 0;
  const firstByte = new Uint8Array([leafVersion | parityBit]);
  const internalKey = hexToBytes(internalKeyHex);

  return concatBytes(firstByte, internalKey, ...merklePath);
}
