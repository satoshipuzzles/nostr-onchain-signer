/**
 * Pure PSBT construction and signing for taproot (P2TR) and segwit v0 wallets.
 *
 * Unlike the signer app's builder, this module never fetches anything: the
 * caller supplies UTXOs and a fee rate, which keeps it testable and usable
 * offline. OP_RETURN data of ANY size is honored — size policy (BIP-110,
 * relay standardness) is a UI decision, not a builder decision.
 */

import { Transaction } from '@scure/btc-signer';
import { hex, base64, bech32, bech32m } from '@scure/base';
import { buildOpReturnScript } from './opreturn';

export interface CoreUtxo {
  txid: string;
  vout: number;
  value: number;
}

export interface TxOutputSpec {
  /** Address, or empty for OP_RETURN outputs. */
  address?: string;
  amountSats: number;
  /** Raw OP_RETURN payload (script built with minimal push). */
  opReturnData?: Uint8Array;
}

export interface BuildTxParams {
  utxos: CoreUtxo[];
  /** scriptPubKey of the spending address (all inputs must share it for now). */
  fromAddress: string;
  outputs: TxOutputSpec[];
  feeRate: number;
  changeAddress: string;
  /** x-only internal key for taproot key-path inputs (enables signing). */
  internalPubkeyHex?: string;
  /** Enable RBF signaling (sequence 0xfffffffd). Default true. */
  rbf?: boolean;
  locktime?: number;
  version?: number;
}

export interface BuiltTx {
  psbtBase64: string;
  psbtHex: string;
  psbtBytes: Uint8Array;
  fee: number;
  vsize: number;
  inputCount: number;
  outputCount: number;
  totalInputSats: number;
  changeSats: number;
}

export function addressToScriptPubKey(address: string): Uint8Array {
  if (/^(bc1p|tb1p)/i.test(address)) {
    const decoded = bech32m.decode(address.toLowerCase() as `${string}1${string}`);
    const program = bech32m.fromWords(decoded.words.slice(1));
    if (program.length !== 32) throw new Error('Invalid taproot witness program');
    const script = new Uint8Array(2 + program.length);
    script[0] = 0x51; // OP_1
    script[1] = 0x20;
    script.set(new Uint8Array(program), 2);
    return script;
  }
  if (/^(bc1q|tb1q)/i.test(address)) {
    const decoded = bech32.decode(address.toLowerCase() as `${string}1${string}`);
    const program = bech32.fromWords(decoded.words.slice(1));
    const script = new Uint8Array(2 + program.length);
    script[0] = 0x00; // OP_0
    script[1] = program.length;
    script.set(new Uint8Array(program), 2);
    return script;
  }
  throw new Error(`Unsupported address format: ${address.slice(0, 8)}…`);
}

/**
 * @param numOutputs count of NON-OP_RETURN outputs (recipients + change)
 * @param opReturnScriptLens full OP_RETURN scriptPubKey lengths
 */
export function estimateVsize(numInputs: number, numOutputs: number, opReturnScriptLens: number[] = []): number {
  const opReturnSize = opReturnScriptLens.reduce((sum, len) => sum + (len > 0 ? 9 + len : 0), 0);
  return 11 + numInputs * 58 + numOutputs * 43 + opReturnSize;
}

/**
 * Build an unsigned PSBT from explicit UTXOs and outputs, with automatic
 * coin selection (largest-first) when `useAllUtxos` is not requested.
 */
export function buildTx(params: BuildTxParams, opts?: { useAllUtxos?: boolean }): BuiltTx {
  const { utxos, fromAddress, outputs, feeRate, changeAddress, internalPubkeyHex, rbf = true, locktime, version } = params;
  if (utxos.length === 0) throw new Error('No UTXOs available');
  if (outputs.length === 0) throw new Error('At least one output is required');
  if (!feeRate || feeRate <= 0) throw new Error('Fee rate must be positive');

  const sendTotal = outputs.reduce((sum, o) => sum + (o.opReturnData ? 0 : o.amountSats), 0);
  const opReturnScripts = outputs
    .filter((o) => o.opReturnData && o.opReturnData.length > 0)
    .map((o) => buildOpReturnScript(o.opReturnData!));
  const addressOutputs = outputs.filter((o) => !o.opReturnData);
  for (const o of addressOutputs) {
    if (!o.address) throw new Error('Output missing address');
    if (o.amountSats < 546) throw new Error(`Output below dust limit: ${o.amountSats} sats`);
  }

  // Coin selection
  const sorted = [...utxos].sort((a, b) => b.value - a.value);
  const selected: CoreUtxo[] = [];
  let totalInput = 0;
  let fee = 0;
  const opReturnLens = opReturnScripts.map((s) => s.length);

  if (opts?.useAllUtxos) {
    selected.push(...sorted);
    totalInput = sorted.reduce((sum, u) => sum + u.value, 0);
  } else {
    for (const utxo of sorted) {
      selected.push(utxo);
      totalInput += utxo.value;
      fee = Math.ceil(estimateVsize(selected.length, addressOutputs.length + 1, opReturnLens) * feeRate);
      if (totalInput >= sendTotal + fee + 546) break;
    }
  }

  const vsizeWithChange = estimateVsize(selected.length, addressOutputs.length + 1, opReturnLens);
  fee = Math.ceil(vsizeWithChange * feeRate);
  let hasChange = totalInput - sendTotal - fee >= 546;
  if (!hasChange) {
    const vsizeNoChange = estimateVsize(selected.length, addressOutputs.length, opReturnLens);
    fee = Math.ceil(vsizeNoChange * feeRate);
  }
  if (totalInput < sendTotal + fee) {
    throw new Error(`Insufficient funds: have ${totalInput} sats, need ${sendTotal + fee} (amount + fee)`);
  }
  const changeSats = hasChange ? totalInput - sendTotal - fee : 0;

  // Assemble
  const fromScript = addressToScriptPubKey(fromAddress);
  const tx = new Transaction({
    allowUnknownOutputs: true,
    allowUnknownInputs: true,
    version: version ?? 2,
    lockTime: locktime ?? 0,
  });

  for (const utxo of selected) {
    const input: Record<string, unknown> = {
      txid: utxo.txid,
      index: utxo.vout,
      witnessUtxo: { script: fromScript, amount: BigInt(utxo.value) },
      sequence: rbf ? 0xfffffffd : 0xffffffff,
    };
    if (internalPubkeyHex) input.tapInternalKey = hex.decode(internalPubkeyHex);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tx.addInput(input as any);
  }

  for (const o of addressOutputs) {
    tx.addOutputAddress(o.address!, BigInt(o.amountSats));
  }
  if (changeSats >= 546) {
    tx.addOutputAddress(changeAddress, BigInt(changeSats));
  }
  for (const script of opReturnScripts) {
    tx.addOutput({ script, amount: 0n });
  }

  const psbtBytes = tx.toPSBT();
  return {
    psbtBase64: base64.encode(psbtBytes),
    psbtHex: hex.encode(psbtBytes),
    psbtBytes,
    fee,
    vsize: hasChange ? vsizeWithChange : estimateVsize(selected.length, addressOutputs.length, opReturnLens),
    inputCount: selected.length,
    outputCount: addressOutputs.length + (changeSats >= 546 ? 1 : 0) + opReturnScripts.length,
    totalInputSats: totalInput,
    changeSats,
  };
}

/** Sign every input the key can sign, finalize, and extract the raw tx. */
export function signAndFinalizePsbt(
  psbt: Uint8Array | string,
  privateKeyHex: string
): { txHex: string; txid: string } {
  const bytes = typeof psbt === 'string' ? hex.decode(psbt) : psbt;
  const tx = Transaction.fromPSBT(bytes, { allowUnknownOutputs: true, allowUnknownInputs: true });
  tx.sign(hex.decode(privateKeyHex));
  tx.finalize();
  const raw = tx.extract();
  return { txHex: hex.encode(raw), txid: tx.id };
}

/** Parse PSBT input in any common encoding: binary, hex, or base64. */
export function parseAnyPsbt(input: Uint8Array | string): Uint8Array {
  if (input instanceof Uint8Array) return input;
  const trimmed = input.trim().replace(/\s/g, '');
  if (/^70736274ff/i.test(trimmed) && /^[0-9a-f]+$/i.test(trimmed)) {
    return hex.decode(trimmed.toLowerCase());
  }
  if (/^cHNidP/.test(trimmed)) {
    return base64.decode(trimmed);
  }
  // last resort: try base64 then hex
  try {
    const b = base64.decode(trimmed);
    if (b[0] === 0x70 && b[1] === 0x73 && b[2] === 0x62 && b[3] === 0x74) return b;
  } catch { /* not base64 */ }
  if (/^[0-9a-f]+$/i.test(trimmed) && trimmed.length % 2 === 0) {
    return hex.decode(trimmed.toLowerCase());
  }
  throw new Error('Unrecognized PSBT encoding (expected binary, hex, or base64)');
}
