/**
 * BTC price, fee rates, and block height utilities.
 * Powers the top status bar like the original nostronchain app.
 */

import { fetchMempoolApi } from './mempool';
import type { Chain } from './chain';

const MEMPOOL_API = 'https://mempool.space/api';

export interface BlockchainStatus {
  blockHeight: number;
  btcPriceUsd: number;
  fees: {
    fastest: number;
    halfHour: number;
    hour: number;
    economy: number;
  };
  lastUpdated: number;
}

const CACHE_KEY = 'blockchain_status_cache';
const CACHE_TTL = 60_000; // 1 minute

export async function fetchBlockchainStatus(chain: Chain = 'btc'): Promise<BlockchainStatus> {
  if (chain === 'xbt') return fetchXbtStatus();
  const cached = getCachedStatus();
  if (cached && Date.now() - cached.lastUpdated < CACHE_TTL) {
    return cached;
  }

  const [blockHeight, btcPrice, fees] = await Promise.allSettled([
    fetchBlockHeight(),
    fetchBtcPrice(),
    fetchFees(),
  ]);

  const status: BlockchainStatus = {
    blockHeight: blockHeight.status === 'fulfilled' ? blockHeight.value : cached?.blockHeight ?? 0,
    btcPriceUsd: btcPrice.status === 'fulfilled' ? btcPrice.value : cached?.btcPriceUsd ?? 0,
    fees: fees.status === 'fulfilled' ? fees.value : cached?.fees ?? { fastest: 10, halfHour: 5, hour: 3, economy: 1 },
    lastUpdated: Date.now(),
  };

  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(status));
  } catch {}

  return status;
}

/** XBT (BLAKE2b chain): height and fees via the proxy; no USD quote is published for it. */
async function fetchXbtStatus(): Promise<BlockchainStatus> {
  const key = `${CACHE_KEY}_xbt`;
  let cached: BlockchainStatus | null = null;
  try { const raw = localStorage.getItem(key); cached = raw ? JSON.parse(raw) : null; } catch {}
  if (cached && Date.now() - cached.lastUpdated < CACHE_TTL) return cached;

  const [height, fees] = await Promise.allSettled([
    fetchMempoolApi('/blocks/tip/height', 12_000, 'xbt').then(async (r) => { if (!r.ok) throw new Error('height'); return parseInt(await r.text(), 10); }),
    fetchMempoolApi('/v1/fees/recommended', 12_000, 'xbt').then(async (r) => {
      if (!r.ok) throw new Error('fees');
      const d = await r.json();
      return { fastest: d.fastestFee, halfHour: d.halfHourFee, hour: d.hourFee, economy: d.economyFee };
    }),
  ]);
  const status: BlockchainStatus = {
    blockHeight: height.status === 'fulfilled' ? height.value : cached?.blockHeight ?? 0,
    btcPriceUsd: 0,
    fees: fees.status === 'fulfilled' ? fees.value : cached?.fees ?? { fastest: 1, halfHour: 1, hour: 1, economy: 1 },
    lastUpdated: Date.now(),
  };
  try { localStorage.setItem(key, JSON.stringify(status)); } catch {}
  return status;
}

function getCachedStatus(): BlockchainStatus | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function fetchBlockHeight(): Promise<number> {
  const res = await fetch(`${MEMPOOL_API}/blocks/tip/height`);
  if (!res.ok) throw new Error('Failed to fetch block height');
  const text = await res.text();
  return parseInt(text, 10);
}

async function fetchBtcPrice(): Promise<number> {
  // Primary: mempool.space price endpoint
  try {
    const res = await fetch(`${MEMPOOL_API}/v1/prices`);
    if (res.ok) {
      const data = await res.json();
      return data.USD ?? 0;
    }
  } catch {}
  // Fallback: blockchain.info ticker (also CORS-friendly)
  const res = await fetch('https://blockchain.info/ticker');
  if (!res.ok) throw new Error('Failed to fetch BTC price');
  const data = await res.json();
  return data.USD?.last ?? 0;
}

async function fetchFees(): Promise<BlockchainStatus['fees']> {
  const res = await fetch(`${MEMPOOL_API}/v1/fees/recommended`);
  if (!res.ok) throw new Error('Failed to fetch fees');
  const data = await res.json();
  return {
    fastest: data.fastestFee,
    halfHour: data.halfHourFee,
    hour: data.hourFee,
    economy: data.economyFee,
  };
}
