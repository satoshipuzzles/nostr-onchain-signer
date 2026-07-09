export interface InvoiceDmPayload {
  type: 'nostr-onchain-invoice';
  invoice_event_id: string;
  address: string;
  amount_sats: number | null;
  op_return_hex: string | null;
  pay_url: string;
}

export function parseInvoiceDmPayload(text: string): InvoiceDmPayload | null {
  const trimmed = text.trim();

  const jsonBlock = trimmed.match(/---\s*\n(\{[\s\S]*\})\s*$/);
  if (jsonBlock) {
    try {
      const parsed = JSON.parse(jsonBlock[1]) as InvoiceDmPayload;
      if (parsed.type === 'nostr-onchain-invoice' && parsed.invoice_event_id) {
        return parsed;
      }
    } catch {}
  }

  try {
    const parsed = JSON.parse(trimmed) as InvoiceDmPayload;
    if (parsed.type === 'nostr-onchain-invoice' && parsed.invoice_event_id) {
      return parsed;
    }
  } catch {}

  const payUrlMatch = trimmed.match(/Pay in-app:\s*(https?:\/\/\S+|\/\S+)/i);
  const invoiceMatch = trimmed.match(/invoice[_ ]?event[_ ]?id[":\s]+([a-f0-9]{64})/i)
    || trimmed.match(/\/invoice\/([a-f0-9]{64})/i);
  const addressMatch = trimmed.match(/Address:\s*(\S+)/i);
  const amountMatch = trimmed.match(/Amount:\s*([\d,]+)\s*sats/i);
  const opReturnMatch = trimmed.match(/OP_RETURN proof[^:]*:\s*([0-9a-f]+)/i);

  if (invoiceMatch && addressMatch) {
    const amount = amountMatch ? parseInt(amountMatch[1].replace(/,/g, ''), 10) : null;
    let payUrl = payUrlMatch?.[1] ?? `/send?invoice=${invoiceMatch[1]}&to=${addressMatch[1]}`;
    if (payUrl.startsWith('/')) {
      payUrl = `${window.location.origin}${payUrl}`;
    }
    return {
      type: 'nostr-onchain-invoice',
      invoice_event_id: invoiceMatch[1],
      address: addressMatch[1],
      amount_sats: amount,
      op_return_hex: opReturnMatch?.[1] ?? null,
      pay_url: payUrl,
    };
  }

  return null;
}

export function buildSendPathFromInvoice(payload: InvoiceDmPayload): string {
  const params = new URLSearchParams();
  params.set('invoice', payload.invoice_event_id);
  params.set('to', payload.address);
  if (payload.amount_sats) params.set('amount', String(payload.amount_sats));
  return `/send?${params.toString()}`;
}
