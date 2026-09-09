/**
 * The two chains that share Bitcoin's history up to block 961,631.
 *
 *   btc — the SHA-256d chain (Bitcoin Core), mempool.space & friends.
 *   xbt — the BLAKE2b chain (Bitcoin Knots, BIP-110/RDTS rules). Diverged at
 *         block 961,632 (2026-08-08) when enforcing nodes rejected the first
 *         non-signaling block; BLAKE2b proof of work and the opt-in
 *         SIGHASH_UNIFIED both activated at block 961,640 (2026-08-30).
 *
 * Every output created before 961,632 exists on BOTH chains, and an
 * ordinarily-signed spend of it is valid on both (replay). See
 * `unified-sighash.ts` for the one-way protection XBT offers.
 */

export type Chain = 'btc' | 'xbt';

export const CHAINS: readonly Chain[] = ['btc', 'xbt'];

/** Last block both chains share. */
export const SPLIT_COMMON_ANCESTOR_HEIGHT = 961_631;
/** First block that exists only on XBT (and, separately, only on BTC). */
export const SPLIT_HEIGHT = 961_632;
/** BLAKE2b PoW + SIGHASH_UNIFIED activation height on XBT. */
export const XBT_HARDFORK_HEIGHT = 961_640;

export interface ChainInfo {
  id: Chain;
  /** Short ticker for UI. */
  ticker: string;
  /** Longer human label. */
  label: string;
  /** Proof-of-work function. */
  pow: string;
  /** Public esplora-compatible REST API (direct; may lack CORS). */
  esploraUrls: string[];
  /** Web explorer base for links. */
  explorerWeb: string;
  /** Whether the public API is reachable from a browser without a proxy. */
  browserDirect: boolean;
}

export const CHAIN_INFO: Record<Chain, ChainInfo> = {
  btc: {
    id: 'btc',
    ticker: 'BTC',
    label: 'BTC (SHA-256 chain)',
    pow: 'SHA-256d',
    esploraUrls: ['https://mempool.space/api', 'https://blockstream.info/api', 'https://mempool.emzy.de/api'],
    explorerWeb: 'https://mempool.space',
    browserDirect: true,
  },
  xbt: {
    id: 'xbt',
    ticker: 'XBT',
    label: 'XBT (BLAKE2b chain)',
    pow: 'BLAKE2b',
    // mempool.guide: esplora-compatible, HTTP/1.1 only, no CORS headers.
    esploraUrls: ['https://mempool.guide/api'],
    explorerWeb: 'https://mempool.guide',
    browserDirect: false,
  },
};

export function isChain(value: unknown): value is Chain {
  return value === 'btc' || value === 'xbt';
}

export function chainTicker(chain: Chain): string {
  return CHAIN_INFO[chain].ticker;
}

export function chainLabel(chain: Chain): string {
  return CHAIN_INFO[chain].label;
}

export function explorerTxUrl(chain: Chain, txid: string): string {
  return `${CHAIN_INFO[chain].explorerWeb}/tx/${txid}`;
}

export function explorerAddressUrl(chain: Chain, address: string): string {
  return `${CHAIN_INFO[chain].explorerWeb}/address/${address}`;
}

export function explorerHost(chain: Chain): string {
  return CHAIN_INFO[chain].explorerWeb.replace(/^https?:\/\//, '');
}

/**
 * Split status of one outpoint, from comparing the UTXO sets of both chains.
 *   unsplit  — unspent on both chains: any ordinary spend replays.
 *   xbt      — exists only on XBT (post-split coin, or the BTC side was spent).
 *   btc      — exists only on BTC (post-split coin, or the XBT side was spent).
 */
export type SplitStatus = 'unsplit' | 'xbt' | 'btc';

export function classifyOutpoints(
  btcOutpoints: Iterable<string>,
  xbtOutpoints: Iterable<string>,
): Map<string, SplitStatus> {
  const btcSet = new Set(btcOutpoints);
  const xbtSet = new Set(xbtOutpoints);
  const out = new Map<string, SplitStatus>();
  for (const op of btcSet) out.set(op, xbtSet.has(op) ? 'unsplit' : 'btc');
  for (const op of xbtSet) if (!btcSet.has(op)) out.set(op, 'xbt');
  return out;
}

export const outpointKey = (txid: string, vout: number): string => `${txid}:${vout}`;

export const SPLIT_STATUS_LABEL: Record<SplitStatus, string> = {
  unsplit: 'Unsplit — on both chains',
  xbt: 'XBT only',
  btc: 'BTC only',
};
