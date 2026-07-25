/**
 * PSBT document model: a lossless-enough, human-readable JSON view of a PSBT
 * for preview/editing UIs. Wire formats (binary/hex/base64) stay canonical;
 * the doc is derived for display and diffing.
 */

import { Transaction } from '@scure/btc-signer';
import { hex, base64, bech32, bech32m } from '@scure/base';
import { parseAnyPsbt } from './psbt';
import { decodeNostrOpReturn, decodeLightOp, decodeInvoiceOpReturn } from './opreturn';
import { BIP110_MAX_OP_RETURN_SCRIPT } from './bip110';

export interface PsbtDocInput {
  index: number;
  txid: string;
  vout: number;
  amountSats: number | null;
  address: string | null;
  sequence: number | null;
  rbfSignaled: boolean;
  type: string;
  tapInternalKey: string | null;
  signed: boolean;
  signatures: number;
}

export interface PsbtDocOutput {
  index: number;
  address: string | null;
  amountSats: number;
  scriptHex: string;
  type: 'p2tr' | 'p2wpkh' | 'p2wsh' | 'op_return' | 'other';
  opReturn?: {
    payloadHex: string;
    payloadText: string | null;
    scriptSize: number;
    bip110Compliant: boolean;
    protocol: 'NSTR' | 'LOPS' | 'NINV' | 'raw';
    decoded?: unknown;
  };
}

export interface PsbtDoc {
  format: 'psbt-doc';
  version: number;
  txVersion: number;
  locktime: number;
  inputCount: number;
  outputCount: number;
  totalInputSats: number | null;
  totalOutputSats: number;
  feeSats: number | null;
  fullySigned: boolean;
  inputs: PsbtDocInput[];
  outputs: PsbtDocOutput[];
  wire: {
    base64: string;
    hex: string;
  };
}

function classifyScript(script: Uint8Array): PsbtDocOutput['type'] {
  if (script.length > 0 && script[0] === 0x6a) return 'op_return';
  if (script.length === 34 && script[0] === 0x51 && script[1] === 0x20) return 'p2tr';
  if (script.length === 22 && script[0] === 0x00 && script[1] === 0x14) return 'p2wpkh';
  if (script.length === 34 && script[0] === 0x00 && script[1] === 0x20) return 'p2wsh';
  return 'other';
}

function scriptToAddress(script: Uint8Array): string | null {
  try {
    if (script.length === 34 && script[0] === 0x51 && script[1] === 0x20) {
      return bech32m.encode('bc', [1, ...bech32m.toWords(script.slice(2))]);
    }
    if (script[0] === 0x00 && (script.length === 22 || script.length === 34)) {
      return bech32.encode('bc', [0, ...bech32.toWords(script.slice(2))]);
    }
  } catch {
    // unencodable script
  }
  return null;
}

function extractOpReturnPayload(script: Uint8Array): Uint8Array {
  // OP_RETURN [push] — handle direct push, PUSHDATA1, PUSHDATA2
  if (script.length < 2) return new Uint8Array(0);
  const op = script[1];
  if (op <= 75) return script.slice(2, 2 + op);
  if (op === 0x4c) return script.slice(3, 3 + script[2]);
  if (op === 0x4d) return script.slice(4, 4 + (script[2] | (script[3] << 8)));
  return script.slice(1);
}

function tryUtf8(bytes: Uint8Array): string | null {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    // require mostly printable characters
    const printable = [...text].filter((c) => c >= ' ' || c === '\n' || c === '\t').length;
    return printable / Math.max(text.length, 1) > 0.9 ? text : null;
  } catch {
    return null;
  }
}

export function psbtToDoc(input: Uint8Array | string): PsbtDoc {
  const bytes = parseAnyPsbt(input);
  const tx = Transaction.fromPSBT(bytes, { allowUnknownOutputs: true, allowUnknownInputs: true });

  const inputs: PsbtDocInput[] = [];
  let totalInput: number | null = 0;
  let fullySigned = tx.inputsLength > 0;

  for (let i = 0; i < tx.inputsLength; i++) {
    const inp = tx.getInput(i);
    const wu = inp.witnessUtxo;
    const amount = wu ? Number(wu.amount) : null;
    if (amount === null) totalInput = null;
    else if (totalInput !== null) totalInput += amount;
    const sigCount =
      (inp.tapKeySig ? 1 : 0) +
      (inp.tapScriptSig?.length ?? 0) +
      (inp.partialSig?.length ?? 0) +
      (inp.finalScriptWitness ? 1 : 0);
    if (sigCount === 0) fullySigned = false;
    const script = wu?.script as Uint8Array | undefined;
    inputs.push({
      index: i,
      txid: inp.txid ? hex.encode(inp.txid as Uint8Array) : '',
      vout: inp.index ?? 0,
      amountSats: amount,
      address: script ? scriptToAddress(script) : null,
      sequence: inp.sequence ?? null,
      rbfSignaled: (inp.sequence ?? 0xffffffff) < 0xfffffffe,
      type: script ? classifyScript(script) : 'other',
      tapInternalKey: inp.tapInternalKey ? hex.encode(inp.tapInternalKey as Uint8Array) : null,
      signed: sigCount > 0,
      signatures: sigCount,
    });
  }

  const outputs: PsbtDocOutput[] = [];
  let totalOutput = 0;
  for (let i = 0; i < tx.outputsLength; i++) {
    const out = tx.getOutput(i);
    const script = (out.script ?? new Uint8Array(0)) as Uint8Array;
    const amount = Number(out.amount ?? 0n);
    totalOutput += amount;
    const type = classifyScript(script);
    const doc: PsbtDocOutput = {
      index: i,
      address: scriptToAddress(script),
      amountSats: amount,
      scriptHex: hex.encode(script),
      type,
    };
    if (type === 'op_return') {
      const payload = extractOpReturnPayload(script);
      const scriptHexStr = hex.encode(script);
      let protocol: 'NSTR' | 'LOPS' | 'NINV' | 'raw' = 'raw';
      let decoded: unknown;
      const nostr = decodeNostrOpReturn(scriptHexStr);
      const lops = decodeLightOp(scriptHexStr);
      const ninv = decodeInvoiceOpReturn(scriptHexStr);
      if (nostr) { protocol = 'NSTR'; decoded = nostr; }
      else if (lops) { protocol = 'LOPS'; decoded = lops; }
      else if (ninv) { protocol = 'NINV'; decoded = ninv; }
      doc.opReturn = {
        payloadHex: hex.encode(payload),
        payloadText: tryUtf8(payload),
        scriptSize: script.length,
        bip110Compliant: script.length <= BIP110_MAX_OP_RETURN_SCRIPT,
        protocol,
        decoded,
      };
    }
    outputs.push(doc);
  }

  return {
    format: 'psbt-doc',
    version: 1,
    txVersion: tx.version,
    locktime: tx.lockTime,
    inputCount: tx.inputsLength,
    outputCount: tx.outputsLength,
    totalInputSats: totalInput,
    totalOutputSats: totalOutput,
    feeSats: totalInput !== null ? totalInput - totalOutput : null,
    fullySigned,
    inputs,
    outputs,
    wire: {
      base64: base64.encode(bytes),
      hex: hex.encode(bytes),
    },
  };
}

/** Combine signatures from multiple copies of the same PSBT (co-signing). */
export function combinePsbts(psbts: (Uint8Array | string)[]): Uint8Array {
  if (psbts.length === 0) throw new Error('No PSBTs to combine');
  const txs = psbts.map((p) =>
    Transaction.fromPSBT(parseAnyPsbt(p), { allowUnknownOutputs: true, allowUnknownInputs: true })
  );
  const combined = txs[0];
  for (let t = 1; t < txs.length; t++) {
    const other = txs[t];
    if (other.inputsLength !== combined.inputsLength || other.outputsLength !== combined.outputsLength) {
      throw new Error('PSBTs describe different transactions');
    }
    for (let i = 0; i < other.inputsLength; i++) {
      const src = other.getInput(i);
      const update: Record<string, unknown> = {};
      if (src.tapKeySig && !combined.getInput(i).tapKeySig) update.tapKeySig = src.tapKeySig;
      if (src.tapScriptSig?.length) update.tapScriptSig = src.tapScriptSig;
      if (src.partialSig?.length) update.partialSig = src.partialSig;
      if (Object.keys(update).length > 0) {
        combined.updateInput(i, update, true);
      }
    }
  }
  return combined.toPSBT();
}
