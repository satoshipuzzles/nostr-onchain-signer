/**
 * Zap utilities — LNURL resolution and zap request creation (NIP-57).
 */

import { bech32 } from '@scure/base';
import { decodeInvoice, invoiceChain, type LnChain } from './lightning-chain';

export interface LnurlPayInfo {
  callback: string;
  maxSendable: number;
  minSendable: number;
  metadata: string;
  allowsNostr?: boolean;
  nostrPubkey?: string;
  /** Network the address declares ("xbt" / "btc"), if any. */
  chain?: string;
  commentAllowed?: number;
}

/**
 * Resolve a Lightning Address (lud16) to its LNURL pay endpoint info.
 */
export async function fetchLnurlPayInfo(
  lud16: string,
): Promise<LnurlPayInfo | null> {
  try {
    const url = lud16ToUrl(lud16);
    if (!url) return null;
    const res = await fetch(url);
    if (!res.ok) return null;

    const data = await res.json();
    if (data.status === 'ERROR' || typeof data.callback !== 'string') return null;

    return {
      callback: data.callback,
      maxSendable: data.maxSendable,
      minSendable: data.minSendable,
      metadata: data.metadata || '',
      allowsNostr: data.allowsNostr === true,
      nostrPubkey: typeof data.nostrPubkey === 'string' && /^[0-9a-f]{64}$/.test(data.nostrPubkey) ? data.nostrPubkey : undefined,
      chain: typeof data.chain === 'string' ? data.chain.toLowerCase() : undefined,
      commentAllowed: Number(data.commentAllowed) || 0,
    };
  } catch {
    return null;
  }
}

/**
 * Request an invoice from the LNURL callback, optionally including a
 * NIP-57 zap request for on-chain zap receipts.
 */
export async function requestZapInvoice(
  callback: string,
  amountMsats: number,
  zapRequestEvent?: string,
  extra: { lnurl?: string; comment?: string } = {},
): Promise<{ invoice?: string; error?: string }> {
  try {
    const url = new URL(callback);
    url.searchParams.set('amount', amountMsats.toString());
    if (zapRequestEvent) {
      url.searchParams.set('nostr', zapRequestEvent);
    } else if (extra.comment) {
      // Plain LNURL-pay (no zap): the comment rides as LUD-12
      url.searchParams.set('comment', extra.comment);
    }
    if (extra.lnurl) url.searchParams.set('lnurl', extra.lnurl);

    const res = await fetch(url.toString());
    if (!res.ok) return { error: `HTTP ${res.status}` };

    const data = await res.json();
    if (data.status === 'ERROR') {
      return { error: data.reason || 'LNURL error' };
    }
    return { invoice: data.pr };
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : 'Failed to get invoice',
    };
  }
}

/**
 * Build an unsigned kind 9734 zap request event (NIP-57).
 * The caller must sign it via the extension background script.
 */
export function createZapRequestEvent(
  recipientPubkey: string,
  eventId: string | undefined,
  senderPubkey: string,
  amountMsats: number,
  relays: string[],
  comment?: string,
  opts: { lnurl?: string; eventKind?: number } = {},
) {
  const tags: string[][] = [
    ['relays', ...relays],
    ['amount', amountMsats.toString()],
    ...(opts.lnurl ? [['lnurl', opts.lnurl]] : []),
    ['p', recipientPubkey],
  ];
  if (eventId) {
    tags.push(['e', eventId]);
    if (opts.eventKind !== undefined) tags.push(['k', String(opts.eventKind)]);
  }
  return {
    kind: 9734,
    pubkey: senderPubkey,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: comment || '',
  };
}

// ─── Zap receipts (kind 9735) ────────────────────────────────────


export interface ZapReceiptInfo {
  id: string;
  /** Who paid (zap request author); '' when unknown. */
  sender: string;
  /** Who was zapped (p tag). */
  recipient: string;
  /** Note that was zapped, if any. */
  eventId: string | null;
  amountSats: number;
  comment: string;
  /** Which Lightning network paid it. */
  chain: LnChain;
  createdAt: number;
  anonymous: boolean;
}

/** Read a zap receipt. Amount comes from the paid invoice, else the request. */
export function parseZapReceipt(event: { id: string; tags: string[][]; created_at: number; kind: number }): ZapReceiptInfo | null {
  if (event.kind !== 9735) return null;
  const tag = (name: string) => event.tags.find((t) => t[0] === name)?.[1];
  const bolt11 = tag('bolt11') ?? '';
  let req: { pubkey?: string; content?: string; tags?: string[][] } | null = null;
  const desc = tag('description');
  if (desc) {
    try { req = JSON.parse(desc); } catch { req = null; }
  }
  const reqTag = (name: string) => req?.tags?.find((t) => Array.isArray(t) && t[0] === name)?.[1];

  let amountSats = 0;
  const decoded = bolt11 ? decodeInvoice(bolt11) : null;
  if (decoded?.amountMsats) amountSats = Math.floor(decoded.amountMsats / 1000);
  if (!amountSats) {
    const msats = parseInt(reqTag('amount') ?? '', 10);
    if (Number.isFinite(msats) && msats > 0) amountSats = Math.floor(msats / 1000);
  }

  const declared = (reqTag('chain') ?? '').toLowerCase();
  const chain: LnChain = declared === 'xbt' || declared === 'btc'
    ? declared
    : bolt11 ? invoiceChain(bolt11) : 'btc';

  return {
    id: event.id,
    sender: (typeof req?.pubkey === 'string' ? req.pubkey : '') || tag('P') || '',
    recipient: tag('p') ?? '',
    eventId: tag('e') ?? null,
    amountSats,
    comment: typeof req?.content === 'string' ? req.content : '',
    chain,
    createdAt: event.created_at,
    anonymous: !!req?.tags?.some((t) => t[0] === 'anon'),
  };
}

/** Encode an https URL as a bech32 LNURL (for the zap request `lnurl` tag). */
export function encodeLnurl(url: string): string {
  const words = bech32.toWords(new TextEncoder().encode(url));
  return bech32.encode('lnurl', words, 2000).toUpperCase();
}

/** The LNURL-pay endpoint for a Lightning Address. */
export function lud16ToUrl(lud16: string): string | null {
  const [user, domain] = lud16.trim().toLowerCase().split('@');
  if (!user || !domain) return null;
  return `https://${domain}/.well-known/lnurlp/${encodeURIComponent(user)}`;
}
