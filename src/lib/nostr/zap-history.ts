/**
 * Zap history: who you zapped and who zapped you, and how.
 *
 * Both directions come from NIP-57 receipts (kind 9735) on relays: "#p" = to you, "#P" =
 * from you (the zapper's key, which zap servers copy from the request). A small log on
 * this device adds what relays can't know: that a BTC zap was paid from the XBT wallet
 * through the bridge, what it cost in XBT, and the routing fee.
 */
import { streamQuery, relaysForAuthor, DEFAULT_RELAYS, type NEvent } from './query';
import { parseZapReceipt, type ZapReceiptInfo } from './zap';
import { decodeInvoice } from './lightning-chain';

export interface SentZapLog {
  paymentHash: string;
  recipient: string;
  noteId?: string;
  amountSats: number;
  chain: 'xbt' | 'btc';
  via: 'direct' | 'bridge';
  /** XBT that left the wallet for a bridge zap */
  costXbtSats?: number;
  feeSats?: number;
  comment?: string;
  at: number;
}

export interface ZapRow extends ZapReceiptInfo {
  direction: 'sent' | 'received';
  paymentHash?: string;
  via?: 'direct' | 'bridge';
  costXbtSats?: number;
  feeSats?: number;
  /** a zap you sent that no receipt has turned up for yet */
  noReceipt?: boolean;
}

const KEY = (pk: string) => `zap_sent_log_${pk}`;

export function loadSentLog(me: string): SentZapLog[] {
  try { const v = JSON.parse(localStorage.getItem(KEY(me)) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}

export function recordSentZap(me: string, z: SentZapLog): void {
  if (!me || !z.paymentHash) return;
  const list = loadSentLog(me).filter((x) => x.paymentHash !== z.paymentHash);
  list.push(z);
  try { localStorage.setItem(KEY(me), JSON.stringify(list.slice(-500))); } catch { /* storage full or blocked */ }
}

function hashOf(e: NEvent): string | undefined {
  const b = e.tags.find((t) => t[0] === 'bolt11')?.[1];
  return b ? decodeInvoice(b)?.paymentHash : undefined;
}

/** Stream both directions; rows arrive newest first. */
export function streamZapHistory(me: string, onUpdate: (rows: ZapRow[], done: boolean) => void, extra: SentZapLog[] = []): () => void {
  const rows = new Map<string, ZapRow>();
  const local = loadSentLog(me);
  const byHash = new Map([...extra, ...local].map((l) => [l.paymentHash, l]));
  const log = local;
  let stop: (() => void) | null = null;
  let live = true;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const emit = (done: boolean) => {
    const seenHashes = new Set([...rows.values()].map((r) => r.paymentHash).filter(Boolean));
    // zaps you paid that no relay has a receipt for (yet)
    const pending: ZapRow[] = log.filter((l) => !seenHashes.has(l.paymentHash)).map((l) => ({
      id: `log-${l.paymentHash}`, sender: me, recipient: l.recipient, eventId: l.noteId ?? null, amountSats: l.amountSats,
      comment: l.comment || '', chain: l.chain, createdAt: l.at, anonymous: false, direction: 'sent',
      paymentHash: l.paymentHash, via: l.via, costXbtSats: l.costXbtSats, feeSats: l.feeSats, noReceipt: true,
    }));
    onUpdate([...rows.values(), ...pending].sort((a, b) => b.createdAt - a.createdAt), done);
  };

  relaysForAuthor(me, { inbox: true }).catch(() => DEFAULT_RELAYS).then((mine) => {
    if (!live) return;
    const relays = [...new Set([...mine, ...DEFAULT_RELAYS, 'wss://relay.ditto.pub', 'wss://relay.nostronchain.com'])].filter((r) => !/primal\.net/.test(r)).slice(0, 12);
    stop = streamQuery({
      relays,
      filters: [
        { kinds: [9735], '#p': [me], limit: 500 },
        { kinds: [9735], '#P': [me], limit: 500 },
      ],
      timeoutMs: 10000,
      onEvent: (e) => {
        const z = parseZapReceipt(e);
        if (!z) return;
        const direction = z.recipient === me ? 'received' : z.sender === me || e.tags.some((t) => t[0] === 'P' && t[1] === me) ? 'sent' : null;
        if (!direction) return;
        const h = hashOf(e);
        const l = h ? byHash.get(h) : undefined;
        rows.set(e.id, {
          ...z, direction, paymentHash: h,
          sender: direction === 'sent' ? me : z.sender,
          via: l?.via,   // known only from this device's log
          costXbtSats: l?.costXbtSats, feeSats: l?.feeSats,
        });
        if (!timer) timer = setTimeout(() => { timer = null; emit(false); }, 250);
      },
      onDone: () => { if (timer) clearTimeout(timer); emit(true); },
    });
  });
  return () => { live = false; stop?.(); };
}

/**
 * BTC zaps the user's XBT wallet paid through the bridge, from wallets that offer the
 * non-standard list_bridge_pays (our NWC service). Works for zaps sent from any device.
 */
export async function bridgePaysFromWallet(): Promise<SentZapLog[]> {
  const { loadNwcConnection, nwcRequest } = await import('./nwc');
  const c = await loadNwcConnection('xbt').catch(() => null);
  if (!c) return [];
  const r = await nwcRequest<{ pays: { payment_hash: string; btc_sats: number; cost_xbt_sats: number; fee_sats?: number; at: number }[] }>(c, 'list_bridge_pays', {}, 15000).catch(() => ({ error: 'x' } as { error: string }));
  if ('error' in r && r.error) return [];
  const pays = ('result' in r && r.result?.pays) || [];
  return pays.map((p) => ({ paymentHash: p.payment_hash, recipient: '', amountSats: p.btc_sats, chain: 'btc' as const, via: 'bridge' as const, costXbtSats: p.cost_xbt_sats, feeSats: p.fee_sats, at: p.at }));
}

