/**
 * The chain-side of the explorer: walk Bitcoin blocks via Esplora, pull out
 * every OP_RETURN carrying a known Nostr-onchain protocol (NSTR / LOPS /
 * NINV) or readable text, and keep a cumulative anchor index in IndexedDB.
 * Blocks are immutable, so scanned blocks never need re-scanning.
 */

import {
  EsploraClient,
  decodeNostrOpReturn,
  decodeLightOp,
  decodeInvoiceOpReturn,
  type EsploraTx,
} from '@nostr-onchain/core';

export type AnchorProtocol = 'NSTR' | 'LOPS' | 'NINV' | 'TEXT';

export interface AnchorRecord {
  /** `${txid}:${voutIndex}` */
  id: string;
  txid: string;
  vout: number;
  blockHeight: number;
  blockTime: number;
  feeSats: number;
  protocol: AnchorProtocol;
  scriptHex: string;
  scriptSize: number;
  /** Decoded text for TEXT anchors. */
  text?: string;
  /** NSTR: referenced Nostr event. */
  nostrEventId?: string;
  nostrKind?: number;
  /** LOPS / NINV: stored hash. */
  hash?: string;
}

export const esplora = new EsploraClient();

function extractOpReturnPayload(script: Uint8Array): Uint8Array {
  if (script.length < 2 || script[0] !== 0x6a) return new Uint8Array(0);
  const op = script[1];
  if (op <= 75) return script.slice(2, 2 + op);
  if (op === 0x4c) return script.slice(3, 3 + script[2]);
  if (op === 0x4d) return script.slice(4, 4 + (script[2] | (script[3] << 8)));
  return script.slice(1);
}

function tryReadableText(payload: Uint8Array): string | null {
  if (payload.length < 4) return null;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(payload);
    const printable = [...text].filter((c) => c >= ' ' || c === '\n').length;
    if (printable / text.length > 0.95) return text;
  } catch {
    // not UTF-8
  }
  return null;
}

/** Extract anchor records from a single transaction (any confirmed height). */
export function anchorsFromTx(tx: EsploraTx): AnchorRecord[] {
  const out: AnchorRecord[] = [];
  tx.vout.forEach((vout, index) => {
    const scriptHex = vout.scriptpubkey ?? '';
    if (!scriptHex.startsWith('6a')) return;

    const base = {
      id: `${tx.txid}:${index}`,
      txid: tx.txid,
      vout: index,
      blockHeight: tx.status.block_height ?? 0,
      blockTime: tx.status.block_time ?? 0,
      feeSats: tx.fee ?? 0,
      scriptHex,
      scriptSize: scriptHex.length / 2,
    };

    const nstr = decodeNostrOpReturn(scriptHex);
    if (nstr) {
      out.push({ ...base, protocol: 'NSTR', nostrEventId: nstr.eventId, nostrKind: nstr.kind });
      return;
    }
    const lops = decodeLightOp(scriptHex);
    if (lops) {
      out.push({ ...base, protocol: 'LOPS', hash: lops.hash });
      return;
    }
    const ninv = decodeInvoiceOpReturn(scriptHex);
    if (ninv) {
      out.push({ ...base, protocol: 'NINV', hash: ninv.hash });
      return;
    }
    // Fall back to readable text (community memos, other protocols)
    const bytes = new Uint8Array(scriptHex.length / 2);
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(scriptHex.slice(i * 2, i * 2 + 2), 16);
    const text = tryReadableText(extractOpReturnPayload(bytes));
    if (text) {
      out.push({ ...base, protocol: 'TEXT', text });
    }
  });
  return out;
}

// ─── IndexedDB anchor index ─────────────────────────────────────

const DB_NAME = 'nostr-block-chain';
const DB_VERSION = 1;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('anchors')) {
        const store = db.createObjectStore('anchors', { keyPath: 'id' });
        store.createIndex('byHeight', 'blockHeight');
      }
      if (!db.objectStoreNames.contains('scannedBlocks')) {
        db.createObjectStore('scannedBlocks', { keyPath: 'height' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveAnchors(anchors: AnchorRecord[], blockHeight: number, anchorCount: number): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction(['anchors', 'scannedBlocks'], 'readwrite');
    const store = t.objectStore('anchors');
    for (const a of anchors) store.put(a);
    t.objectStore('scannedBlocks').put({ height: blockHeight, anchorCount, scannedAt: Date.now() });
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

export async function loadAllAnchors(): Promise<AnchorRecord[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction('anchors', 'readonly').objectStore('anchors').getAll();
    req.onsuccess = () => resolve((req.result as AnchorRecord[]).sort((a, b) => b.blockHeight - a.blockHeight || a.txid.localeCompare(b.txid)));
    req.onerror = () => reject(req.error);
  });
}

export async function getScannedHeights(): Promise<Set<number>> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction('scannedBlocks', 'readonly').objectStore('scannedBlocks').getAllKeys();
    req.onsuccess = () => resolve(new Set(req.result as number[]));
    req.onerror = () => reject(req.error);
  });
}

// ─── Block scanning ─────────────────────────────────────────────

export interface ScanProgress {
  height: number;
  txsScanned: number;
  txCount: number;
  anchorsFound: number;
}

/** Scan one block completely; resolves with its anchors (also persisted). */
export async function scanBlock(
  height: number,
  onProgress?: (p: ScanProgress) => void
): Promise<AnchorRecord[]> {
  const hash = await esplora.getBlockHashAtHeight(height);
  const block = await esplora.getBlock(hash);
  const anchors: AnchorRecord[] = [];

  for (let start = 0; start < block.tx_count; start += 25) {
    const txs = await esplora.getBlockTxs(hash, start);
    for (const tx of txs) {
      // status may be missing on some esplora block-tx responses — fill in
      tx.status = tx.status?.block_height
        ? tx.status
        : { confirmed: true, block_height: height, block_time: block.timestamp };
      anchors.push(...anchorsFromTx(tx));
    }
    onProgress?.({ height, txsScanned: Math.min(start + 25, block.tx_count), txCount: block.tx_count, anchorsFound: anchors.length });
    if (txs.length < 25) break;
  }

  await saveAnchors(anchors, height, anchors.length);
  return anchors;
}

/** Fetch a single tx and extract anchors (for txid search / permalinks). */
export async function anchorsForTxid(txid: string): Promise<AnchorRecord[]> {
  const tx = await esplora.getTransaction(txid);
  return anchorsFromTx(tx);
}

/** Discover anchors written by a taproot address (profile pages). */
export async function anchorsForAddress(address: string): Promise<AnchorRecord[]> {
  const txs = await esplora.getTransactions(address);
  const out: AnchorRecord[] = [];
  for (const tx of txs) {
    // only txs the address actually funded (they authored the OP_RETURN)
    const spends = tx.vin.some((v) => v.prevout?.scriptpubkey_address === address);
    if (spends) out.push(...anchorsFromTx(tx));
  }
  return out;
}
