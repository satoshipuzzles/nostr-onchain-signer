/**
 * Work out what a scanned or pasted Lightning-ish string is, so one Pay box
 * can take anything: an invoice, a Lightning Address, an LNURL, a Nostr
 * profile or note to zap, a wallet connection, or an on-chain address.
 */

import { bech32 } from '@scure/base';
import { nip19 } from 'nostr-tools';
import { parsePaymentUri } from '@/lib/bitcoin/payment-uri';

export type ScanTarget =
  | { type: 'invoice'; invoice: string }
  | { type: 'address'; address: string }
  | { type: 'lnurl'; url: string }
  | { type: 'profile'; pubkey: string; relays: string[] }
  | { type: 'note'; id: string; author?: string; relays: string[] }
  | { type: 'nwc'; uri: string }
  | { type: 'onchain'; address: string; amountSats?: string };

const INVOICE_RE = /^ln(bc|tb|bcrt|tbs|sb)[0-9a-z]*1[02-9ac-hj-np-z]+$/;

export function decodeLnurl(lnurl: string): string | null {
  try {
    const { prefix, words } = bech32.decode(lnurl.toLowerCase() as `${string}1${string}`, 2000);
    if (prefix !== 'lnurl') return null;
    return new TextDecoder().decode(bech32.fromWords(words));
  } catch {
    return null;
  }
}

export function classifyScan(raw: string): ScanTarget | null {
  let text = raw.trim();
  if (!text) return null;

  if (/^nostr\+walletconnect:/i.test(text)) return { type: 'nwc', uri: text };

  // BIP-21 with a Lightning fallback: prefer the invoice, it settles instantly
  if (/^bitcoin:/i.test(text)) {
    const q = text.split('?')[1] ?? '';
    const ln = new URLSearchParams(q).get('lightning') ?? new URLSearchParams(q.toLowerCase()).get('lightning');
    if (ln && INVOICE_RE.test(ln.toLowerCase())) return { type: 'invoice', invoice: ln.toLowerCase() };
  }

  text = text.replace(/^(lightning|nostr):(\/\/)?/i, '');
  const lower = text.toLowerCase();

  if (INVOICE_RE.test(lower)) return { type: 'invoice', invoice: lower };

  if (lower.startsWith('lnurl1')) {
    const url = decodeLnurl(lower);
    return url ? { type: 'lnurl', url } : null;
  }
  // LUD-17 schemes
  const lud17 = /^(lnurlp|lnurlw|keyauth):\/\/(.+)$/i.exec(text);
  if (lud17) return { type: 'lnurl', url: `https://${lud17[2]}` };

  if (/^[a-z0-9._+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(text)) return { type: 'address', address: lower };

  if (/^(npub|nprofile|note|nevent)1[02-9ac-hj-np-z]+$/.test(lower)) {
    try {
      const d = nip19.decode(lower);
      if (d.type === 'npub') return { type: 'profile', pubkey: d.data, relays: [] };
      if (d.type === 'nprofile') return { type: 'profile', pubkey: d.data.pubkey, relays: d.data.relays ?? [] };
      if (d.type === 'note') return { type: 'note', id: d.data, relays: [] };
      if (d.type === 'nevent') return { type: 'note', id: d.data.id, author: d.data.author, relays: d.data.relays ?? [] };
    } catch {
      return null;
    }
  }

  const pay = parsePaymentUri(raw);
  if (pay && /^(bc1|tb1|[13mn2])[a-zA-HJ-NP-Z0-9]{20,90}$/.test(pay.target)) {
    return { type: 'onchain', address: pay.target, amountSats: pay.amountSats };
  }
  return null;
}
