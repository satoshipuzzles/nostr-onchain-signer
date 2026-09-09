/**
 * Esplora API integration — rate-limited, cached, multi-provider, chain-aware.
 *
 * Every fetch takes a `chain` ('btc' | 'xbt', default 'btc' so existing
 * callers keep their behaviour). BTC uses the public providers directly;
 * XBT (mempool.guide) has no CORS headers and only speaks HTTP/1.1, so it is
 * always reached through the Vercel proxy.
 */

import { log } from '@/lib/utils/logger';
import { CHAIN_INFO, explorerAddressUrl, explorerTxUrl, type Chain } from './chain';

export type { Chain };

const PROVIDERS = [
  'https://blockstream.info/api',
  'https://mempool.emzy.de/api',
  'https://mempool.space/api',
] as const;

/** Vercel serverless proxy — extension uses this (has host_permission in manifest). */
const VERCEL_MEMPOOL_PROXY = 'https://nostr-onchain-signer.vercel.app/api/mempool';

/** Cache key namespace: BTC keeps the legacy bare-address keys, XBT is prefixed. */
const ck = (chain: Chain, key: string) => (chain === 'btc' ? key : `${chain}:${key}`);

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

export function getCachedBalance(address: string, chain: Chain = 'btc'): BalanceCacheEntry | null {
  return loadBalanceCache()[ck(chain, address)] ?? null;
}

function setCachedBalance(address: string, entry: Omit<BalanceCacheEntry, 'updatedAt'>, chain: Chain = 'btc') {
  try {
    const all = loadBalanceCache();
    all[ck(chain, address)] = { ...entry, updatedAt: Date.now() };
    localStorage.setItem(BALANCE_CACHE_KEY, JSON.stringify(all));
  } catch {}
}

function getCachedTransactions(address: string, chain: Chain = 'btc'): Transaction[] | null {
  try {
    const raw = localStorage.getItem(TX_CACHE_KEY);
    if (!raw) return null;
    const all: Record<string, TxCacheEntry> = JSON.parse(raw);
    const entry = all[ck(chain, address)];
    if (!entry) return null;
    if (Date.now() - entry.updatedAt > TX_CACHE_TTL * 4) return null;
    return entry.txs;
  } catch { return null; }
}

const MAX_CACHED_TXS_PER_ADDRESS = 50;
const MAX_CACHED_ADDRESSES = 10;

function setCachedTransactions(address: string, txs: Transaction[], chain: Chain = 'btc') {
  try {
    const raw = localStorage.getItem(TX_CACHE_KEY);
    let all: Record<string, TxCacheEntry> = raw ? JSON.parse(raw) : {};
    const key = ck(chain, address);
    // Cap per-address txs and total addresses to stay within mobile quota
    all[key] = { txs: txs.slice(0, MAX_CACHED_TXS_PER_ADDRESS), updatedAt: Date.now() };
    const addrs = Object.entries(all);
    if (addrs.length > MAX_CACHED_ADDRESSES) {
      addrs.sort((a, b) => b[1].updatedAt - a[1].updatedAt);
      all = Object.fromEntries(addrs.slice(0, MAX_CACHED_ADDRESSES));
    }
    try {
      localStorage.setItem(TX_CACHE_KEY, JSON.stringify(all));
    } catch {
      // Quota exceeded: drop the whole tx cache and store just this address
      localStorage.removeItem(TX_CACHE_KEY);
      localStorage.setItem(TX_CACHE_KEY, JSON.stringify({ [key]: all[key] }));
    }
  } catch {}
}

export function getCachedBlocks<T>(chain: Chain = 'btc'): T[] | null {
  try {
    const raw = localStorage.getItem(ck(chain, BLOCKS_CACHE_KEY));
    if (!raw) return null;
    const { data, updatedAt } = JSON.parse(raw);
    if (Date.now() - updatedAt > BLOCKS_CACHE_TTL * 10) return data;
    return data;
  } catch { return null; }
}

export function setCachedBlocks<T>(data: T[], chain: Chain = 'btc') {
  try {
    localStorage.setItem(ck(chain, BLOCKS_CACHE_KEY), JSON.stringify({ data, updatedAt: Date.now() }));
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

function isWebDeploy(): boolean {
  try {
    const id = chrome?.runtime?.id;
    return !id || id === 'pwa-mode';
  } catch {
    return true;
  }
}

async function fetchWithTimeout(url: string, ms = 20_000, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort(new DOMException(`Request timeout (${ms}ms)`, 'TimeoutError'));
  }, ms);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error(`Request timeout after ${Math.round(ms / 1000)}s`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchViaProxy(path: string, ms: number, init?: RequestInit, chain: Chain = 'btc'): Promise<Response> {
  const proxyBase = isWebDeploy() ? '/api/mempool' : VERCEL_MEMPOOL_PROXY;
  const chainParam = chain === 'btc' ? '' : `chain=${chain}&`;
  const proxyPath = `${proxyBase}?${chainParam}path=${encodeURIComponent(path)}`;
  return scheduleRequest(() => fetchWithTimeout(proxyPath, ms, init));
}

async function fetchDirectProviders(path: string, ms: number, init?: RequestInit): Promise<Response> {
  let lastError = 'All providers failed';
  const startIdx = providerCursor;

  for (let attempt = 0; attempt < PROVIDERS.length; attempt++) {
    const base = PROVIDERS[(startIdx + attempt) % PROVIDERS.length];
    try {
      const res = await scheduleRequest(() => fetchWithTimeout(`${base}${path}`, ms, init));
      if (res.ok) {
        providerCursor = (startIdx + attempt + 1) % PROVIDERS.length;
        return res;
      }
      if (res.status === 403 || res.status === 429) {
        lastError = `HTTP ${res.status}`;
        continue;
      }
      lastError = `HTTP ${res.status}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : 'Network error';
    }
  }
  throw new Error(lastError);
}

async function fetchEsplora(path: string, ms = 20_000, init?: RequestInit, chain: Chain = 'btc'): Promise<Response> {
  const isExtension = !isWebDeploy();

  if (!CHAIN_INFO[chain].browserDirect) {
    // XBT: proxy only (mempool.guide has no CORS and hangs on HTTP/2)
    return fetchViaProxy(path, ms, init, chain);
  }

  if (isExtension) {
    // Extension has host_permissions for Esplora APIs — use direct first (no broken chrome-extension:// proxy)
    try {
      return await fetchDirectProviders(path, ms, init);
    } catch (directErr) {
      try {
        const proxyRes = await fetchViaProxy(path, ms, init);
        if (proxyRes.ok) return proxyRes;
      } catch {
        // fall through
      }
      throw directErr;
    }
  }

  // PWA: relative Vercel proxy first, then direct fallback
  try {
    const proxyRes = await fetchViaProxy(path, ms, init);
    if (proxyRes.ok) return proxyRes;
  } catch {
    // fall through to direct
  }

  return fetchDirectProviders(path, ms, init);
}

const inflightBalances = new Map<string, Promise<BalanceResult>>();

export async function fetchBalance(address: string, opts?: { force?: boolean; chain?: Chain }): Promise<BalanceResult> {
  const chain = opts?.chain ?? 'btc';
  const cached = getCachedBalance(address, chain);
  const age = cached ? Date.now() - cached.updatedAt : Infinity;

  if (!opts?.force && cached && age < BALANCE_CACHE_TTL) {
    return balanceFromCache(cached);
  }

  const inflightKey = ck(chain, address);
  if (inflightBalances.has(inflightKey)) {
    return inflightBalances.get(inflightKey)!;
  }

  const promise = (async (): Promise<BalanceResult> => {
    try {
      const res = await fetchEsplora(`/address/${address}`, 20_000, undefined, chain);
      const data: AddressInfo = await res.json();
      const confirmed = data.chain_stats.funded_txo_sum - data.chain_stats.spent_txo_sum;
      const unconfirmed = data.mempool_stats.funded_txo_sum - data.mempool_stats.spent_txo_sum;
      const result = { confirmed, unconfirmed, total: confirmed + unconfirmed };
      setCachedBalance(address, result, chain);
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Network error';
      log.error('Mempool', `fetchBalance[${chain}] ${address.slice(0, 12)}...:`, msg);
      if (cached && age < BALANCE_CACHE_STALE) {
        return balanceFromCache(cached, true);
      }
      return { confirmed: 0, unconfirmed: 0, total: 0, error: msg };
    }
  })();

  inflightBalances.set(inflightKey, promise);
  try {
    return await promise;
  } finally {
    inflightBalances.delete(inflightKey);
  }
}

export async function fetchTransactions(address: string, limit = 10, opts?: { force?: boolean; chain?: Chain }): Promise<Transaction[]> {
  const chain = opts?.chain ?? 'btc';
  if (!opts?.force) {
    const cached = getCachedTransactions(address, chain);
    if (cached) return cached.slice(0, limit);
  }

  try {
    const res = await fetchEsplora(`/address/${address}/txs`, 20_000, undefined, chain);
    if (!res.ok) {
      const cached = getCachedTransactions(address, chain);
      return cached?.slice(0, limit) ?? [];
    }
    const txs: Transaction[] = await res.json();
    setCachedTransactions(address, txs, chain);
    return txs.slice(0, limit);
  } catch (err) {
    log.error('Mempool', 'fetchTransactions error:', err);
    return getCachedTransactions(address, chain)?.slice(0, limit) ?? [];
  }
}

export async function fetchAddressTransactions(address: string, chain: Chain = 'btc'): Promise<Transaction[]> {
  return fetchTransactions(address, 1000, { force: true, chain });
}

export async function fetchUTXOs(address: string, chain: Chain = 'btc'): Promise<UTXO[]> {
  try {
    const res = await fetchEsplora(`/address/${address}/utxo`, 20_000, undefined, chain);
    if (!res.ok) return [];
    return await res.json();
  } catch { return []; }
}

/**
 * UTXOs of an address on BOTH chains — throws if either chain is unreachable,
 * because a missing side would misclassify every coin as chain-exclusive.
 */
export async function fetchUTXOsBothChains(address: string): Promise<{ btc: UTXO[]; xbt: UTXO[] }> {
  const [btcRes, xbtRes] = await Promise.all([
    fetchEsplora(`/address/${address}/utxo`, 20_000, undefined, 'btc'),
    fetchEsplora(`/address/${address}/utxo`, 20_000, undefined, 'xbt'),
  ]);
  if (!btcRes.ok) throw new Error(`BTC UTXO lookup failed (HTTP ${btcRes.status})`);
  if (!xbtRes.ok) throw new Error(`XBT UTXO lookup failed (HTTP ${xbtRes.status})`);
  return { btc: await btcRes.json(), xbt: await xbtRes.json() };
}

export async function fetchFeeEstimates(chain: Chain = 'btc'): Promise<{
  fastest: number; halfHour: number; hour: number; economy: number;
}> {
  try {
    const res = await fetchEsplora('/v1/fees/recommended', 20_000, undefined, chain);
    if (!res.ok) return { fastest: 10, halfHour: 5, hour: 3, economy: 1 };
    const data = await res.json();
    return { fastest: data.fastestFee, halfHour: data.halfHourFee, hour: data.hourFee, economy: data.economyFee };
  } catch {
    return { fastest: 10, halfHour: 5, hour: 3, economy: 1 };
  }
}

export const MEMPOOL_API = PROVIDERS[0];

export async function fetchMempoolApi(path: string, ms = 12_000, chain: Chain = 'btc'): Promise<Response> {
  return fetchEsplora(path, ms, undefined, chain);
}

/** Confirmation status of a txid on one chain; null when that chain never saw it. */
export async function fetchTxStatus(txid: string, chain: Chain): Promise<{ confirmed: boolean; block_height?: number; block_time?: number } | null> {
  const res = await fetchEsplora(`/tx/${txid}/status`, 15_000, undefined, chain);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export function getMempoolAddressUrl(address: string, chain: Chain = 'btc'): string {
  return explorerAddressUrl(chain, address);
}

export function getMempoolTxUrl(txid: string, chain: Chain = 'btc'): string {
  return explorerTxUrl(chain, txid);
}

export function formatSats(sats: number): string {
  if (sats >= 100_000_000) return `${(sats / 100_000_000).toFixed(8)} BTC`;
  if (sats >= 1_000_000) return `${(sats / 1_000_000).toFixed(2)}M sats`;
  if (sats >= 1_000) return `${(sats / 1_000).toFixed(1)}k sats`;
  return `${sats.toLocaleString()} sats`;
}

/**
 * Broadcast a finalized raw transaction hex to ONE chain; returns txid.
 * The user's own node is used only when it follows that same chain.
 */
export async function broadcastTransaction(rawTxHex: string, chain: Chain = 'btc'): Promise<string> {
  const clean = rawTxHex.replace(/\s/g, '');

  try {
    const { loadBitcoinNodeConfig, broadcastViaNode } = await import('./node');
    const node = await loadBitcoinNodeConfig();
    if (node?.enabled && node.rpcUrl && (node.chain ?? 'btc') === chain) {
      return await broadcastViaNode(node, clean);
    }
  } catch (err) {
    log.warn('Mempool', 'Node broadcast failed, falling back to Esplora:', err);
  }

  const res = await fetchEsplora('/tx', 30_000, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: clean,
  }, chain);
  const text = (await res.text()).trim();
  if (!/^[a-f0-9]{64}$/i.test(text)) {
    throw new Error(text || 'Invalid broadcast response');
  }
  return text;
}
