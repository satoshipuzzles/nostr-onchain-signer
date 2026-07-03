/**
 * Mempool / Esplora API integration for balance and transaction data.
 * Rate-limited, cached, multi-provider fallback.
 */

import { log } from '@/lib/utils/logger';

// Esplora-compatible providers (same API shape)
const PROVIDERS = [
  'https://mempool.space/api',
  'https://blockstream.info/api',
  'https://mempool.emzy.de/api',
] as const;

const BALANCE_CACHE_KEY = 'balance_cache_v1';
const BALANCE_CACHE_TTL = 5 * 60_000;      // 5 min — fresh
const BALANCE_CACHE_STALE = 60 * 60_000;   // 1 hr — usable on API failure
const MIN_REQUEST_INTERVAL = 900;          // ms between outbound requests

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

interface BalanceResult {
  confirmed: number;
  unconfirmed: number;
  total: number;
  error?: string;
  cached?: boolean;
}

interface BalanceCacheEntry {
  confirmed: number;
  unconfirmed: number;
  total: number;
  updatedAt: number;
}

// ─── Rate limiter ────────────────────────────────────────────────

let lastRequestAt = 0;
let requestQueue: Promise<void> = Promise.resolve();

function scheduleRequest<T>(fn: () => Promise<T>): Promise<T> {
  const run = async () => {
    const now = Date.now();
    const wait = Math.max(0, MIN_REQUEST_INTERVAL - (now - lastRequestAt));
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
    return fn();
  };
  const p = requestQueue.then(run, run);
  requestQueue = p.then(() => {}, () => {});
  return p;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── In-flight dedup ─────────────────────────────────────────────

const inflight = new Map<string, Promise<BalanceResult>>();

// ─── Balance cache (localStorage) ────────────────────────────────

function loadBalanceCache(): Record<string, BalanceCacheEntry> {
  try {
    const raw = localStorage.getItem(BALANCE_CACHE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export function getCachedBalance(address: string): BalanceCacheEntry | null {
  return getCachedBalanceEntry(address);
}

function getCachedBalanceEntry(address: string): BalanceCacheEntry | null {
  const all = loadBalanceCache();
  return all[address] ?? null;
}

function setCachedBalance(address: string, entry: Omit<BalanceCacheEntry, 'updatedAt'>) {
  try {
    const all = loadBalanceCache();
    all[address] = { ...entry, updatedAt: Date.now() };
    // Prune entries older than 24h
    const cutoff = Date.now() - 24 * 60 * 60_000;
    for (const [addr, e] of Object.entries(all)) {
      if (e.updatedAt < cutoff) delete all[addr];
    }
    localStorage.setItem(BALANCE_CACHE_KEY, JSON.stringify(all));
  } catch {}
}

function balanceFromCache(entry: BalanceCacheEntry, stale = false): BalanceResult {
  return {
    confirmed: entry.confirmed,
    unconfirmed: entry.unconfirmed,
    total: entry.total,
    cached: true,
    error: stale ? 'Using cached balance (API rate limited)' : undefined,
  };
}

// ─── Multi-provider fetch ────────────────────────────────────────

async function fetchWithTimeout(url: string, ms = 12_000): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchEsplora(path: string, ms = 12_000): Promise<Response> {
  let lastError = 'All providers failed';

  for (const base of PROVIDERS) {
    try {
      const res = await scheduleRequest(() => fetchWithTimeout(`${base}${path}`, ms));
      if (res.ok) return res;
      if (res.status === 429 || res.status === 403) {
        log.warn('Mempool', `${base} returned ${res.status} for ${path}, trying next provider`);
        lastError = `HTTP ${res.status}`;
        await sleep(500);
        continue;
      }
      lastError = `HTTP ${res.status}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : 'Network error';
      log.warn('Mempool', `${base} failed for ${path}:`, lastError);
    }
  }

  throw new Error(lastError);
}

// ─── Public API ──────────────────────────────────────────────────

/**
 * Fetch address balance (confirmed + unconfirmed).
 * Returns cached value immediately when fresh; rate-limits network calls.
 */
export async function fetchBalance(address: string, opts?: { force?: boolean }): Promise<BalanceResult> {
  const cached = getCachedBalanceEntry(address);
  const age = cached ? Date.now() - cached.updatedAt : Infinity;

  // Return fresh cache without hitting network
  if (!opts?.force && cached && age < BALANCE_CACHE_TTL) {
    return balanceFromCache(cached);
  }

  // Dedupe concurrent fetches for same address
  const inflightKey = address;
  if (inflight.has(inflightKey)) {
    return inflight.get(inflightKey)!;
  }

  const promise = fetchBalanceNetwork(address, cached, age);
  inflight.set(inflightKey, promise);
  try {
    return await promise;
  } finally {
    inflight.delete(inflightKey);
  }
}

async function fetchBalanceNetwork(
  address: string,
  cached: BalanceCacheEntry | null,
  age: number,
): Promise<BalanceResult> {
  try {
    const res = await fetchEsplora(`/address/${address}`);
    const data: AddressInfo = await res.json();

    const confirmed = data.chain_stats.funded_txo_sum - data.chain_stats.spent_txo_sum;
    const unconfirmed = data.mempool_stats.funded_txo_sum - data.mempool_stats.spent_txo_sum;
    const result = { confirmed, unconfirmed, total: confirmed + unconfirmed };

    setCachedBalance(address, result);
    log.debug('Mempool', `Balance for ${address.slice(0, 12)}...: ${result.total} sats`);
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Network error';
    log.error('Mempool', `fetchBalance failed for ${address.slice(0, 12)}...:`, msg);

    // Return stale cache rather than zero on rate limit
    if (cached && age < BALANCE_CACHE_STALE) {
      log.info('Mempool', `Returning stale cache for ${address.slice(0, 12)}...`);
      return balanceFromCache(cached, true);
    }

    return { confirmed: 0, unconfirmed: 0, total: 0, error: msg };
  }
}

/**
 * Fetch recent transactions for an address.
 */
export async function fetchTransactions(address: string, limit = 10): Promise<Transaction[]> {
  try {
    const res = await fetchEsplora(`/address/${address}/txs`);
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
 */
export async function fetchAddressTransactions(address: string): Promise<Transaction[]> {
  try {
    const res = await fetchEsplora(`/address/${address}/txs`, 15_000);
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
    const res = await fetchEsplora(`/address/${address}/utxo`);
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
    const res = await fetchEsplora('/v1/fees/recommended');
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

export function getMempoolAddressUrl(address: string): string {
  return `https://mempool.space/address/${address}`;
}

export function getMempoolTxUrl(txid: string): string {
  return `https://mempool.space/tx/${txid}`;
}

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

// Re-export for OnchainExplorer compatibility
export const MEMPOOL_API = PROVIDERS[0];

export async function fetchMempoolApi(path: string, ms = 12_000): Promise<Response> {
  return fetchEsplora(path, ms);
}
