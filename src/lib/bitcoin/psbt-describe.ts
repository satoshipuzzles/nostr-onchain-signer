/**
 * What a PSBT actually does, read from the PSBT itself.
 *
 * Signing requests arrive from web pages and from other people's Nostr
 * events, and their descriptions ("500 sats to Alice") are just text. Before
 * a key signs, show the outputs, amounts and fee the signature commits to.
 */

import { Transaction, Address, OutScript, NETWORK } from '@scure/btc-signer';
import { hex } from '@scure/base';
import { isUnifiedSighash } from './unified-sighash';

export interface PsbtOutputView {
  address: string | null;   // null for OP_RETURN / unknown scripts
  sats: number;
  opReturn?: boolean;
}

export interface PsbtView {
  inputs: number;
  inputSats: number | null; // null when some input lacks its amount
  outputs: PsbtOutputView[];
  outputSats: number;
  feeSats: number | null;
  chain: 'xbt' | 'btc';
  sighashTypes: number[];
}

export function describePsbt(psbtHex: string): PsbtView {
  const tx = Transaction.fromPSBT(hex.decode(psbtHex));
  let inputSats: number | null = 0;
  const sighashTypes = new Set<number>();
  let unified = false;
  for (let i = 0; i < tx.inputsLength; i++) {
    const inp = tx.getInput(i);
    const sh = inp.sighashType ?? 0;
    sighashTypes.add(sh);
    if (isUnifiedSighash(sh)) unified = true;
    if (inp.witnessUtxo && inputSats !== null) inputSats += Number(inp.witnessUtxo.amount);
    else inputSats = null;
  }
  const outputs: PsbtOutputView[] = [];
  let outputSats = 0;
  for (let i = 0; i < tx.outputsLength; i++) {
    const o = tx.getOutput(i);
    const sats = Number(o.amount ?? 0n);
    outputSats += sats;
    let address: string | null = null;
    let opReturn = false;
    try {
      const decoded = OutScript.decode(o.script as Uint8Array);
      if (decoded.type === 'unknown' && (o.script as Uint8Array)[0] === 0x6a) opReturn = true;
      else address = Address(NETWORK).encode(decoded);
    } catch {
      opReturn = (o.script as Uint8Array)?.[0] === 0x6a;
    }
    outputs.push({ address, sats, ...(opReturn ? { opReturn } : {}) });
  }
  return {
    inputs: tx.inputsLength,
    inputSats,
    outputs,
    outputSats,
    feeSats: inputSats === null ? null : inputSats - outputSats,
    chain: unified ? 'xbt' : 'btc',
    sighashTypes: [...sighashTypes],
  };
}

/** Plain-text summary for approval prompts. `own` marks outputs back to the user. */
export function summarizePsbt(psbtHex: string, own: string[] = []): string {
  try {
    const v = describePsbt(psbtHex);
    const mine = new Set(own.map((a) => a.toLowerCase()));
    const lines = v.outputs.map((o) =>
      o.opReturn ? `• data (OP_RETURN) ${o.sats.toLocaleString()} sats`
        : `• ${o.sats.toLocaleString()} sats → ${o.address ?? 'unknown script'}${o.address && mine.has(o.address.toLowerCase()) ? ' (you)' : ''}`,
    );
    const fee = v.feeSats === null ? 'unknown' : `${v.feeSats.toLocaleString()} sats`;
    return [`${v.chain.toUpperCase()} transaction · ${v.inputs} input(s) · fee ${fee}`, ...lines].join('\n');
  } catch {
    return 'Could not read this PSBT. Do not approve it unless you built it yourself.';
  }
}

/** True when every input spends from `address` (so a co-sign can only move that wallet's coins). */
export function psbtSpendsOnlyFrom(psbtHex: string, address: string): boolean {
  try {
    const tx = Transaction.fromPSBT(hex.decode(psbtHex));
    const want = hex.encode(OutScript.encode(Address(NETWORK).decode(address)));
    for (let i = 0; i < tx.inputsLength; i++) {
      const wu = tx.getInput(i).witnessUtxo;
      if (!wu || hex.encode(wu.script as Uint8Array) !== want) return false;
    }
    return tx.inputsLength > 0;
  } catch {
    return false;
  }
}
