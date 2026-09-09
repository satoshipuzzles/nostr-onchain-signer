/**
 * Minimal, dependency-free Esplora REST client.
 *
 * Pure by design: the caller decides the base URL (public providers or their
 * own node's Esplora/electrs endpoint) and owns caching. No browser or
 * extension APIs are used, so this runs in web apps, service workers, and Node.
 */

export interface EsploraConfig {
  /** Ordered list of base URLs; each request tries them in turn. */
  baseUrls: string[];
  timeoutMs?: number;
}

/**
 * A base URL may be a query-style proxy ending in `path=` (e.g.
 * `https://host/api/mempool?chain=xbt&path=`); the request path is then
 * URL-encoded and appended instead of concatenated. Needed for the XBT API,
 * which has no CORS headers.
 */
export function esploraUrl(base: string, path: string): string {
  return base.endsWith('path=') ? `${base}${encodeURIComponent(path)}` : `${base}${path}`;
}

export const XBT_ESPLORA_URL = 'https://mempool.guide/api';
/** Vercel proxy of this repo; reaches mempool.guide over HTTP/1.1 and adds CORS. */
export const XBT_ESPLORA_PROXY = 'https://nostr-onchain-signer.vercel.app/api/mempool?chain=xbt&path=';

export const DEFAULT_ESPLORA_URLS = [
  'https://mempool.space/api',
  'https://blockstream.info/api',
  'https://mempool.emzy.de/api',
];

export interface EsploraUtxo {
  txid: string;
  vout: number;
  value: number;
  status: { confirmed: boolean; block_height?: number; block_time?: number };
}

export interface EsploraVout {
  scriptpubkey?: string;
  scriptpubkey_asm?: string;
  scriptpubkey_type?: string;
  scriptpubkey_address?: string;
  value: number;
}

export interface EsploraTx {
  txid: string;
  version: number;
  locktime: number;
  size: number;
  weight: number;
  fee: number;
  status: { confirmed: boolean; block_height?: number; block_hash?: string; block_time?: number };
  vin: {
    txid: string;
    vout: number;
    sequence?: number;
    prevout: EsploraVout | null;
  }[];
  vout: EsploraVout[];
}

export interface EsploraAddressInfo {
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

export interface EsploraBlock {
  id: string;
  height: number;
  version: number;
  timestamp: number;
  tx_count: number;
  size: number;
  weight: number;
  previousblockhash: string;
}

export interface FeeEstimates {
  fastest: number;
  halfHour: number;
  hour: number;
  economy: number;
}

async function fetchWithTimeout(url: string, timeoutMs: number, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Esplora client for a given chain. BTC talks to the public providers
 * directly; XBT goes through the proxy (browser) or mempool.guide (node).
 */
export function esploraForChain(chain: 'btc' | 'xbt', opts?: { proxyBase?: string; direct?: boolean; timeoutMs?: number }): EsploraClient {
  if (chain === 'btc') return new EsploraClient({ timeoutMs: opts?.timeoutMs });
  const base = opts?.direct ? XBT_ESPLORA_URL : (opts?.proxyBase ?? XBT_ESPLORA_PROXY);
  return new EsploraClient({ baseUrls: [base], timeoutMs: opts?.timeoutMs });
}

export class EsploraClient {
  private baseUrls: string[];
  private timeoutMs: number;

  constructor(config?: Partial<EsploraConfig>) {
    this.baseUrls = config?.baseUrls?.length ? config.baseUrls : DEFAULT_ESPLORA_URLS;
    this.timeoutMs = config?.timeoutMs ?? 20_000;
  }

  private async request(path: string, init?: RequestInit): Promise<Response> {
    let lastError: unknown = new Error('All Esplora providers failed');
    for (const base of this.baseUrls) {
      try {
        const res = await fetchWithTimeout(esploraUrl(base, path), this.timeoutMs, init);
        if (res.ok) return res;
        // POST bodies (broadcast) return meaningful errors — surface, don't rotate
        if (init?.method === 'POST') return res;
        lastError = new Error(`HTTP ${res.status} from ${base}`);
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  async getAddressInfo(address: string): Promise<EsploraAddressInfo> {
    const res = await this.request(`/address/${address}`);
    return res.json();
  }

  async getBalance(address: string): Promise<{ confirmed: number; unconfirmed: number; total: number }> {
    const info = await this.getAddressInfo(address);
    const confirmed = info.chain_stats.funded_txo_sum - info.chain_stats.spent_txo_sum;
    const unconfirmed = info.mempool_stats.funded_txo_sum - info.mempool_stats.spent_txo_sum;
    return { confirmed, unconfirmed, total: confirmed + unconfirmed };
  }

  async getUtxos(address: string): Promise<EsploraUtxo[]> {
    const res = await this.request(`/address/${address}/utxo`);
    return res.json();
  }

  async getTransactions(address: string): Promise<EsploraTx[]> {
    const res = await this.request(`/address/${address}/txs`);
    return res.json();
  }

  async getTransaction(txid: string): Promise<EsploraTx> {
    const res = await this.request(`/tx/${txid}`);
    return res.json();
  }

  async getTipHeight(): Promise<number> {
    const res = await this.request('/blocks/tip/height');
    return parseInt(await res.text(), 10);
  }

  async getBlockHashAtHeight(height: number): Promise<string> {
    const res = await this.request(`/block-height/${height}`);
    return (await res.text()).trim();
  }

  async getBlock(hash: string): Promise<EsploraBlock> {
    const res = await this.request(`/block/${hash}`);
    return res.json();
  }

  /** Paged block transactions (25 per page, startIndex must be a multiple of 25). */
  async getBlockTxs(hash: string, startIndex = 0): Promise<EsploraTx[]> {
    const res = await this.request(startIndex > 0 ? `/block/${hash}/txs/${startIndex}` : `/block/${hash}/txs`);
    return res.json();
  }

  /** Recent blocks (10), optionally starting at a height going backwards. */
  async getBlocks(startHeight?: number): Promise<EsploraBlock[]> {
    const res = await this.request(startHeight ? `/blocks/${startHeight}` : '/blocks');
    return res.json();
  }

  async getFeeEstimates(): Promise<FeeEstimates> {
    try {
      // mempool.space extension endpoint
      const res = await this.request('/v1/fees/recommended');
      const data = await res.json();
      if (data.fastestFee) {
        return { fastest: data.fastestFee, halfHour: data.halfHourFee, hour: data.hourFee, economy: data.economyFee };
      }
    } catch {
      // fall through to the standard esplora endpoint
    }
    try {
      const res = await this.request('/fee-estimates');
      const data: Record<string, number> = await res.json();
      return {
        fastest: Math.ceil(data['1'] ?? 10),
        halfHour: Math.ceil(data['3'] ?? 5),
        hour: Math.ceil(data['6'] ?? 3),
        economy: Math.ceil(data['144'] ?? 1),
      };
    } catch {
      return { fastest: 10, halfHour: 5, hour: 3, economy: 1 };
    }
  }

  /** Broadcast a finalized raw transaction; returns the txid. */
  async broadcast(rawTxHex: string): Promise<string> {
    const res = await this.request('/tx', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: rawTxHex.replace(/\s/g, ''),
    });
    const text = (await res.text()).trim();
    if (!/^[a-f0-9]{64}$/i.test(text)) {
      throw new Error(text || 'Broadcast rejected');
    }
    return text;
  }

  /** Confirmation status of a txid, or null when the chain has never seen it. */
  async getTxStatus(txid: string): Promise<{ confirmed: boolean; block_height?: number; block_time?: number } | null> {
    for (const base of this.baseUrls) {
      try {
        const res = await fetchWithTimeout(esploraUrl(base, `/tx/${txid}/status`), this.timeoutMs);
        if (res.status === 404) return null;
        if (res.ok) return res.json();
      } catch {
        // try the next provider
      }
    }
    throw new Error('All Esplora providers failed');
  }
}
