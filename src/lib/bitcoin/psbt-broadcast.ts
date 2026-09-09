/**
 * Combine signed PSBTs and broadcast to the Bitcoin network.
 */

import { Transaction, PSBTCombine } from '@scure/btc-signer';
import { hex } from '@scure/base';
import { broadcastTransaction } from './mempool';
import type { Chain } from './chain';
import { psbtHasUnifiedInputs } from './unified-sighash';

function psbtHexToBytes(h: string): Uint8Array {
  const clean = h.trim().replace(/\s/g, '').replace(/^0x/i, '');
  return hex.decode(clean);
}

export function combinePsbtsToRawTx(psbtHexList: string[]): { rawHex: string; chain: Chain } {
  const unique = [...new Set(psbtHexList.filter(Boolean))];
  if (unique.length === 0) throw new Error('No PSBTs to combine');

  let combined: Uint8Array;
  if (unique.length === 1) {
    combined = psbtHexToBytes(unique[0]);
  } else {
    combined = PSBTCombine(unique.map(psbtHexToBytes));
  }

  const tx = Transaction.fromPSBT(combined, { allowUnknownOutputs: true, allowUnknownInputs: true });
  // A PSBT whose inputs opted in to SIGHASH_UNIFIED is an XBT transaction:
  // its signatures do not verify on BTC, so broadcasting there is pointless.
  const chain: Chain = psbtHasUnifiedInputs(tx) ? 'xbt' : 'btc';
  tx.finalize();
  return { rawHex: hex.encode(tx.extract()), chain };
}

/** Combine, finalize and broadcast to the chain the PSBT was built for (or `chain` if given). */
export async function broadcastPsbts(psbtHexList: string[], chain?: Chain): Promise<string> {
  const combined = combinePsbtsToRawTx(psbtHexList);
  return broadcastTransaction(combined.rawHex, chain ?? combined.chain);
}
