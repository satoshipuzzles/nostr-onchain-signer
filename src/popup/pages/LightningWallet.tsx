import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import {
  Zap, ScanLine, Send, ArrowDownLeft, ArrowUpRight, RefreshCw, Loader2,
  Copy, Check, ClipboardPaste, X, AlertCircle, Unplug,
} from 'lucide-react';
import {
  loadNwcConnection, saveNwcConnection, parseNwcUri, getNwcInfo, getNwcBalance,
  makeNwcInvoice, lookupNwcInvoice, listNwcTransactions, sendNwcPayment, nwcRelays,
  type NwcConnection, type NwcInfo, type NwcTransaction, type LightningChain,
} from '@/lib/nostr/nwc';
import { decodeInvoice, type DecodedInvoice } from '@/lib/nostr/lightning-chain';
import { classifyScan, type ScanTarget } from '@/lib/lightning/scan';
import { resolveProfiles } from '@/lib/nostr/cache';
import { subscribeEvents, type FeedNote } from '@/lib/nostr/feed';
import { loadRelayList, getReadRelays } from '@/lib/nostr/relays';
import { type ProfileMetadata } from '@/lib/nostr/social';
import { NwcWalletCard } from '../components/NwcWalletCard';
import { ChannelsCard } from '../components/ChannelsCard';
import { LightningAddressCard } from '../components/LightningAddressCard';
import { QrScanner } from '../components/QrScanner';
import { QRCode } from '../components/QRCode';
import { ZapDialog } from '../components/ZapDialog';

const CHAINS: LightningChain[] = ['xbt', 'btc'];
const label = (c: LightningChain) => `${c.toUpperCase()} Lightning`;
const fmtSats = (msats: number) => Math.floor(msats / 1000).toLocaleString();

/** lnd's payment failure codes, in words. Nothing is spent in any of these cases. */
const LND_FAILURES: Record<string, string> = {
  FAILURE_REASON_INCORRECT_PAYMENT_DETAILS:
    "The receiver's node rejected this payment: it doesn't recognise the invoice (already paid, cancelled, or never registered). Ask them for a new invoice. Nothing was sent.",
  FAILURE_REASON_NO_ROUTE: 'No route to the receiver with enough capacity. Nothing was sent.',
  FAILURE_REASON_TIMEOUT: 'The payment timed out looking for a route. Nothing was sent.',
  FAILURE_REASON_INSUFFICIENT_BALANCE: 'Not enough outbound balance in your channels. Nothing was sent.',
  FAILURE_REASON_ERROR: 'The payment failed along the route. Nothing was sent.',
};
const explainPayError = (e: string) => {
  const code = Object.keys(LND_FAILURES).find((k) => e.includes(k));
  return code ? LND_FAILURES[code] : e;
};

interface WalletState {
  conn: NwcConnection | null;
  info?: NwcInfo;
  balanceMsats?: number;
  error?: string;
  loading: boolean;
}

interface PayRequest {
  callback: string;
  minSendable: number;
  maxSendable: number;
  commentAllowed?: number;
  description: string;
  target: string;
}

/** Everything the Pay sheet can be showing. */
type PayStep =
  | { kind: 'invoice'; invoice: string; decoded: DecodedInvoice }
  | { kind: 'lnurl'; req: PayRequest }
  | { kind: 'busy'; message: string }
  | { kind: 'done'; message: string }
  | { kind: 'error'; message: string };

async function fetchPayRequest(url: string, target: string): Promise<PayRequest> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${target} answered HTTP ${res.status}`);
  const d = await res.json();
  if (d.status === 'ERROR') throw new Error(d.reason || `${target} returned an error`);
  if (d.tag === 'withdrawRequest') throw new Error('That is an LNURL-withdraw code (it pays you). Withdrawing is not supported yet.');
  if (d.tag !== 'payRequest' || typeof d.callback !== 'string') throw new Error('That code is not a Lightning payment request');
  let description = '';
  try {
    const meta: string[][] = JSON.parse(d.metadata || '[]');
    description = meta.find((m) => m[0] === 'text/plain')?.[1] ?? '';
  } catch { /* metadata is optional for display */ }
  return {
    callback: d.callback,
    minSendable: Number(d.minSendable) || 1000,
    maxSendable: Number(d.maxSendable) || 1000,
    commentAllowed: Number(d.commentAllowed) || 0,
    description,
    target,
  };
}

export function LightningWallet() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [chain, setChain] = useState<LightningChain>('xbt');
  const [wallets, setWallets] = useState<Record<LightningChain, WalletState>>({
    xbt: { conn: null, loading: true },
    btc: { conn: null, loading: true },
  });
  const [txs, setTxs] = useState<NwcTransaction[] | null>(null);
  const [txError, setTxError] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  const [scanning, setScanning] = useState(false);
  const [sheet, setSheet] = useState<'pay' | 'receive' | null>(null);
  const [zapTarget, setZapTarget] = useState<{ pubkey: string; profile: ProfileMetadata | null; note?: FeedNote } | null>(null);
  const [nwcOffer, setNwcOffer] = useState<string | null>(null);

  // Pay sheet
  const [payInput, setPayInput] = useState('');
  const [step, setStep] = useState<PayStep | null>(null);
  const [amountSats, setAmountSats] = useState('');
  const [comment, setComment] = useState('');

  // Receive sheet
  const [recvSats, setRecvSats] = useState('');
  const [recvMemo, setRecvMemo] = useState('');
  const [recvInvoice, setRecvInvoice] = useState<NwcTransaction | null>(null);
  const [recvBusy, setRecvBusy] = useState(false);
  const [recvPaid, setRecvPaid] = useState(false);
  const [copied, setCopied] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const active = wallets[chain];
  // What this connection may do. Unknown (wallet not answering) counts as allowed.
  const can = (m: string) => !active.info?.methods || active.info.methods.includes(m);

  const refreshWallet = useCallback(async (c: LightningChain) => {
    const conn = await loadNwcConnection(c);
    if (!conn) {
      setWallets((w) => ({ ...w, [c]: { conn: null, loading: false } }));
      return;
    }
    setWallets((w) => ({ ...w, [c]: { ...w[c], conn, loading: true, error: undefined } }));
    const [info, bal] = await Promise.all([getNwcInfo(conn), getNwcBalance(conn)]);
    setWallets((w) => ({
      ...w,
      [c]: {
        conn,
        info: info.result,
        balanceMsats: bal.msats,
        error: bal.error && info.error ? bal.error : undefined,
        loading: false,
      },
    }));
  }, []);

  const refreshTxs = useCallback(async (c: LightningChain) => {
    const conn = await loadNwcConnection(c);
    if (!conn) { setTxs(null); return; }
    setTxs(null);
    setTxError('');
    const r = await listNwcTransactions(conn, 15);
    if (r.error) setTxError(r.error);
    setTxs(r.transactions ?? []);
  }, []);

  useEffect(() => {
    // /lightning?chain=btc (from the Wallets tab) opens that wallet; otherwise XBT first
    const asked = params.get('chain');
    if (asked === 'xbt' || asked === 'btc') setChain(asked);
    else Promise.all([loadNwcConnection('xbt'), loadNwcConnection('btc')]).then(([x, b]) => {
      // XBT first, like everywhere else in the suite
      setChain(x || !b ? 'xbt' : 'btc');
    });
    CHAINS.forEach((c) => refreshWallet(c));
  }, [refreshWallet]);

  useEffect(() => {
    if (active.loading) return;
    if (active.info?.methods && !active.info.methods.includes('list_transactions')) { setTxs([]); return; }
    refreshTxs(chain);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chain, active.loading, refreshTxs]);

  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  // /lightning?pay=<anything> opens the Pay sheet already filled in
  useEffect(() => {
    const pay = params.get('pay');
    if (pay) {
      setParams({}, { replace: true });
      openPay(pay);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function resetPay() {
    setStep(null);
    setPayInput('');
    setAmountSats('');
    setComment('');
  }

  function openPay(text?: string) {
    resetPay();
    setSheet('pay');
    if (text) {
      setPayInput(text);
      handleInput(text);
    }
  }

  async function handleInput(raw: string) {
    const t: ScanTarget | null = classifyScan(raw);
    if (!t) {
      setSheet('pay');
      setStep({ kind: 'error', message: 'Not something this wallet can pay: expected an invoice, a Lightning address, an LNURL, an npub or a note.' });
      return;
    }
    switch (t.type) {
      case 'invoice': {
        const decoded = decodeInvoice(t.invoice);
        if (!decoded) { setStep({ kind: 'error', message: 'That invoice could not be read.' }); return; }
        // The invoice says which network minted it; pay from the matching wallet
        if (wallets[decoded.chain].conn) setChain(decoded.chain);
        setSheet('pay');
        setStep({ kind: 'invoice', invoice: t.invoice, decoded });
        return;
      }
      case 'address':
      case 'lnurl': {
        setSheet('pay');
        setStep({ kind: 'busy', message: 'Looking up payment details…' });
        try {
          const req = t.type === 'address'
            ? await fetchPayRequest(`https://${t.address.split('@')[1]}/.well-known/lnurlp/${encodeURIComponent(t.address.split('@')[0])}`, t.address)
            : await fetchPayRequest(t.url, new URL(t.url).hostname);
          if (req.minSendable === req.maxSendable) setAmountSats(String(Math.ceil(req.minSendable / 1000)));
          setStep({ kind: 'lnurl', req });
        } catch (e) {
          setStep({ kind: 'error', message: e instanceof Error ? e.message : 'Lookup failed' });
        }
        return;
      }
      case 'profile':
      case 'note': {
        setSheet(null);
        const toastId = toast.loading('Finding them on Nostr…');
        const list = await loadRelayList();
        const relays = [...new Set([...t.relays, ...getReadRelays(list)])].filter((r) => !r.includes('primal.net')).slice(0, 6);
        let pubkey = t.type === 'profile' ? t.pubkey : t.author;
        let note: FeedNote | undefined;
        if (t.type === 'note') {
          note = await new Promise<FeedNote | undefined>((resolve) => {
            let found: FeedNote | undefined;
            const unsub = subscribeEvents(relays, { ids: [t.id] }, (e) => {
              found = { id: e.id, pubkey: e.pubkey, content: e.content, created_at: e.created_at, tags: e.tags, kind: e.kind };
              unsub(); resolve(found);
            }, () => { unsub(); resolve(found); });
            setTimeout(() => { unsub(); resolve(found); }, 8000);
          });
          pubkey = note?.pubkey ?? pubkey;
        }
        if (!pubkey) {
          toast.error('Could not find that note on your relays', { id: toastId });
          return;
        }
        const profiles = await resolveProfiles([pubkey], relays).catch(() => new Map());
        toast.dismiss(toastId);
        setZapTarget({ pubkey, profile: profiles.get(pubkey) ?? null, note });
        return;
      }
      case 'nwc':
        setSheet(null);
        setNwcOffer(t.uri);
        return;
      case 'onchain': {
        const q = new URLSearchParams({ to: t.address });
        if (t.amountSats) q.set('amount', t.amountSats);
        navigate(`/send?${q}`);
        return;
      }
    }
  }

  function handleScan(text: string) {
    setScanning(false);
    setPayInput(text);
    handleInput(text);
  }

  async function pasteFromClipboard() {
    try {
      const text = (await navigator.clipboard.readText()).trim();
      if (!text) return;
      setPayInput(text);
      handleInput(text);
    } catch {
      toast.error('Clipboard is not available; paste into the box instead');
    }
  }

  async function payInvoice(invoice: string, decoded: DecodedInvoice) {
    const payChain = decoded.chain;
    const conn = wallets[payChain].conn;
    if (!conn) {
      setStep({ kind: 'error', message: `This is a ${label(payChain)} invoice and no ${label(payChain)} wallet is connected. Nothing was sent.` });
      return;
    }
    if (decoded.expiresAt * 1000 < Date.now()) {
      setStep({ kind: 'error', message: 'That invoice has expired. Ask for a new one.' });
      return;
    }
    let amountMsats: number | undefined;
    if (decoded.amountMsats === null) {
      const sats = Math.floor(Number(amountSats));
      if (!sats || sats <= 0) { toast.error('Enter an amount'); return; }
      amountMsats = sats * 1000;
    }
    setStep({ kind: 'busy', message: `Paying on ${label(payChain)}…` });
    const r = await sendNwcPayment(conn, invoice, amountMsats);
    if (r.error) {
      setStep({ kind: 'error', message: explainPayError(r.error) });
      return;
    }
    const sats = fmtSats(decoded.amountMsats ?? amountMsats ?? 0);
    setStep({ kind: 'done', message: `Paid ${sats} sats on ${label(payChain)}` });
    refreshWallet(payChain);
    if (payChain === chain) refreshTxs(chain);
  }

  async function payLnurl(req: PayRequest) {
    const sats = Math.floor(Number(amountSats));
    const msats = sats * 1000;
    if (!sats || msats < req.minSendable || msats > req.maxSendable) {
      toast.error(`Amount must be between ${Math.ceil(req.minSendable / 1000).toLocaleString()} and ${Math.floor(req.maxSendable / 1000).toLocaleString()} sats`);
      return;
    }
    setStep({ kind: 'busy', message: 'Requesting invoice…' });
    try {
      const url = new URL(req.callback);
      url.searchParams.set('amount', String(msats));
      if (comment && req.commentAllowed) url.searchParams.set('comment', comment.slice(0, req.commentAllowed));
      const res = await fetch(url.toString());
      const d = await res.json();
      if (d.status === 'ERROR' || typeof d.pr !== 'string') throw new Error(d.reason || 'No invoice returned');
      const decoded = decodeInvoice(d.pr);
      if (!decoded) throw new Error('The invoice returned could not be read');
      // LUD-06: the invoice must be for exactly what we asked
      if (decoded.amountMsats !== null && decoded.amountMsats !== msats) {
        throw new Error(`${req.target} returned an invoice for ${fmtSats(decoded.amountMsats)} sats instead of ${sats.toLocaleString()}. Nothing was sent.`);
      }
      await payInvoice(d.pr, decoded);
    } catch (e) {
      setStep({ kind: 'error', message: e instanceof Error ? e.message : 'Payment failed' });
    }
  }

  async function createInvoice() {
    const sats = Math.floor(Number(recvSats));
    if (!sats || sats <= 0) { toast.error('Enter an amount'); return; }
    if (!active.conn) return;
    setRecvBusy(true);
    setRecvPaid(false);
    const r = await makeNwcInvoice(active.conn, sats * 1000, recvMemo.trim());
    setRecvBusy(false);
    if (r.error || !r.result?.invoice) {
      toast.error(r.error || 'The wallet did not return an invoice');
      return;
    }
    setRecvInvoice(r.result);
    const conn = active.conn;
    const hash = r.result.payment_hash;
    const recvChain = chain;
    if (pollRef.current) clearInterval(pollRef.current);
    if (hash) {
      pollRef.current = setInterval(async () => {
        const l = await lookupNwcInvoice(conn, hash);
        if (l.result?.settled_at) {
          if (pollRef.current) clearInterval(pollRef.current);
          setRecvPaid(true);
          toast.success(`Received ${sats.toLocaleString()} sats`);
          refreshWallet(recvChain);
          refreshTxs(recvChain);
        }
      }, 3000);
    }
  }

  function closeReceive() {
    if (pollRef.current) clearInterval(pollRef.current);
    setSheet(null);
    setRecvInvoice(null);
    setRecvSats('');
    setRecvMemo('');
    setRecvPaid(false);
  }

  async function copyInvoice(text: string) {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  async function acceptNwc(c: LightningChain) {
    const parsed = nwcOffer ? parseNwcUri(nwcOffer) : null;
    setNwcOffer(null);
    if (!parsed) { toast.error('That wallet connection could not be read'); return; }
    await saveNwcConnection(parsed, c);
    toast.success(`${label(c)} wallet connected`);
    setChain(c);
    refreshWallet(c);
    refreshTxs(c);
  }

  async function disconnect() {
    await saveNwcConnection(null, chain);
    refreshWallet(chain);
    setTxs(null);
  }

  return (
    <div className="p-4 pb-24 max-w-lg mx-auto space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold flex items-center gap-2"><Zap className="w-5 h-5" /> Lightning</h1>
        <button
          onClick={() => { refreshWallet(chain); refreshTxs(chain); setRefreshKey((k) => k + 1); }}
          className="p-2 rounded-lg text-gray-400 hover:text-white hover:bg-white/5"
          aria-label="Refresh"
        >
          <RefreshCw className={`w-4 h-4 ${active.loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      <div className="flex rounded-lg bg-surface-700 p-0.5 text-xs font-medium">
        {CHAINS.map((c) => (
          <button
            key={c}
            onClick={() => setChain(c)}
            className={`flex-1 py-2 rounded-md transition-colors ${chain === c ? 'bg-bitcoin text-black' : 'text-gray-400 hover:text-white'}`}
          >
            {label(c)}
          </button>
        ))}
      </div>

      {!active.conn && !active.loading ? (
        <NwcWalletCard chain={chain} onChange={() => { refreshWallet(chain); refreshTxs(chain); }} />
      ) : (
        <div className="card">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-xs text-gray-500">{label(chain)} balance</p>
              <p className="text-3xl font-bold mt-1 tabular-nums">
                {active.balanceMsats !== undefined ? fmtSats(active.balanceMsats) : active.loading ? '…' : '—'}
                <span className="text-sm text-gray-500 font-normal ml-1.5">sats</span>
              </p>
            </div>
            <button
              onClick={disconnect}
              className="text-[11px] text-gray-500 hover:text-red-400 flex items-center gap-1 mt-1"
              title="Remove this wallet connection from this device"
            >
              <Unplug className="w-3.5 h-3.5" /> Disconnect
            </button>
          </div>
          <div className="mt-3 pt-3 border-t border-white/5 space-y-1 text-[11px] text-gray-500">
            <p className="truncate">
              Node: <span className="text-gray-300">{active.info?.alias || (active.loading ? 'connecting…' : 'unknown')}</span>
              {active.info?.pubkey && <span className="font-mono ml-1.5">{active.info.pubkey.slice(0, 10)}…</span>}
            </p>
            <p className="truncate">
              Via Nostr Wallet Connect on <span className="font-mono">{active.conn && nwcRelays(active.conn).map((r) => r.replace(/^wss:\/\//, '')).join(', ')}</span>
            </p>
            {active.info?.methods && (
              <p className="truncate">Allowed: {active.info.methods.join(', ')}</p>
            )}
            {active.error && <p className="text-amber-400">Wallet not answering: {active.error}</p>}
          </div>
        </div>
      )}

      <div className="grid grid-cols-3 gap-2">
        <button
          onClick={() => setScanning(true)}
          className="py-3 rounded-xl bg-bitcoin text-black text-sm font-semibold flex flex-col items-center gap-1"
        >
          <ScanLine className="w-5 h-5" /> Scan
        </button>
        <button
          onClick={() => openPay()}
          className="py-3 rounded-xl bg-white/10 text-white text-sm font-medium flex flex-col items-center gap-1"
        >
          <Send className="w-5 h-5" /> Pay
        </button>
        <button
          onClick={() => setSheet('receive')}
          disabled={!active.conn || !can('make_invoice')}
          title={can('make_invoice') ? undefined : 'This wallet connection is not allowed to create invoices'}
          className="py-3 rounded-xl bg-white/10 text-white text-sm font-medium flex flex-col items-center gap-1 disabled:opacity-40"
        >
          <ArrowDownLeft className="w-5 h-5" /> Receive
        </button>
      </div>

      {active.conn && <LightningAddressCard chain={chain} nodePubkey={active.info?.pubkey} />}

      {active.conn && (
        <div className="card">
          <p className="text-sm font-medium mb-2">Recent activity</p>
          {txs === null ? (
            <div className="py-4 flex justify-center"><Loader2 className="w-4 h-4 animate-spin text-gray-500" /></div>
          ) : !can('list_transactions') ? (
            <p className="text-xs text-gray-500 py-2">This connection isn't allowed to read history. Make a new connection on your node with history and receiving turned on.</p>
          ) : txError ? (
            <p className="text-xs text-amber-400 py-2">{txError}</p>
          ) : txs.length === 0 ? (
            <p className="text-xs text-gray-500 py-2">Nothing yet.</p>
          ) : (
            <ul className="divide-y divide-white/5">
              {txs.map((t, i) => {
                const settled = !!t.settled_at || t.type === 'outgoing';
                const when = t.settled_at || t.created_at;
                return (
                  <li key={(t.payment_hash ?? '') + i} className="py-2 flex items-center gap-3">
                    {t.type === 'incoming'
                      ? <ArrowDownLeft className={`w-4 h-4 flex-shrink-0 ${settled ? 'text-green-400' : 'text-gray-600'}`} />
                      : <ArrowUpRight className="w-4 h-4 flex-shrink-0 text-gray-300" />}
                    <div className="flex-1 min-w-0">
                      <p className="text-xs truncate">{t.description || (t.type === 'incoming' ? 'Received' : 'Sent')}</p>
                      <p className="text-[10px] text-gray-500">
                        {when ? new Date(when * 1000).toLocaleString() : ''}{!settled && ' · unpaid'}
                      </p>
                    </div>
                    <p className={`text-xs tabular-nums ${!settled ? 'text-gray-600' : t.type === 'incoming' ? 'text-green-400' : ''}`}>
                      {t.type === 'incoming' ? '+' : '−'}{fmtSats(t.amount)}
                    </p>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      {active.conn && active.info?.methods?.includes('list_channels') && (
        <ChannelsCard conn={active.conn} refreshKey={refreshKey} />
      )}

      <p className="text-[11px] text-gray-600 px-1">
        Scan or paste a Lightning invoice, a Lightning address, an LNURL code, an npub or a note link.
        Invoices are paid from the wallet on the network that made them; npubs and notes open a zap.
      </p>

      {/* Pay sheet */}
      {sheet === 'pay' && (
        <Sheet title="Pay" onClose={() => { setSheet(null); resetPay(); }}>
          {(!step || step.kind === 'error') && (
            <>
              <textarea
                value={payInput}
                onChange={(e) => setPayInput(e.target.value)}
                rows={3}
                placeholder="lnbc… invoice, name@domain, lnurl…, npub…"
                className="w-full bg-surface-700/50 rounded-lg px-3 py-2 text-xs text-white placeholder-gray-600 outline-none border border-surface-200/10 focus:border-bitcoin/30 font-mono break-all"
              />
              {step?.kind === 'error' && (
                <p className="text-xs text-red-400 mt-2 flex gap-1.5"><AlertCircle className="w-3.5 h-3.5 flex-shrink-0 mt-px" />{step.message}</p>
              )}
              <div className="grid grid-cols-3 gap-2 mt-3">
                <button onClick={() => setScanning(true)} className="py-2.5 rounded-lg bg-white/10 text-xs flex items-center justify-center gap-1.5">
                  <ScanLine className="w-4 h-4" /> Scan
                </button>
                <button onClick={pasteFromClipboard} className="py-2.5 rounded-lg bg-white/10 text-xs flex items-center justify-center gap-1.5">
                  <ClipboardPaste className="w-4 h-4" /> Paste
                </button>
                <button
                  onClick={() => handleInput(payInput)}
                  disabled={!payInput.trim()}
                  className="py-2.5 rounded-lg bg-bitcoin text-black text-xs font-semibold disabled:opacity-40"
                >
                  Next
                </button>
              </div>
            </>
          )}

          {step?.kind === 'busy' && (
            <div className="flex flex-col items-center py-8">
              <Loader2 className="w-7 h-7 animate-spin text-bitcoin mb-3" />
              <p className="text-sm text-gray-300">{step.message}</p>
            </div>
          )}

          {step?.kind === 'done' && (
            <div className="flex flex-col items-center py-8">
              <div className="w-10 h-10 rounded-full bg-green-500/20 flex items-center justify-center mb-3">
                <Check className="w-5 h-5 text-green-400" />
              </div>
              <p className="text-sm text-green-400 font-medium">{step.message}</p>
              <button onClick={() => { setSheet(null); resetPay(); }} className="mt-4 text-xs text-gray-400 hover:text-white">Done</button>
            </div>
          )}

          {step?.kind === 'invoice' && (() => {
            const d = step.decoded;
            const hasWallet = !!wallets[d.chain].conn;
            const expired = d.expiresAt * 1000 < Date.now();
            return (
              <>
                <div className="text-center py-2">
                  <p className="text-3xl font-bold tabular-nums">
                    {d.amountMsats !== null ? fmtSats(d.amountMsats) : '—'}
                    <span className="text-sm text-gray-500 font-normal ml-1.5">sats</span>
                  </p>
                  {d.description && <p className="text-xs text-gray-400 mt-2 break-words">{d.description}</p>}
                </div>
                <div className="text-[11px] text-gray-500 space-y-1 my-3">
                  <p>Network: <span className={hasWallet ? 'text-green-400' : 'text-amber-400'}>{label(d.chain)}</span>
                    {hasWallet ? ' · pays from your wallet on this network' : ' · no wallet connected for it'}</p>
                  <p>{expired ? <span className="text-red-400">Expired</span> : <>Expires {new Date(d.expiresAt * 1000).toLocaleString()}</>}</p>
                </div>
                {d.amountMsats === null && (
                  <input
                    type="number" inputMode="numeric" min={1}
                    value={amountSats}
                    onChange={(e) => setAmountSats(e.target.value)}
                    placeholder="Amount in sats (this invoice leaves it to you)"
                    className="w-full bg-surface-700/50 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 outline-none border border-surface-200/10 focus:border-bitcoin/30 mb-3"
                  />
                )}
                {!hasWallet && (
                  <p className="text-[11px] text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2 mb-3">
                    {d.chain === 'btc'
                      ? 'This invoice is on BTC Lightning. Your XBT wallet cannot pay it.'
                      : 'This invoice is on XBT Lightning. Connect your XBT wallet to pay it.'}
                  </p>
                )}
                <button
                  onClick={() => payInvoice(step.invoice, d)}
                  disabled={!hasWallet || expired}
                  className="w-full py-3 bg-bitcoin text-black rounded-lg text-sm font-semibold flex items-center justify-center gap-2 disabled:opacity-40"
                >
                  <Zap className="w-4 h-4" /> Pay {d.amountMsats !== null ? `${fmtSats(d.amountMsats)} sats` : ''}
                </button>
              </>
            );
          })()}

          {step?.kind === 'lnurl' && (
            <>
              <p className="text-sm font-medium truncate">{step.req.target}</p>
              {step.req.description && <p className="text-xs text-gray-400 mt-1 break-words">{step.req.description}</p>}
              <p className="text-[11px] text-gray-500 mt-2 mb-3">
                {Math.ceil(step.req.minSendable / 1000).toLocaleString()} – {Math.floor(step.req.maxSendable / 1000).toLocaleString()} sats
              </p>
              <input
                type="number" inputMode="numeric" min={1}
                value={amountSats}
                onChange={(e) => setAmountSats(e.target.value)}
                placeholder="Amount in sats"
                className="w-full bg-surface-700/50 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 outline-none border border-surface-200/10 focus:border-bitcoin/30 mb-2"
              />
              {!!step.req.commentAllowed && (
                <input
                  type="text"
                  value={comment}
                  maxLength={step.req.commentAllowed}
                  onChange={(e) => setComment(e.target.value)}
                  placeholder="Comment (optional)"
                  className="w-full bg-surface-700/50 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 outline-none border border-surface-200/10 focus:border-bitcoin/30 mb-2"
                />
              )}
              <p className="text-[11px] text-gray-600 mb-3">Paid from whichever of your wallets matches the network of the invoice they send back.</p>
              <button
                onClick={() => payLnurl(step.req)}
                disabled={!amountSats}
                className="w-full py-3 bg-bitcoin text-black rounded-lg text-sm font-semibold flex items-center justify-center gap-2 disabled:opacity-40"
              >
                <Zap className="w-4 h-4" /> Pay {amountSats ? `${Number(amountSats).toLocaleString()} sats` : ''}
              </button>
            </>
          )}
        </Sheet>
      )}

      {/* Receive sheet */}
      {sheet === 'receive' && (
        <Sheet title={`Receive on ${label(chain)}`} onClose={closeReceive}>
          {!recvInvoice ? (
            <>
              <input
                type="number" inputMode="numeric" min={1}
                value={recvSats}
                onChange={(e) => setRecvSats(e.target.value)}
                placeholder="Amount in sats"
                className="w-full bg-surface-700/50 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 outline-none border border-surface-200/10 focus:border-bitcoin/30 mb-2"
              />
              <input
                type="text"
                value={recvMemo}
                onChange={(e) => setRecvMemo(e.target.value)}
                placeholder="Description (optional)"
                className="w-full bg-surface-700/50 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 outline-none border border-surface-200/10 focus:border-bitcoin/30 mb-3"
              />
              <button
                onClick={createInvoice}
                disabled={!recvSats || recvBusy}
                className="w-full py-3 bg-bitcoin text-black rounded-lg text-sm font-semibold flex items-center justify-center gap-2 disabled:opacity-40"
              >
                {recvBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <ArrowDownLeft className="w-4 h-4" />} Create invoice
              </button>
            </>
          ) : recvPaid ? (
            <div className="flex flex-col items-center py-8">
              <div className="w-10 h-10 rounded-full bg-green-500/20 flex items-center justify-center mb-3">
                <Check className="w-5 h-5 text-green-400" />
              </div>
              <p className="text-sm text-green-400 font-medium">Received {fmtSats(recvInvoice.amount)} sats</p>
              <button onClick={closeReceive} className="mt-4 text-xs text-gray-400 hover:text-white">Done</button>
            </div>
          ) : (
            <div className="flex flex-col items-center">
              <QRCode data={`lightning:${recvInvoice.invoice}`} size={220} />
              <p className="text-sm font-semibold mt-3">{fmtSats(recvInvoice.amount)} sats</p>
              <p className="text-[11px] text-gray-500 flex items-center gap-1.5 mt-1">
                <Loader2 className="w-3 h-3 animate-spin" /> Waiting for payment · {label(chain)} only
              </p>
              <button
                onClick={() => copyInvoice(recvInvoice.invoice!)}
                className="mt-3 w-full py-2.5 rounded-lg bg-white/10 text-xs flex items-center justify-center gap-1.5"
              >
                {copied ? <Check className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4" />}
                {copied ? 'Copied' : 'Copy invoice'}
              </button>
            </div>
          )}
        </Sheet>
      )}

      {nwcOffer && (
        <Sheet title="Connect this wallet?" onClose={() => setNwcOffer(null)}>
          <p className="text-xs text-gray-400 mb-3">
            That code is a Nostr Wallet Connect link. It lets this app spend from the wallet within the limits set on it.
            Which network is that wallet on?
          </p>
          <div className="grid grid-cols-2 gap-2">
            {CHAINS.map((c) => (
              <button key={c} onClick={() => acceptNwc(c)} className="py-2.5 rounded-lg bg-white/10 text-xs font-medium">
                {label(c)}
              </button>
            ))}
          </div>
        </Sheet>
      )}

      {scanning && (
        <QrScanner
          title="Scan to pay"
          hint="Point the camera at a Lightning invoice, Lightning address, LNURL, npub or note."
          onResult={handleScan}
          onClose={() => setScanning(false)}
        />
      )}

      {zapTarget && (
        <ZapDialog
          recipientPubkey={zapTarget.pubkey}
          profile={zapTarget.profile}
          note={zapTarget.note}
          onClose={() => setZapTarget(null)}
        />
      )}
    </div>
  );
}

/** Bottom sheet on phones, centred dialog on wider screens. */
function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    // Above the bottom tab bar (z-50), or it covers the action button on phones
    <div className="fixed inset-0 bg-black/60 z-[60] flex items-end sm:items-center justify-center" onClick={onClose}>
      <div
        className="bg-surface-800 border border-surface-200/10 w-full sm:max-w-sm rounded-t-2xl sm:rounded-2xl p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold">{title}</h3>
          <button onClick={onClose} className="text-gray-500 hover:text-white" aria-label="Close"><X className="w-4 h-4" /></button>
        </div>
        {children}
      </div>
    </div>
  );
}
