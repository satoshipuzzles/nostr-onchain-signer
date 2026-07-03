/**
 * Combine signed PSBTs and broadcast to the Bitcoin network.
 */

import { Transaction, PSBTCombine } from '@scure/btc-signer';
import { hex } from '@scure/base';
import { broadcastTransaction } from './mempool';

function psbtHexToBytes(h: string): Uint8Array {
  const clean = h.trim().replace(/\s/g, '').replace(/^0x/i, '');
  return hex.decode(clean);
}

export function combinePsbtsToRawTx(psbtHexList: string[]): string {
  const unique = [...new Set(psbtHexList.filter(Boolean))];
  if (unique.length === 0) throw new Error('No PSBTs to combine');

  let combined: Uint8Array;
  if (unique.length === 1) {
    combined = psbtHexToBytes(unique[0]);
  } else {
    combined = PSBTCombine(unique.map(psbtHexToBytes));
  }

  const tx = Transaction.fromPSBT(combined);
  tx.finalize();
  return hex.encode(tx.extract());
}

export async function broadcastPsbts(psbtHexList: string[]): Promise<string> {
  const rawHex = combinePsbtsToRawTx(psbtHexList);
  return broadcastTransaction(rawHex);
}
