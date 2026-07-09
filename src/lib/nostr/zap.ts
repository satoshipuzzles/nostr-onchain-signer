/**
 * Zap utilities — LNURL resolution and zap request creation (NIP-57).
 */

export interface LnurlPayInfo {
  callback: string;
  maxSendable: number;
  minSendable: number;
  metadata: string;
  allowsNostr?: boolean;
  nostrPubkey?: string;
}

/**
 * Resolve a Lightning Address (lud16) to its LNURL pay endpoint info.
 */
export async function fetchLnurlPayInfo(
  lud16: string,
): Promise<LnurlPayInfo | null> {
  try {
    const [user, domain] = lud16.split('@');
    if (!user || !domain) return null;

    const url = `https://${domain}/.well-known/lnurlp/${user}`;
    const res = await fetch(url);
    if (!res.ok) return null;

    const data = await res.json();
    if (data.status === 'ERROR') return null;

    return {
      callback: data.callback,
      maxSendable: data.maxSendable,
      minSendable: data.minSendable,
      metadata: data.metadata || '',
      allowsNostr: data.allowsNostr,
      nostrPubkey: data.nostrPubkey,
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
): Promise<{ invoice?: string; error?: string }> {
  try {
    const url = new URL(callback);
    url.searchParams.set('amount', amountMsats.toString());
    if (zapRequestEvent) {
      url.searchParams.set('nostr', zapRequestEvent);
    }

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
) {
  const tags: string[][] = [
    ['p', recipientPubkey],
    ['amount', amountMsats.toString()],
    ['relays', ...relays],
  ];
  if (eventId) {
    tags.splice(1, 0, ['e', eventId]);
  }
  return {
    kind: 9734,
    pubkey: senderPubkey,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: comment || '',
  };
}
