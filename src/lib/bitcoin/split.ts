/**
 * Coin split status: which chain(s) each UTXO of an address still lives on.
 *
 * Every output created before block 961,632 exists on both BTC and XBT until
 * one side is spent. Spending such a coin with an ordinary signature moves it
 * on BOTH chains (replay). The fix is a self-send on XBT signed with
 * SIGHASH_UNIFIED: it confirms only on XBT, after which the BTC-side coin is
 * free to spend with an ordinary signature broadcast to BTC.
 */

import { classifyOutpoints, outpointKey, type SplitStatus } from './chain';
import { fetchUTXOsBothChains, type UTXO } from './mempool';

export interface SplitReport {
  btc: UTXO[];
  xbt: UTXO[];
  status: Map<string, SplitStatus>;
  /** XBT-side view of every coin that still exists on both chains. */
  unsplit: UTXO[];
  unsplitSats: number;
  btcOnlySats: number;
  xbtOnlySats: number;
}

export async function classifyAddressUtxos(address: string): Promise<SplitReport> {
  const { btc, xbt } = await fetchUTXOsBothChains(address);
  const status = classifyOutpoints(
    btc.map((u) => outpointKey(u.txid, u.vout)),
    xbt.map((u) => outpointKey(u.txid, u.vout)),
  );
  const unsplit = xbt.filter((u) => status.get(outpointKey(u.txid, u.vout)) === 'unsplit');
  const sum = (list: UTXO[]) => list.reduce((s, u) => s + u.value, 0);
  return {
    btc,
    xbt,
    status,
    unsplit,
    unsplitSats: sum(unsplit),
    btcOnlySats: sum(btc.filter((u) => status.get(outpointKey(u.txid, u.vout)) === 'btc')),
    xbtOnlySats: sum(xbt.filter((u) => status.get(outpointKey(u.txid, u.vout)) === 'xbt')),
  };
}

export const SPLIT_BADGE: Record<SplitStatus, { label: string; cls: string; title: string }> = {
  unsplit: {
    label: 'unsplit',
    cls: 'bg-amber-500/10 text-amber-400',
    title: 'On both chains — an ordinary spend replays onto the other chain. Split on XBT first.',
  },
  xbt: { label: 'XBT only', cls: 'bg-purple-500/10 text-purple-400', title: 'Exists only on the BLAKE2b chain.' },
  btc: { label: 'BTC only', cls: 'bg-sky-500/10 text-sky-400', title: 'Exists only on the SHA-256 chain.' },
};
