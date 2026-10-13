/**
 * Parse whatever a payment QR code holds into a recipient and an optional amount.
 *
 * Wallets encode addresses as a bare address, as a BIP-21 URI
 * (`bitcoin:bc1...?amount=0.001&label=...`), sometimes upper-cased for denser
 * QR codes, and sometimes under another scheme (`xbt:`). npubs come as `nostr:npub1...`.
 * The amount in BIP-21 is in whole coins; it is converted to sats with string
 * arithmetic so 0.1 + 0.2 style float errors can never change what is sent.
 */
export interface ScannedPayment {
  /** Address, npub or hex pubkey, scheme stripped. */
  target: string;
  /** Amount in sats, if the code carried one. */
  amountSats?: string;
  label?: string;
  message?: string;
}

export function coinsToSats(coins: string): string | null {
  const m = /^(\d{0,8})(?:\.(\d{0,8}))?$/.exec(coins.trim());
  if (!m || (!m[1] && !m[2])) return null;
  const sats = BigInt(m[1] || '0') * 100_000_000n + BigInt((m[2] || '').padEnd(8, '0') || '0');
  return sats > 0n ? sats.toString() : null;
}

export function parsePaymentUri(raw: string): ScannedPayment | null {
  const text = raw.trim();
  if (!text) return null;
  const schemeMatch = /^([a-z][a-z0-9+.-]*):(.*)$/i.exec(text);
  const body = schemeMatch && !/^(bc1|tb1)/i.test(text) ? schemeMatch[2].replace(/^\/\//, '') : text;
  const [path, query = ''] = body.split('?');
  const target = decodeURIComponent(path).trim();
  if (!target) return null;

  const out: ScannedPayment = { target };
  // Keys are matched case-insensitively: upper-case QR codes send AMOUNT=.
  const params = new Map<string, string>();
  new URLSearchParams(query).forEach((v, k) => { if (!params.has(k.toLowerCase())) params.set(k.toLowerCase(), v); });
  const amount = params.get('amount');
  if (amount) {
    const sats = coinsToSats(amount);
    if (sats) out.amountSats = sats;
  }
  const label = params.get('label');
  if (label) out.label = label;
  const message = params.get('message');
  if (message) out.message = message;
  return out;
}
