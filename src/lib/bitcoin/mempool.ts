/**
 * Mempool API integration for balance and transaction data.
 * Uses mempool.space public API.
 */

const MEMPOOL_API = 'https://mempool.space/api';

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
}> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const res = await fetch(`${MEMPOOL_API}/address/${address}`, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return { confirmed: 0, unconfirmed: 0, total: 0 };
    const data: AddressInfo = await res.json();

    const confirmed = data.chain_stats.funded_txo_sum - data.chain_stats.spent_txo_sum;
    const unconfirmed = data.mempool_stats.funded_txo_sum - data.mempool_stats.spent_txo_sum;

    return {
      confirmed,
      unconfirmed,
      total: confirmed + unconfirmed,
    };
  } catch {
    return { confirmed: 0, unconfirmed: 0, total: 0 };
  }
}

/**
 * Fetch recent transactions for an address.
 */
export async function fetchTransactions(address: string, limit = 10): Promise<Transaction[]> {
  try {
    const res = await fetch(`${MEMPOOL_API}/address/${address}/txs`);
    if (!res.ok) return [];
    const txs: Transaction[] = await res.json();
    return txs.slice(0, limit);
  } catch {
    return [];
  }
}

/**
 * Fetch all transactions for an address (no limit).
 * Used by invoice status tracking to find payments to an invoice address.
 */
export async function fetchAddressTransactions(address: string): Promise<Transaction[]> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    const res = await fetch(`${MEMPOOL_API}/address/${address}/txs`, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return [];
    return await res.json();
  } catch {
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
