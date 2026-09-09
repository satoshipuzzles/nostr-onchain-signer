/**
 * SIGHASH_UNIFIED — the opt-in signature hash of the BLAKE2b (XBT) chain.
 *
 * Spec: Bitcoin Knots doc/unified-sighash.md (v29.4.1.knots20260508).
 * One BIP341-shaped message for every script type, selected by bit 0x20 in
 * the hash type byte and tagged "UnifiedSighash". A signature that opts in
 * verifies only on chains implementing it, so an XBT spend signed this way
 * can never be replayed onto BTC (protection is one-way and per signature).
 *
 * Verified against the 166 official Knots test vectors and accepted by a
 * Knots regtest node past the activation height (see scripts/).
 *
 * Taproot notes: SIGHASH_DEFAULT (0x00) cannot opt in, so an opted-in
 * taproot signature is always 65 bytes (sig || hash_type). Use
 * SIGHASH_ALL | SIGHASH_UNIFIED = 0x21 for ordinary spends.
 */

import { sha256 } from '@noble/hashes/sha256';
import type { Transaction } from '@scure/btc-signer';

export const SIGHASH_ALL = 0x01;
export const SIGHASH_NONE = 0x02;
export const SIGHASH_SINGLE = 0x03;
export const SIGHASH_UNIFIED = 0x20;
export const SIGHASH_ANYONECANPAY = 0x80;

/** The hash type every XBT-targeted spend should use. */
export const SIGHASH_ALL_UNIFIED = SIGHASH_ALL | SIGHASH_UNIFIED; // 0x21

export const UNIFIED_SCRIPT_TYPE = {
  LEGACY: 0,      // bare / P2SH
  SEGWIT_V0: 1,   // P2WPKH / P2WSH
  TAPROOT: 2,     // taproot key path
  TAPSCRIPT: 3,   // taproot script path
} as const;
export type UnifiedScriptType = (typeof UNIFIED_SCRIPT_TYPE)[keyof typeof UNIFIED_SCRIPT_TYPE];

export interface UnifiedTxInput {
  /** 32-byte txid in RAW (wire) byte order, i.e. the reverse of the display hex. */
  txid: Uint8Array;
  vout: number;
  sequence: number;
}
export interface UnifiedTxOutput {
  value: bigint;
  script: Uint8Array;
}
export interface UnifiedTx {
  version: number;
  locktime: number;
  ins: UnifiedTxInput[];
  outs: UnifiedTxOutput[];
}
export interface UnifiedSighashOptions {
  /** Script types 0 and 1: the scriptCode (BIP143 rules). */
  scriptCode?: Uint8Array;
  /** Script type 3: the tapleaf script and version. */
  leafScript?: Uint8Array;
  leafVersion?: number;
  /** Script types 2 and 3: annex, if any. */
  annex?: Uint8Array;
  /** Script type 3: position of the last executed OP_CODESEPARATOR (0xffffffff = none). */
  codesepPos?: number;
}

const te = new TextEncoder();
function concat(...arrs: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const a of arrs) n += a.length;
  const o = new Uint8Array(n);
  let p = 0;
  for (const a of arrs) { o.set(a, p); p += a.length; }
  return o;
}
const u32le = (v: number) => Uint8Array.of(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
function u64le(v: bigint | number): Uint8Array {
  let x = BigInt(v);
  const o = new Uint8Array(8);
  for (let i = 0; i < 8; i++) { o[i] = Number(x & 0xffn); x >>= 8n; }
  return o;
}
function compactSize(n: number): Uint8Array {
  if (n < 0xfd) return Uint8Array.of(n);
  if (n <= 0xffff) return Uint8Array.of(0xfd, n & 0xff, n >> 8);
  return Uint8Array.of(0xfe, n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff);
}
const withLen = (b: Uint8Array) => concat(compactSize(b.length), b);

export function taggedHash(tag: string, msg: Uint8Array): Uint8Array {
  const th = sha256(te.encode(tag));
  return sha256(concat(th, th, msg));
}

export function tapLeafHash(script: Uint8Array, leafVersion = 0xc0): Uint8Array {
  return taggedHash('TapLeaf', concat(Uint8Array.of(leafVersion), withLen(script)));
}

export function isUnifiedSighash(hashType: number | undefined): boolean {
  return typeof hashType === 'number' && (hashType & SIGHASH_UNIFIED) !== 0;
}

/**
 * Compute the unified signature hash for input `inIdx`.
 * `spent` holds the output being spent by every input, in input order.
 */
export function unifiedSighash(
  tx: UnifiedTx,
  inIdx: number,
  hashType: number,
  scriptType: UnifiedScriptType,
  spent: UnifiedTxOutput[],
  opts: UnifiedSighashOptions = {},
): Uint8Array {
  if (!(hashType & SIGHASH_UNIFIED)) throw new Error('hash type does not opt in (SIGHASH_UNIFIED bit not set)');
  const outType = hashType & 0x1f;
  const acp = (hashType & SIGHASH_ANYONECANPAY) !== 0;
  if (scriptType === 2 || scriptType === 3) {
    // BIP341 reading: only ALL/NONE/SINGLE (optionally ANYONECANPAY) may carry the bit.
    const undefinedBits = hashType & ~(0x03 | SIGHASH_UNIFIED | SIGHASH_ANYONECANPAY);
    if (outType < 1 || outType > 3 || undefinedBits !== 0) throw new Error('undefined hash type for taproot');
  }
  if (spent.length !== tx.ins.length) throw new Error('need one spent output per input');
  if (inIdx < 0 || inIdx >= tx.ins.length) throw new Error('input index out of range');

  const parts: Uint8Array[] = [
    Uint8Array.of(0x00),           // epoch
    Uint8Array.of(hashType),
    u32le(tx.version),
    concat(u32le(tx.locktime), Uint8Array.of(0)),  // 5-byte zero-extended locktime
  ];
  if (!acp) {
    parts.push(sha256(concat(...tx.ins.map((i) => concat(i.txid, u32le(i.vout))))));
    parts.push(sha256(concat(...spent.map((s) => u64le(s.value)))));
    parts.push(sha256(concat(...spent.map((s) => withLen(s.script)))));
    parts.push(sha256(concat(...tx.ins.map((i) => u32le(i.sequence)))));
  }
  if (outType !== SIGHASH_NONE && outType !== SIGHASH_SINGLE) {
    parts.push(sha256(concat(...tx.outs.map((o) => concat(u64le(o.value), withLen(o.script))))));
  }
  parts.push(Uint8Array.of(scriptType));
  if (acp) {
    parts.push(concat(tx.ins[inIdx].txid, u32le(tx.ins[inIdx].vout)));
    parts.push(concat(u64le(spent[inIdx].value), withLen(spent[inIdx].script)));
    parts.push(u32le(tx.ins[inIdx].sequence));
  } else {
    parts.push(u32le(inIdx));
  }
  if (scriptType === 0 || scriptType === 1) {
    if (!opts.scriptCode) throw new Error('scriptCode required for script types 0 and 1');
    parts.push(withLen(opts.scriptCode));
  } else if (opts.annex) {
    parts.push(Uint8Array.of(1), sha256(withLen(opts.annex)));
  } else {
    parts.push(Uint8Array.of(0));
  }
  if (outType === SIGHASH_SINGLE) {
    const o = tx.outs[inIdx];
    if (!o) throw new Error('SIGHASH_SINGLE without a matching output');
    parts.push(sha256(concat(u64le(o.value), withLen(o.script))));
  }
  if (scriptType === 3) {
    if (!opts.leafScript) throw new Error('leafScript required for tapscript');
    parts.push(tapLeafHash(opts.leafScript, opts.leafVersion ?? 0xc0));
    parts.push(Uint8Array.of(0));                          // key version
    parts.push(u32le(opts.codesepPos ?? 0xffffffff));
  }
  return taggedHash('UnifiedSighash', concat(...parts));
}

/** Minimal raw transaction parser (legacy or segwit serialization). */
export function parseRawTx(bytes: Uint8Array): UnifiedTx & { ins: (UnifiedTxInput & { script: Uint8Array; witness?: Uint8Array[] })[] } {
  let p = 0;
  const u32 = () => { const v = (bytes[p] | (bytes[p + 1] << 8) | (bytes[p + 2] << 16) | (bytes[p + 3] << 24)) >>> 0; p += 4; return v; };
  const u64 = () => { let v = 0n; for (let i = 0; i < 8; i++) v |= BigInt(bytes[p + i]) << BigInt(8 * i); p += 8; return v; };
  const cs = () => {
    const b = bytes[p++];
    if (b < 0xfd) return b;
    if (b === 0xfd) { const v = bytes[p] | (bytes[p + 1] << 8); p += 2; return v; }
    if (b === 0xfe) return u32();
    throw new Error('varint too large');
  };
  const take = (n: number) => { const o = bytes.slice(p, p + n); p += n; return o; };
  const version = u32() | 0;
  let segwit = false;
  if (bytes[p] === 0 && bytes[p + 1] === 1) { segwit = true; p += 2; }
  const nin = cs();
  const ins: (UnifiedTxInput & { script: Uint8Array; witness?: Uint8Array[] })[] = [];
  for (let i = 0; i < nin; i++) {
    const txid = take(32); const vout = u32(); const script = take(cs()); const sequence = u32();
    ins.push({ txid, vout, script, sequence });
  }
  const nout = cs();
  const outs: UnifiedTxOutput[] = [];
  for (let i = 0; i < nout; i++) { const value = u64(); const script = take(cs()); outs.push({ value, script }); }
  if (segwit) {
    for (let i = 0; i < nin; i++) { const n = cs(); const w: Uint8Array[] = []; for (let j = 0; j < n; j++) w.push(take(cs())); ins[i].witness = w; }
  }
  const locktime = u32();
  return { version, locktime, ins, outs };
}

// ─── @scure/btc-signer bridge ────────────────────────────────────

/** Build the sighash-ready view of a scure Transaction (all inputs need witnessUtxo). */
export function unifiedTxFromScure(tx: Transaction): { tx: UnifiedTx; spent: UnifiedTxOutput[] } {
  const ins: UnifiedTxInput[] = [];
  const spent: UnifiedTxOutput[] = [];
  for (let i = 0; i < tx.inputsLength; i++) {
    const input = tx.getInput(i);
    if (!input.txid || input.index === undefined) throw new Error(`input ${i} has no outpoint`);
    const wu = input.witnessUtxo as { amount: bigint | number; script: Uint8Array } | undefined;
    if (!wu) throw new Error(`input ${i} is missing witnessUtxo — cannot compute the unified sighash`);
    // scure keeps txid in display order; the message wants wire order.
    ins.push({ txid: Uint8Array.from(input.txid).reverse(), vout: input.index, sequence: input.sequence ?? 0xffffffff });
    spent.push({ value: BigInt(wu.amount), script: Uint8Array.from(wu.script) });
  }
  const outs: UnifiedTxOutput[] = [];
  for (let i = 0; i < tx.outputsLength; i++) {
    const o = tx.getOutput(i);
    if (!o.script || o.amount === undefined) throw new Error(`output ${i} incomplete`);
    outs.push({ value: BigInt(o.amount), script: Uint8Array.from(o.script) });
  }
  return { tx: { version: tx.version, locktime: tx.lockTime, ins, outs }, spent };
}

/** Unified sighash for a taproot KEY-PATH input of a scure Transaction. */
export function unifiedKeyPathSighash(tx: Transaction, inIdx: number, hashType = SIGHASH_ALL_UNIFIED): Uint8Array {
  const { tx: utx, spent } = unifiedTxFromScure(tx);
  return unifiedSighash(utx, inIdx, hashType, UNIFIED_SCRIPT_TYPE.TAPROOT, spent);
}

/** Unified sighash for a TAPSCRIPT input (leaf script + version) of a scure Transaction. */
export function unifiedTapscriptSighash(
  tx: Transaction,
  inIdx: number,
  leafScript: Uint8Array,
  leafVersion = 0xc0,
  hashType = SIGHASH_ALL_UNIFIED,
): Uint8Array {
  const { tx: utx, spent } = unifiedTxFromScure(tx);
  return unifiedSighash(utx, inIdx, hashType, UNIFIED_SCRIPT_TYPE.TAPSCRIPT, spent, { leafScript, leafVersion });
}

/** True when any input of the PSBT declares an opted-in (unified) hash type. */
export function psbtHasUnifiedInputs(tx: Transaction): boolean {
  for (let i = 0; i < tx.inputsLength; i++) {
    if (isUnifiedSighash(tx.getInput(i).sighashType)) return true;
  }
  return false;
}

/** Human label for a hash type byte, matching Knots' spelling. */
export function sighashLabel(hashType: number | undefined): string {
  if (hashType === undefined || hashType === 0) return 'DEFAULT';
  const base = { 1: 'ALL', 2: 'NONE', 3: 'SINGLE' }[hashType & 0x1f] ?? `0x${(hashType & 0x1f).toString(16)}`;
  const parts = [base];
  if (hashType & SIGHASH_ANYONECANPAY) parts.push('ANYONECANPAY');
  if (hashType & SIGHASH_UNIFIED) parts.push('UNIFIED');
  return parts.join('|');
}
