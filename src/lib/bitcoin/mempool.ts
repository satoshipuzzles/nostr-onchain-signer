/**
 * Esplora API integration — rate-limited, cached, multi-provider.
 */

import { log } from '@/lib/utils/logger';

const PROVIDERS = [
  'https://blockstream.info/api',
  'https://mempool.emzy.de/api',
  'https://mempool.space/api',
] as const;

const BALANCE_CACHE_KEY = 'balance_cache_v1';
const TX_CACHE_KEY = 'tx_cache_v1';
const BLOCKS_CACHE_KEY = 'blocks_cache_v1';
const BALANCE_CACHE_TTL = 3 * 60_000;
const BALANCE_CACHE_STALE = 24 * 60 * 60_000;
const TX_CACHE_TTL = 3 * 60_000;
const BLOCKS_CACHE_TTL = 2 * 60_000;
const MIN_REQUEST_INTERVAL = 300;

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

interface TxCacheEntry {
  txs: Transaction[];
  updatedAt: number;
}

// ─── Rate limiter + provider rotation ────────────────────────────

let lastRequestAt = 0;
let providerCursor = 0;
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

function nextProvider(): string {
  const p = PROVIDERS[providerCursor % PROVIDERS.length];
  providerCursor++;
  return p;
}

// ─── Caches ──────────────────────────────────────────────────────

function loadBalanceCache(): Record<string, BalanceCacheEntry> {
  try {
    const raw = localStorage.getItem(BALANCE_CACHE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

export function getCachedBalance(address: string): BalanceCacheEntry | null {
  return loadBalanceCache()[address] ?? null;
}

function setCachedBalance(address: string, entry: Omit<BalanceCacheEntry, 'updatedAt'>) {
  try {
    const all = loadBalanceCache();
    all[address] = { ...entry, updatedAt: Date.now() };
    localStorage.setItem(BALANCE_CACHE_KEY, JSON.stringify(all));
  } catch {}
}

function getCachedTransactions(address: string): Transaction[] | null {
  try {
    const raw = localStorage.getItem(TX_CACHE_KEY);
    if (!raw) return null;
    const all: Record<string, TxCacheEntry> = JSON.parse(raw);
    const entry = all[address];
    if (!entry) return null;
    if (Date.now() - entry.updatedAt > TX_CACHE_TTL * 4) return null;
    return entry.txs;
  } catch { return null; }
}

function setCachedTransactions(address: string, txs: Transaction[]) {
  try {
    const raw = localStorage.getItem(TX_CACHE_KEY);
    const all: Record<string, TxCacheEntry> = raw ? JSON.parse(raw) : {};
    all[address] = { txs, updatedAt: Date.now() };
    localStorage.setItem(TX_CACHE_KEY, JSON.stringify(all));
  } catch {}
}

export function getCachedBlocks<T>(): T[] | null {
  try {
    const raw = localStorage.getItem(BLOCKS_CACHE_KEY);
    if (!raw) return null;
    const { data, updatedAt } = JSON.parse(raw);
    if (Date.now() - updatedAt > BLOCKS_CACHE_TTL * 10) return data;
    return data;
  } catch { return null; }
}

export function setCachedBlocks<T>(data: T[]) {
  try {
    localStorage.setItem(BLOCKS_CACHE_KEY, JSON.stringify({ data, updatedAt: Date.now() }));
  } catch {}
}

function balanceFromCache(entry: BalanceCacheEntry, stale = false): BalanceResult {
  return {
    confirmed: entry.confirmed,
    unconfirmed: entry.unconfirmed,
    total: entry.total,
    cached: true,
    error: stale ? 'Using cached balance' : undefined,
  };
}

// ─── Fetch ───────────────────────────────────────────────────────

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
  const startIdx = providerCursor;

  for (let attempt = 0; attempt < PROVIDERS.length; attempt++) {
    const base = PROVIDERS[(startIdx + attempt) % PROVIDERS.length];
    try {
      const res = await scheduleRequest(() => fetchWithTimeout(`${base}${path}`, ms));
      if (res.ok) {
        providerCursor = (startIdx + attempt + 1) % PROVIDERS.length;
        return res;
      }
      if (res.status === 403 || res.status === 429) {
        log.warn('Mempool', `${base} ${res.status} on ${path}`);
        lastError = `HTTP ${res.status}`;
        continue;
      }
      lastError = `HTTP ${res.status}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : 'Network error';
      log.warn('Mempool', `${base} error:`, lastError);
    }
  }
  throw new Error(lastError);
}

const inflightBalances = new Map<string, Promise<BalanceResult>>();

export async function fetchBalance(address: string, opts?: { force?: boolean }): Promise<BalanceResult> {
  const cached = getCachedBalance(address);
  const age = cached ? Date.now() - cached.updatedAt : Infinity;

  if (!opts?.force && cached && age < BALANCE_CACHE_TTL) {
    return balanceFromCache(cached);
  }

  if (inflightBalances.has(address)) {
    return inflightBalances.get(address)!;
  }

  const promise = (async (): Promise<BalanceResult> => {
    try {
      const res = await fetchEsplora(`/address/${address}`);
      const data: AddressInfo = await res.json();
      const confirmed = data.chain_stats.funded_txo_sum - data.chain_stats.spent_txo_sum;
      const unconfirmed = data.mempool_stats.funded_txo_sum - data.mempool_stats.spent_txo_sum;
      const result = { confirmed, unconfirmed, total: confirmed + unconfirmed };
      setCachedBalance(address, result);
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Network error';
      log.error('Mempool', `fetchBalance ${address.slice(0, 12)}...:`, msg);
      if (cached && age < BALANCE_CACHE_STALE) {
        return balanceFromCache(cached, true);
      }
      return { confirmed: 0, unconfirmed: 0, total: 0, error: msg };
    }
  })();

  inflightBalances.set(address, promise);
  try {
    return await promise;
  } finally {
    inflightBalances.delete(address);
  }
}

export async function fetchTransactions(address: string, limit = 10, opts?: { force?: boolean }): Promise<Transaction[]> {
  if (!opts?.force) {
    const cached = getCachedTransactions(address);
    if (cached) return cached.slice(0, limit);
  }

  try {
    const res = await fetchEsplora(`/address/${address}/txs`);
    if (!res.ok) {
      const cached = getCachedTransactions(address);
      return cached?.slice(0, limit) ?? [];
    }
    const txs: Transaction[] = await res.json();
    setCachedTransactions(address, txs);
    return txs.slice(0, limit);
  } catch (err) {
    log.error('Mempool', 'fetchTransactions error:', err);
    return getCachedTransactions(address)?.slice(0, limit) ?? [];
  }
}

export async function fetchAddressTransactions(address: string): Promise<Transaction[]> {
  return fetchTransactions(address, 1000, { force: true });
}

export async function fetchUTXOs(address: string): Promise<UTXO[]> {
  try {
    const res = await fetchEsplora(`/address/${address}/utxo`);
    if (!res.ok) return [];
    return await res.json();
  } catch { return []; }
}

export async function fetchFeeEstimates(): Promise<{
  fastest: number; halfHour: number; hour: number; economy: number;
}> {
  try {
    const res = await fetchEsplora('/v1/fees/recommended');
    if (!res.ok) return { fastest: 10, halfHour: 5, hour: 3, economy: 1 };
    const data = await res.json();
    return { fastest: data.fastestFee, halfHour: data.halfHourFee, hour: data.hourFee, economy: data.economyFee };
  } catch {
    return { fastest: 10, halfHour: 5, hour: 3, economy: 1 };
  }
}

export const MEMPOOL_API = PROVIDERS[0];

export async function fetchMempoolApi(path: string, ms = 12_000): Promise<Response> {
  return fetchEsplora(path, ms);
}

export function getMempoolAddressUrl(address: string): string {
  return `https://mempool.space/address/${address}`;
}

export function getMempoolTxUrl(txid: string): string {
  return `https://mempool.space/tx/${txid}`;
}

export function formatSats(sats: number): string {
  if (sats >= 100_000_000) return `${(sats / 100_000_000).toFixed(8)} BTC`;
  if (sats >= 1_000_000) return `${(sats / 1_000_000).toFixed(2)}M sats`;
  if (sats >= 1_000) return `${(sats / 1_000).toFixed(1)}k sats`;
  return `${sats.toLocaleString()} sats`;
}
