/** Chain model shared with @nostr-onchain/core (single source of truth). */
export * from '../../../packages/core/src/chain';

import { isChain, type Chain } from '../../../packages/core/src/chain';

const CHAIN_PREF_KEY = 'onchain_chain';

/** The chain the user last picked in any chain-aware page. Defaults to BTC. */
export function loadChainPreference(): Chain {
  try {
    const v = localStorage.getItem(CHAIN_PREF_KEY);
    return isChain(v) ? v : 'xbt';   // XBT is the default chain across the suite
  } catch {
    return 'xbt';
  }
}

export function saveChainPreference(chain: Chain): void {
  try { localStorage.setItem(CHAIN_PREF_KEY, chain); } catch {}
}
