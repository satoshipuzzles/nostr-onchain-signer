/**
 * Mempool API integration for balance and transaction data.
 * Uses mempool.space public API with CORS proxy fallback.
 */

import { log } from '@/lib/utils/logger';

const MEMPOOL_API = 'https://mempool.space/api';
const CORS_PROXY = 'https://corsproxy.io/?';

async function fetchWithTimeout(url: string, ms = 10_000): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchMempool(path: string, ms = 10_000): Promise<Response> {
  const url = `${MEMPOOL_API}${path}`;
  try {
    const res = await fetchWithTimeout(url, ms);
    if (res.ok) return res;
    log.warn('Mempool', `Direct fetch ${res.status} for ${path}, trying proxy`);
    throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    try {
      const proxyRes = await fetchWithTimeout(`${CORS_PROXY}${encodeURIComponent(url)}`, ms);
      if (!proxyRes.ok) {
        log.error('Mempool', `Proxy fetch failed ${proxyRes.status} for ${path}`);
      }
      return proxyRes;
    } catch (proxyErr) {
      log.error('Mempool', `All fetch attempts failed for ${path}`, err, proxyErr);
      throw proxyErr;
    }
  }
}

export interface AddressInfo {
  address: string;
  chain_stats: {
    funded_txo_count: number;
    funded_txo_sum: number;
    spent_txo_count: number;
    spent_txo_sum: number;
    tx_count: number;
  };
  mempool_stats: {
    funded_txo_count: number;
    funded_txo_sum: number;
    spent_txo_count: number;
    spent_txo_sum: number;
    tx_count: number;
  };
}

export interface Transaction {
  txid: string;
  version: number;
  locktime: number;
  size: number;
  weight: number;
  fee: number;
  status: {
    confirmed: boolean;
    block_height?: number;
    block_hash?: string;
    block_time?: number;
  };
  vin: {
    txid: string;
    vout: number;
    prevout: {
      scriptpubkey_address: string;
      value: number;
    };
  }[];
  vout: {
    scriptpubkey?: string;
    scriptpubkey_asm?: string;
    scriptpubkey_address?: string;
    value: number;
  }[];
}

export interface UTXO {
  txid: string;
  vout: number;
  value: number;
  status: {
    confirmed: boolean;
    block_height?: number;
  };
}

/**
 * Fetch address balance (confirmed + unconfirmed).
 */
export async function fetchBalance(address: string): Promise<{
  confirmed: number;
  unconfirmed: number;
  total: number;
  error?: string;
}> {
  try {
    const res = await fetchMempool(`/address/${address}`);
    if (!res.ok) {
      const err = `HTTP ${res.status}`;
      log.error('Mempool', `fetchBalance failed for ${address.slice(0, 12)}...: ${err}`);
      return { confirmed: 0, unconfirmed: 0, total: 0, error: err };
    }
    const data: AddressInfo = await res.json();

    const confirmed = data.chain_stats.funded_txo_sum - data.chain_stats.spent_txo_sum;
    const unconfirmed = data.mempool_stats.funded_txo_sum - data.mempool_stats.spent_txo_sum;

    return {
      confirmed,
      unconfirmed,
      total: confirmed + unconfirmed,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Network error';
    log.error('Mempool', `fetchBalance error for ${address.slice(0, 12)}...:`, msg);
    return { confirmed: 0, unconfirmed: 0, total: 0, error: msg };
  }
}

/**
 * Fetch recent transactions for an address.
 */
export async function fetchTransactions(address: string, limit = 10): Promise<Transaction[]> {
  try {
    const res = await fetchMempool(`/address/${address}/txs`);
    if (!res.ok) return [];
    const txs: Transaction[] = await res.json();
    return txs.slice(0, limit);
  } catch (err) {
    log.error('Mempool', 'fetchTransactions error:', err);
    return [];
  }
}

/**
 * Fetch all transactions for an address (no limit).
 * Used by invoice status tracking to find payments to an invoice address.
 */
export async function fetchAddressTransactions(address: string): Promise<Transaction[]> {
  try {
    const res = await fetchMempool(`/address/${address}/txs`, 15_000);
    if (!res.ok) return [];
    return await res.json();
  } catch (err) {
    log.error('Mempool', 'fetchAddressTransactions error:', err);
    return [];
  }
}

/**
 * Fetch UTXOs for an address.
 */
export async function fetchUTXOs(address: string): Promise<UTXO[]> {
  try {
    const res = await fetch(`${MEMPOOL_API}/address/${address}/utxo`);
    if (!res.ok) return [];
    return await res.json();
  } catch {
    return [];
  }
}

/**
 * Get the current recommended fee rates.
 */
export async function fetchFeeEstimates(): Promise<{
  fastest: number;
  halfHour: number;
  hour: number;
  economy: number;
}> {
  try {
    const res = await fetch(`${MEMPOOL_API}/v1/fees/recommended`);
    if (!res.ok) return { fastest: 10, halfHour: 5, hour: 3, economy: 1 };
    const data = await res.json();
    return {
      fastest: data.fastestFee,
      halfHour: data.halfHourFee,
      hour: data.hourFee,
      economy: data.economyFee,
    };
  } catch {
    return { fastest: 10, halfHour: 5, hour: 3, economy: 1 };
  }
}

/**
 * Get mempool.space URL for an address.
 */
export function getMempoolAddressUrl(address: string): string {
  return `https://mempool.space/address/${address}`;
}

/**
 * Get mempool.space URL for a transaction.
 */
export function getMempoolTxUrl(txid: string): string {
  return `https://mempool.space/tx/${txid}`;
}

/**
 * Format satoshis for display.
 */
export function formatSats(sats: number): string {
  if (sats >= 100_000_000) {
    return `${(sats / 100_000_000).toFixed(8)} BTC`;
  }
  if (sats >= 1_000_000) {
    return `${(sats / 1_000_000).toFixed(2)}M sats`;
  }
  if (sats >= 1_000) {
    return `${(sats / 1_000).toFixed(1)}k sats`;
  }
  return `${sats} sats`;
}
