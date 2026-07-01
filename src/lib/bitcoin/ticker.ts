/**
 * BTC price, fee rates, and block height utilities.
 * Powers the top status bar like the original nostronchain app.
 */

const MEMPOOL_API = 'https://mempool.space/api';
const COINGECKO_API = 'https://api.coingecko.com/api/v3';

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

export async function fetchBlockchainStatus(): Promise<BlockchainStatus> {
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
  const res = await fetch(`${COINGECKO_API}/simple/price?ids=bitcoin&vs_currencies=usd`);
  if (!res.ok) throw new Error('Failed to fetch BTC price');
  const data = await res.json();
  return data.bitcoin?.usd ?? 0;
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
