import { fetchAddressTransactions, type Transaction } from './mempool';

export type InvoiceStatus = 'pending' | 'paid' | 'expired' | 'partially_paid';

export interface InvoiceTrackerResult {
  status: InvoiceStatus;
  confirmedSats: number;
  unconfirmedSats: number;
  transactions: { txid: string; amount: number; confirmed: boolean; timestamp?: number }[];
}

/**
 * Check the status of an invoice by querying mempool.space for transactions
 * to the invoice address.
 */
export async function checkInvoiceStatus(
  address: string,
  expectedSats: number | undefined,
  expiresAt: number | undefined,
): Promise<InvoiceTrackerResult> {
  const txs = await fetchAddressTransactions(address);

  let confirmedSats = 0;
  let unconfirmedSats = 0;
  const transactions: InvoiceTrackerResult['transactions'] = [];

  for (const tx of txs) {
    let amount = 0;
    for (const vout of tx.vout) {
      if (vout.scriptpubkey_address === address) {
        amount += vout.value;
      }
    }
    if (amount > 0) {
      if (tx.status.confirmed) {
        confirmedSats += amount;
      } else {
        unconfirmedSats += amount;
      }
      transactions.push({
        txid: tx.txid,
        amount,
        confirmed: tx.status.confirmed,
        timestamp: tx.status.block_time,
      });
    }
  }

  const totalReceived = confirmedSats + unconfirmedSats;

  let status: InvoiceStatus = 'pending';
  if (expectedSats && totalReceived >= expectedSats) {
    status = 'paid';
  } else if (expectedSats && totalReceived > 0 && totalReceived < expectedSats) {
    status = 'partially_paid';
  } else if (!expectedSats && totalReceived > 0) {
    status = 'paid';
  } else if (expiresAt && expiresAt > 0 && Date.now() / 1000 > expiresAt) {
    status = 'expired';
  }

  return { status, confirmedSats, unconfirmedSats, transactions };
}
