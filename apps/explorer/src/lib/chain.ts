/**
 * Which chain the explorer is looking at. Persisted in localStorage and
 * exposed as a tiny store + React hook so every page re-renders on switch.
 */
import { useSyncExternalStore } from 'react';
import { isChain, type Chain } from '@nostr-onchain/core';

export type { Chain };
export { CHAIN_INFO, chainTicker, chainLabel, explorerTxUrl, explorerAddressUrl, explorerHost, SPLIT_HEIGHT, SPLIT_COMMON_ANCESTOR_HEIGHT, XBT_HARDFORK_HEIGHT } from '@nostr-onchain/core';

const KEY = 'nbc_chain';
let current: Chain = (() => {
  try {
    const v = localStorage.getItem(KEY);
    return isChain(v) ? v : 'btc';
  } catch {
    return 'btc';
  }
})();
const listeners = new Set<() => void>();

export function getChain(): Chain {
  return current;
}

export function setChain(chain: Chain): void {
  if (chain === current) return;
  current = chain;
  try { localStorage.setItem(KEY, chain); } catch { /* private mode */ }
  for (const l of listeners) l();
}

export function useChain(): [Chain, (c: Chain) => void] {
  const chain = useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    () => current,
    () => current,
  );
  return [chain, setChain];
}
