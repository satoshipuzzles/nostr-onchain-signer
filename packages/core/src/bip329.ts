/**
 * BIP-329 wallet labels: the standard JSONL import/export format understood
 * by Sparrow, BlueWallet, and others. One JSON object per line.
 */

export type Bip329Type = 'tx' | 'addr' | 'pubkey' | 'input' | 'output' | 'xpub';

export interface Bip329Label {
  type: Bip329Type;
  /** txid, address, pubkey, "txid<vout" (input), "txid>vout" (output), or xpub. */
  ref: string;
  label: string;
  /** Optional spendable flag for outputs. */
  spendable?: boolean;
  /** Optional origin (BIP-329 extension used by some wallets). */
  origin?: string;
}

export function exportBip329(labels: Bip329Label[]): string {
  return labels
    .filter((l) => l.label && l.ref)
    .map((l) => JSON.stringify(l))
    .join('\n');
}

export function importBip329(jsonl: string): Bip329Label[] {
  const out: Bip329Label[] = [];
  for (const line of jsonl.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (typeof obj?.type === 'string' && typeof obj?.ref === 'string' && typeof obj?.label === 'string') {
        out.push(obj as Bip329Label);
      }
    } catch {
      // skip malformed lines — imports should be forgiving
    }
  }
  return out;
}
