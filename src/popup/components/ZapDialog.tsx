import { useState, useEffect, useContext, useRef } from 'react';
import { X, Zap, Loader2, Check, AlertCircle, Copy, ExternalLink, Bitcoin, Wallet } from 'lucide-react';
import { generateSecretKey, finalizeEvent } from 'nostr-tools/pure';
import { AuthContext } from '@/popup/context/AuthContext';
import { signEventWithFallback } from '@/lib/nostr/sign-event';
import { loadRelayList, getReadRelays, getWriteRelays } from '@/lib/nostr/relays';
import { loadNwcConnection, sendNwcPayment, getNwcInfo, estimateNwcFee, type LightningChain } from '@/lib/nostr/nwc';
import {
  fetchLnurlPayInfo,
  requestZapInvoice,
  createZapRequestEvent,
  encodeLnurl,
  lud16ToUrl,
} from '@/lib/nostr/zap';
import { type FeedNote } from '@/lib/nostr/feed';
import { detectAddressChain, invoiceChain, decodeInvoice, type LnChain } from '@/lib/nostr/lightning-chain';
import { type ProfileMetadata } from '@/lib/nostr/social';
import { relaysForAuthor, streamQuery, cleanRelays, DEFAULT_RELAYS } from '@/lib/nostr/query';
import { pubkeyToTaprootAddress } from '@/lib/bitcoin/address';
import { explorerAddressUrl, type Chain } from '@/lib/bitcoin/chain';
import { useNavigate } from 'react-router-dom';
import { QRCode } from './QRCode';

interface Props {
  note?: FeedNote;
  recipientPubkey: string;
  profile?: ProfileMetadata | null;
  onClose: () => void;
}

const ZAP_AMOUNTS = [21, 100, 420, 1000, 5000, 10000];
const ONCHAIN_AMOUNTS = [1000, 5000, 10000, 21000, 50000, 100000];

type Rail = 'xbt' | 'btc' | 'onchain';
type ZapStatus = 'idle' | 'fetching' | 'review' | 'paying' | 'invoice' | 'success' | 'error';

/** A zap that is ready to pay, waiting for the user to see the fee and confirm. */
interface PendingZap {
  invoice: string;
  nwc: NonNullable<Awaited<ReturnType<typeof loadNwcConnection>>>;
  /** null = the wallet can't quote; then capMsats (if known) is the most it may cost */
  feeMsats: number | null;
  capMsats?: number;
  feeError?: string;
  /** paying a BTC invoice from the XBT wallet through the bridge */
  bridge?: { costMsats: number; maxCostMsats: number; spread?: number };
}

function isOnchainAddress(a?: string): a is string {
  return !!a && /^(bc1[02-9ac-hj-np-z]{11,87}|[13][1-9A-HJ-NP-Za-km-z]{25,34})$/i.test(a.trim());
}

export function ZapDialog({ note, recipientPubkey, profile, onClose }: Props) {
  const auth = useContext(AuthContext);
  const publicKey = auth?.publicKey ?? '';
  const navigate = useNavigate();
  const [amount, setAmount] = useState(1000);
  const [onchainAmount, setOnchainAmount] = useState(10000);
  const [comment, setComment] = useState('');
  const [status, setStatus] = useState<ZapStatus>('idle');
  const [pending, setPending] = useState<PendingZap | null>(null);
  const [statusMessage, setStatusMessage] = useState('');
  const [invoice, setInvoice] = useState('');
  const [copied, setCopied] = useState('');
  // Which Lightning wallets are connected; null while loading
  const [wallets, setWallets] = useState<Record<LightningChain, boolean> | null>(null);
  const [rail, setRail] = useState<Rail>('xbt');
  // Which of the user's wallets pays. A BTC zap can come from the XBT wallet through the bridge.
  const [payFromPick, setPayFromPick] = useState<LightningChain | null>(null);
  const [onchainChain, setOnchainChain] = useState<Chain>('xbt');
  // Which network the recipient's plain lud16 is actually on (see lightning-chain.ts)
  const [lud16Chain, setLud16Chain] = useState<LnChain | 'checking' | 'unknown' | null>(null);
  const railPicked = useRef(false);
  const watchRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const addr = profile?.lud16;
    if (!addr) { setLud16Chain(null); return; }
    let live = true;
    setLud16Chain('checking');
    detectAddressChain(addr).then((c) => { if (live) setLud16Chain(c ?? 'unknown'); });
    return () => { live = false; };
  }, [profile?.lud16]);

  useEffect(() => {
    Promise.all([loadNwcConnection('xbt'), loadNwcConnection('btc')])
      .then(([x, b]) => setWallets({ xbt: !!x, btc: !!b }))
      .catch(() => setWallets({ xbt: false, btc: false }));
  }, []);

  useEffect(() => () => watchRef.current?.(), []);

  // Default rail, XBT first like everywhere else in the suite
  useEffect(() => {
    if (railPicked.current || lud16Chain === 'checking') return;
    if (profile?.lud16Xbt || (profile?.lud16 && lud16Chain === 'xbt')) setRail('xbt');
    else if (profile?.lud16) setRail('btc');
    else setRail('onchain');
  }, [profile?.lud16, profile?.lud16Xbt, lud16Chain]);

  function pickRail(r: Rail) {
    railPicked.current = true;
    setRail(r);
    setStatus('idle');
  }

  if (wallets === null) return null;

  const lnChain: LightningChain = rail === 'btc' ? 'btc' : 'xbt';
  // BTC zaps: the BTC wallet by default, else the XBT wallet via the bridge. XBT zaps need the XBT wallet
  // (the bridge here only converts XBT into BTC).
  const payFrom: LightningChain = lnChain === 'xbt' ? 'xbt' : (payFromPick ?? (wallets.btc ? 'btc' : wallets.xbt ? 'xbt' : 'btc'));
  const viaBridge = lnChain === 'btc' && payFrom === 'xbt';
  // XBT zaps go to the XBT Lightning address. Without one, the regular address
  // is used only if its invoices carry the BLAKE2b flag, i.e. it is an XBT node.
  const xbtFallback = rail === 'xbt' && !profile?.lud16Xbt;
  const lud16 = rail === 'xbt' ? (profile?.lud16Xbt || profile?.lud16) : rail === 'btc' ? profile?.lud16 : undefined;
  const wrongNetwork =
    (xbtFallback && lud16Chain === 'btc') ||
    (rail === 'btc' && !!profile?.lud16 && lud16Chain === 'xbt');
  const otherRail: Rail = rail === 'xbt' ? 'btc' : 'xbt';

  let derivedAddress = '';
  try { derivedAddress = pubkeyToTaprootAddress(recipientPubkey); } catch { /* bad key */ }
  const declaredAddress = isOnchainAddress(profile?.bitcoinAddress) ? profile!.bitcoinAddress!.trim() : '';

  async function copy(text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(label);
      setTimeout(() => setCopied(''), 1800);
    } catch { /* clipboard blocked */ }
  }

  /** Watch for the receipt the recipient's server publishes once the invoice is paid. */
  function watchForReceipt(bolt11: string, relays: string[]) {
    watchRef.current?.();
    const since = Math.floor(Date.now() / 1000) - 120;
    let stopped = false;
    let tries = 0;
    let cancel: (() => void) | null = null;
    const tick = () => {
      if (stopped || tries++ > 40) return;
      cancel = streamQuery({
        relays,
        filters: [{ kinds: [9735], '#p': [recipientPubkey], since, limit: 50 }],
        timeoutMs: 5000,
        cloud: tries % 2 === 1,
        onEvent: (e) => {
          const b = e.tags.find((t) => t[0] === 'bolt11')?.[1];
          if (b && b.toLowerCase() === bolt11.toLowerCase() && !stopped) {
            stopped = true;
            setStatus('success');
            setStatusMessage('Paid. The zap receipt is on Nostr.');
          }
        },
        onDone: () => { if (!stopped) timer = setTimeout(tick, 4000); },
      });
    };
    let timer: ReturnType<typeof setTimeout> = setTimeout(tick, 3000);
    watchRef.current = () => { stopped = true; clearTimeout(timer); cancel?.(); };
  }

  async function handleZap(payWithWallet: boolean) {
    if (!lud16) {
      setStatus('error');
      setStatusMessage(`This user has no ${lnChain.toUpperCase()} Lightning address set`);
      return;
    }

    setStatus('fetching');
    setStatusMessage('Fetching lightning address...');

    const payInfo = await fetchLnurlPayInfo(lud16);
    if (!payInfo) {
      setStatus('error');
      setStatusMessage('Could not resolve lightning address');
      return;
    }
    if (payInfo.chain && (payInfo.chain === 'xbt' || payInfo.chain === 'btc') && payInfo.chain !== lnChain) {
      setStatus('error');
      setStatusMessage(`${lud16} says it is on ${payInfo.chain.toUpperCase()} Lightning, not ${lnChain.toUpperCase()}. Nothing was sent.`);
      return;
    }

    const amountMsats = amount * 1000;
    if (amountMsats < payInfo.minSendable || amountMsats > payInfo.maxSendable) {
      setStatus('error');
      setStatusMessage(
        `Amount must be between ${Math.ceil(payInfo.minSendable / 1000)} and ${Math.floor(payInfo.maxSendable / 1000)} sats`,
      );
      return;
    }

    const lnurlHttp = lud16ToUrl(lud16);
    const lnurl = lnurlHttp ? encodeLnurl(lnurlHttp) : undefined;
    let zapRequestJson: string | undefined;
    // Receipts are published to these relays: where the recipient reads, plus ours
    let receiptRelays: string[] = DEFAULT_RELAYS;

    if (payInfo.allowsNostr && payInfo.nostrPubkey) {
      setStatusMessage('Creating zap request...');
      let mine: string[] = [];
      try {
        const relayList = await loadRelayList();
        mine = [...getReadRelays(relayList), ...getWriteRelays(relayList)];
      } catch { /* no relay settings (guest) */ }
      const theirs = await relaysForAuthor(recipientPubkey, { inbox: true }).catch(() => DEFAULT_RELAYS);
      receiptRelays = cleanRelays([...theirs.slice(0, 5), ...mine, ...DEFAULT_RELAYS], 8);

      const zapReq = createZapRequestEvent(
        recipientPubkey, note?.id, publicKey, amountMsats, receiptRelays, comment,
        { lnurl, eventKind: note?.kind },
      );
      // Rides inside the receipt, so clients can tell XBT zaps from BTC ones
      zapReq.tags.push(['chain', lnChain]);

      try {
        if (publicKey) {
          // Vault, extension or bunker: whichever signs for this account
          const signed = await signEventWithFallback(zapReq, publicKey);
          zapRequestJson = JSON.stringify(signed);
        } else {
          // Nobody signed in: an anonymous zap (NIP-57 "anon"), signed by a throwaway key
          zapReq.tags.push(['anon']);
          const { pubkey: _ignored, ...template } = zapReq;
          zapRequestJson = JSON.stringify(finalizeEvent(template, generateSecretKey()));
        }
      } catch (err) {
        setStatus('error');
        setStatusMessage(`Failed to sign zap request: ${err instanceof Error ? err.message : err}`);
        return;
      }
    }

    setStatusMessage('Requesting invoice...');
    const invoiceResult = await requestZapInvoice(
      payInfo.callback, amountMsats, zapRequestJson,
      { lnurl, comment: !zapRequestJson && (payInfo.commentAllowed ?? 0) > 0 ? comment.slice(0, payInfo.commentAllowed) : undefined },
    );
    if (invoiceResult.error || !invoiceResult.invoice) {
      setStatus('error');
      setStatusMessage(invoiceResult.error || 'Failed to get invoice');
      return;
    }

    // The recipient's server writes the invoice. It must be for exactly what
    // was asked, or a dishonest server could bill far more than the zap.
    const decoded = decodeInvoice(invoiceResult.invoice);
    if (!decoded || decoded.amountMsats !== amountMsats) {
      setStatus('error');
      setStatusMessage(
        decoded?.amountMsats
          ? `${lud16} sent an invoice for ${Math.floor(decoded.amountMsats / 1000).toLocaleString()} sats instead of ${amount.toLocaleString()}. Nothing was sent.`
          : `${lud16} sent an invoice without the right amount. Nothing was sent.`,
      );
      return;
    }

    // Last check before money moves: the invoice says which network minted it.
    const invChain = invoiceChain(invoiceResult.invoice);
    if (invChain !== lnChain) {
      setStatus('error');
      setStatusMessage(
        `${lud16} is a ${invChain.toUpperCase()} Lightning address, so it can't be paid as a ${lnChain.toUpperCase()} zap. Nothing was sent.`,
      );
      return;
    }

    const nwc = payWithWallet ? await loadNwcConnection(payFrom) : null;
    if (!nwc) {
      // No connected wallet: hand over the invoice to pay from any wallet
      setInvoice(invoiceResult.invoice);
      setStatus('invoice');
      setStatusMessage(zapRequestJson ? 'Waiting for payment…' : `${lud16} does not support Nostr zaps, so no receipt will appear.`);
      if (zapRequestJson) watchForReceipt(invoiceResult.invoice, receiptRelays);
      return;
    }

    // Before any money moves, show what it costs: the zap plus the routing fee
    setStatusMessage('Checking the network fee...');
    const info = await getNwcInfo(nwc).catch(() => ({ result: undefined } as Awaited<ReturnType<typeof getNwcInfo>>));
    const est = await estimateNwcFee(nwc, invoiceResult.invoice, info.result).catch(() => null);
    const cap = info.result?.fee_limit_sat != null ? info.result.fee_limit_sat * 1000 : undefined;
    if (viaBridge && !(est && 'bridge' in est && est.bridge)) {
      setStatus('error');
      setStatusMessage(est && 'error' in est ? est.error : 'Your XBT wallet cannot pay BTC invoices (no bridge set up on it). Nothing was sent.');
      return;
    }
    setPending({
      invoice: invoiceResult.invoice,
      nwc,
      bridge: est && 'bridge' in est && est.bridge ? est.bridge : undefined,
      feeMsats: est && 'feeMsats' in est ? est.feeMsats : null,
      capMsats: est && 'maxFeeMsats' in est && est.maxFeeMsats ? est.maxFeeMsats : cap,
      feeError: est && 'error' in est ? est.error : undefined,
    });
    setStatus('review');
  }

  async function confirmZap() {
    if (!pending) return;
    setStatus('paying');
    setStatusMessage(`Paying on ${lnChain.toUpperCase()} Lightning...`);

    // a bridge payment waits for the bridge to pay the BTC side, which can take a while over Tor
    const payResult = await sendNwcPayment(pending.nwc, pending.invoice, undefined, pending.bridge ? 200000 : 60000);
    if (payResult.error) {
      setStatus('error');
      setStatusMessage(
        xbtFallback
          ? `${payResult.error}. ${lud16} may not be on XBT Lightning; they haven't set an XBT Lightning address.`
          : payResult.error,
      );
      return;
    }

    const paidFee = payResult.feesPaidMsats != null ? Math.ceil(payResult.feesPaidMsats / 1000) : null;
    setStatus('success');
    setStatusMessage(pending.bridge
      ? `Zapped ${amount.toLocaleString()} BTC sats, paid with ${Math.ceil((payResult.costMsats ?? pending.bridge.costMsats) / 1000).toLocaleString()} XBT sats through the bridge!`
      : `Zapped ${amount.toLocaleString()} sats on ${lnChain.toUpperCase()}!${paidFee != null ? ` Network fee: ${paidFee.toLocaleString()} sat${paidFee === 1 ? '' : 's'}.` : ''}`);
    setPending(null);
    setTimeout(onClose, 2600);
  }

  const displayName =
    profile?.displayName || profile?.name || recipientPubkey.slice(0, 12);
  const hasWallet = wallets[payFrom];
  const onchainBtc = (onchainAmount / 1e8).toFixed(8).replace(/0+$/, '').replace(/\.$/, '');

  const railBtn = (r: Rail, label: string) => (
    <button
      key={r}
      onClick={() => pickRail(r)}
      className={`flex-1 py-1.5 rounded-md transition-colors ${rail === r ? (r === 'onchain' ? 'bg-white text-black' : 'bg-bitcoin text-black') : 'text-gray-400 hover:text-white'}`}
    >
      {label}
    </button>
  );

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-[80] p-4"
      onClick={onClose}
    >
      <div
        className="bg-surface-800 rounded-2xl border border-surface-200/10 p-5 w-full max-w-sm max-h-[92vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold flex items-center gap-2">
            <Zap className="w-4 h-4 text-bitcoin" /> {note ? 'Zap this note' : `Zap ${displayName}`}
          </h3>
          <button
            onClick={onClose}
            className="text-gray-500 hover:text-white transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {status === 'idle' && (
          <>
            <div className="flex rounded-lg bg-surface-700 p-0.5 text-xs font-medium mb-3">
              {railBtn('xbt', 'XBT ⚡')}
              {railBtn('btc', 'BTC ⚡')}
              {railBtn('onchain', 'Onchain')}
            </div>

            {rail !== 'onchain' && (
              <>
                <p className="text-[11px] text-gray-500 mb-3 truncate" title={lud16}>
                  {lud16 ? <>To {lud16}
                    {xbtFallback && lud16Chain === 'checking' && <span className="text-gray-400"> · checking network…</span>}
                    {xbtFallback && lud16Chain === 'xbt' && <span className="text-green-400"> · on XBT Lightning ✓</span>}
                    {xbtFallback && lud16Chain === 'unknown' && <span className="text-amber-500"> · couldn't check network</span>}
                  </> : `No ${lnChain.toUpperCase()} Lightning address in their profile. Try Onchain.`}
                </p>
                {wrongNetwork && (
                  <div className="text-[11px] text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2 mb-3">
                    {profile?.lud16} is on <b>{(lud16Chain as string).toUpperCase()} Lightning</b>, not {lnChain.toUpperCase()}.{' '}
                    <button onClick={() => pickRail(otherRail)} className="underline font-medium">Zap with {otherRail.toUpperCase()} instead</button>
                  </div>
                )}

                {lnChain === 'btc' && wallets.xbt && (
                  <div className="flex items-center gap-2 mb-3 text-[11px]">
                    <span className="text-gray-500">Pay from</span>
                    <div className="flex rounded-lg bg-surface-700 p-0.5 font-medium">
                      <button onClick={() => setPayFromPick('btc')} disabled={!wallets.btc} className={`px-2.5 py-1 rounded-md disabled:opacity-40 ${payFrom === 'btc' ? 'bg-bitcoin text-black' : 'text-gray-400'}`}>BTC wallet</button>
                      <button onClick={() => setPayFromPick('xbt')} className={`px-2.5 py-1 rounded-md ${payFrom === 'xbt' ? 'bg-purple-500 text-white' : 'text-gray-400'}`}>XBT wallet · bridge</button>
                    </div>
                  </div>
                )}

                <div className="grid grid-cols-3 gap-2 mb-4">
                  {ZAP_AMOUNTS.map((a) => (
                    <button
                      key={a}
                      onClick={() => setAmount(a)}
                      className={`py-2 rounded-lg text-sm font-medium transition-colors ${
                        amount === a
                          ? 'bg-bitcoin/20 text-bitcoin border border-bitcoin/30'
                          : 'bg-surface-700 text-gray-400 border border-surface-200/10 hover:text-white'
                      }`}
                    >
                      ⚡ {a.toLocaleString()}
                    </button>
                  ))}
                </div>

                <input
                  type="text"
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  placeholder="Add a comment (optional)"
                  className="w-full bg-surface-700/50 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 outline-none border border-surface-200/10 focus:border-bitcoin/30 mb-4"
                />

                {hasWallet && (
                  <button
                    onClick={() => handleZap(true)}
                    disabled={!lud16 || wrongNetwork || (xbtFallback && lud16Chain === 'checking')}
                    className="w-full py-2.5 bg-bitcoin text-black rounded-lg text-sm font-semibold hover:bg-bitcoin/90 transition-colors flex items-center justify-center gap-2 disabled:opacity-40 mb-2"
                  >
                    <Wallet className="w-4 h-4" />
                    {viaBridge ? `Zap ${amount.toLocaleString()} BTC sats from my XBT wallet` : `Zap ${amount.toLocaleString()} sats from my ${lnChain.toUpperCase()} wallet`}
                  </button>
                )}
                <button
                  onClick={() => handleZap(false)}
                  disabled={!lud16 || wrongNetwork || (xbtFallback && lud16Chain === 'checking')}
                  className={`w-full py-2.5 rounded-lg text-sm font-semibold transition-colors flex items-center justify-center gap-2 disabled:opacity-40 ${
                    hasWallet ? 'bg-surface-700 text-gray-200 hover:bg-surface-600' : 'bg-bitcoin text-black hover:bg-bitcoin/90'
                  }`}
                >
                  <Zap className="w-4 h-4" />
                  {hasWallet ? 'Show invoice instead' : `Get ${amount.toLocaleString()} sat invoice`}
                </button>
                {!hasWallet && auth && (
                  <button
                    onClick={() => { onClose(); navigate('/lightning'); }}
                    className="w-full mt-2 text-[11px] text-gray-500 hover:text-white"
                  >
                    Connect an {lnChain.toUpperCase()} Lightning wallet to zap in one tap
                  </button>
                )}
                {!publicKey && (
                  <p className="text-[10px] text-gray-600 mt-2 text-center">Not signed in: this will be an anonymous zap.</p>
                )}
              </>
            )}

            {rail === 'onchain' && (
              <>
                <div className="flex gap-1 mb-3">
                  {(['xbt', 'btc'] as const).map((c) => (
                    <button
                      key={c}
                      onClick={() => setOnchainChain(c)}
                      className={`flex-1 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                        onchainChain === c
                          ? c === 'xbt' ? 'bg-purple-500/20 text-purple-300 border border-purple-500/30' : 'bg-bitcoin/20 text-bitcoin border border-bitcoin/30'
                          : 'bg-surface-700 text-gray-400 border border-transparent'
                      }`}
                    >
                      {c === 'xbt' ? 'XBT (BLAKE2b)' : 'BTC (SHA-256d)'}
                    </button>
                  ))}
                </div>
                <div className="grid grid-cols-3 gap-2 mb-3">
                  {ONCHAIN_AMOUNTS.map((a) => (
                    <button
                      key={a}
                      onClick={() => setOnchainAmount(a)}
                      className={`py-1.5 rounded-lg text-xs font-medium transition-colors ${
                        onchainAmount === a
                          ? 'bg-white/15 text-white border border-white/20'
                          : 'bg-surface-700 text-gray-400 border border-surface-200/10 hover:text-white'
                      }`}
                    >
                      {a.toLocaleString()}
                    </button>
                  ))}
                </div>
                {derivedAddress ? (
                  <div className="flex flex-col items-center">
                    <QRCode data={`bitcoin:${derivedAddress}?amount=${onchainBtc}`} size={170} />
                    <p className="text-[10px] text-gray-500 mt-2 mb-1 uppercase tracking-wide flex items-center gap-1">
                      <Bitcoin className="w-3 h-3" /> Their Nostr key's taproot address
                    </p>
                    <div className="flex items-center gap-2 w-full bg-surface-900 rounded-lg px-2 py-1.5">
                      <code className="text-[10px] text-gray-300 flex-1 font-mono break-all">{derivedAddress}</code>
                      <button onClick={() => copy(derivedAddress, 'addr')} className="p-1 hover:bg-surface-700 rounded">
                        {copied === 'addr' ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5 text-gray-500" />}
                      </button>
                    </div>
                    <p className="text-[10px] text-gray-500 mt-2 leading-relaxed">
                      {onchainAmount.toLocaleString()} sats on <b className={onchainChain === 'xbt' ? 'text-purple-300' : 'text-bitcoin'}>{onchainChain.toUpperCase()}</b>.
                      {' '}The address is the same on both chains; pay from a wallet on the {onchainChain === 'xbt' ? 'XBT (Knots / BLAKE2b)' : 'BTC (SHA-256d)'} chain.
                      {' '}They spend it with their nsec.
                    </p>
                    <div className="flex gap-2 w-full mt-3">
                      {auth && (
                        <button
                          onClick={() => { onClose(); navigate(`/send?to=${derivedAddress}&amount=${onchainAmount}&chain=${onchainChain}`); }}
                          className="flex-1 py-2 rounded-lg text-xs font-semibold bg-bitcoin text-black hover:bg-bitcoin/90"
                        >
                          Send from my wallet
                        </button>
                      )}
                      <a
                        href={explorerAddressUrl(onchainChain, derivedAddress)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex-1 py-2 rounded-lg text-xs font-medium bg-surface-700 text-gray-300 hover:text-white flex items-center justify-center gap-1"
                      >
                        <ExternalLink className="w-3 h-3" /> View on explorer
                      </a>
                    </div>
                    {declaredAddress && declaredAddress !== derivedAddress && (
                      <div className="w-full mt-3 bg-surface-900 rounded-lg px-2 py-1.5">
                        <p className="text-[9px] text-gray-500 uppercase tracking-wide">Address from their profile</p>
                        <div className="flex items-center gap-2">
                          <code className="text-[10px] text-gray-300 flex-1 font-mono break-all">{declaredAddress}</code>
                          <button onClick={() => copy(declaredAddress, 'decl')} className="p-1 hover:bg-surface-700 rounded">
                            {copied === 'decl' ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5 text-gray-500" />}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                ) : (
                  <p className="text-xs text-gray-500">Could not derive an address for this key.</p>
                )}
              </>
            )}
          </>
        )}

        {status === 'review' && pending && pending.bridge && (() => {
          const cost = Math.ceil(pending.bridge.costMsats / 1000);
          const most = Math.ceil(pending.bridge.maxCostMsats / 1000);
          return (
            <div className="py-1">
              <p className="text-xs text-gray-400 mb-3 text-center">Paid from your <b className="text-purple-300">XBT</b> wallet through the bridge, which pays their <b className="text-bitcoin">BTC</b> invoice. Nothing has been paid yet.</p>
              <div className="rounded-xl border border-white/10 bg-white/[0.03] divide-y divide-white/5 text-sm">
                <div className="flex justify-between px-3 py-2.5"><span className="text-gray-400">{displayName} gets</span><b>{amount.toLocaleString()} BTC sats</b></div>
                <div className="flex justify-between px-3 py-2.5"><span className="text-gray-400">Bridge fee</span><span>{pending.bridge.spread != null ? `${(pending.bridge.spread * 100).toFixed(1)}%` : 'included'}</span></div>
                <div className="flex justify-between px-3 py-2.5 bg-white/[0.03]">
                  <span className="text-gray-300 font-medium">You pay</span>
                  <span className="text-right"><b className="text-purple-300">~{cost.toLocaleString()} XBT sats</b><span className="block text-[10px] text-gray-500">never more than {most.toLocaleString()} incl. routing</span></span>
                </div>
              </div>
              <p className="text-[11px] text-gray-500 mt-2">If the bridge can't pay their invoice, your XBT comes back.</p>
              <div className="flex gap-2 mt-4">
                <button onClick={() => { setPending(null); setStatus('idle'); }} className="flex-1 py-2.5 rounded-xl text-sm bg-surface-700 text-gray-200 hover:bg-surface-600">Cancel</button>
                <button onClick={confirmZap} className="flex-[2] py-2.5 rounded-xl text-sm font-semibold bg-bitcoin text-black hover:bg-bitcoin/90 flex items-center justify-center gap-1.5">
                  <Zap className="w-4 h-4" /> Pay {cost.toLocaleString()} XBT
                </button>
              </div>
            </div>
          );
        })()}

        {status === 'review' && pending && !pending.bridge && (() => {
          const feeSats = pending.feeMsats != null ? Math.ceil(pending.feeMsats / 1000) : null;
          const capSats = pending.capMsats != null ? Math.ceil(pending.capMsats / 1000) : null;
          const pct = (n: number) => (amount ? ` (${((n / amount) * 100).toFixed(n / amount < 0.01 ? 2 : 1)}%)` : '');
          return (
            <div className="py-1">
              <p className="text-xs text-gray-400 mb-3 text-center">Review before it's sent. Nothing has been paid yet.</p>
              <div className="rounded-xl border border-white/10 bg-white/[0.03] divide-y divide-white/5 text-sm">
                <div className="flex justify-between px-3 py-2.5"><span className="text-gray-400">Zap to {displayName}</span><b>{amount.toLocaleString()} sats</b></div>
                <div className="flex justify-between px-3 py-2.5">
                  <span className="text-gray-400">Network fee</span>
                  <span className="text-right">
                    {feeSats != null
                      ? <b>~{feeSats.toLocaleString()} sat{feeSats === 1 ? '' : 's'}{pct(feeSats)}</b>
                      : <span className="text-gray-300">{capSats != null ? `up to ${capSats.toLocaleString()} sats` : 'set by your wallet'}</span>}
                    {feeSats != null && capSats != null && <span className="block text-[10px] text-gray-500">never more than {capSats.toLocaleString()}</span>}
                  </span>
                </div>
                <div className="flex justify-between px-3 py-2.5 bg-white/[0.03]">
                  <span className="text-gray-300 font-medium">Total</span>
                  <b className="text-bitcoin">
                    {feeSats != null ? `~${(amount + feeSats).toLocaleString()}` : capSats != null ? `at most ${(amount + capSats).toLocaleString()}` : `${amount.toLocaleString()} + fee`} sats
                  </b>
                </div>
              </div>
              {pending.feeError && <p className="text-[11px] text-amber-300/90 mt-2">Couldn't estimate the fee ({pending.feeError}). The payment may still find a route.</p>}
              {feeSats == null && !pending.feeError && <p className="text-[11px] text-gray-500 mt-2">Your wallet doesn't quote fees ahead of time; Lightning routing usually costs under 1%.</p>}
              <div className="flex gap-2 mt-4">
                <button onClick={() => { setPending(null); setStatus('idle'); }} className="flex-1 py-2.5 rounded-xl text-sm bg-surface-700 text-gray-200 hover:bg-surface-600">Cancel</button>
                <button onClick={confirmZap} className="flex-[2] py-2.5 rounded-xl text-sm font-semibold bg-bitcoin text-black hover:bg-bitcoin/90 flex items-center justify-center gap-1.5">
                  <Zap className="w-4 h-4" /> Zap {amount.toLocaleString()} sats
                </button>
              </div>
            </div>
          );
        })()}

        {(status === 'fetching' || status === 'paying') && (
          <div className="flex flex-col items-center py-6">
            <Loader2 className="w-8 h-8 text-bitcoin animate-spin mb-3" />
            <p className="text-sm text-gray-300">{statusMessage}</p>
          </div>
        )}

        {status === 'invoice' && invoice && (
          <div className="flex flex-col items-center">
            <QRCode data={`lightning:${invoice}`} size={200} />
            <p className="text-xs text-gray-300 mt-3">
              {amount.toLocaleString()} sats on <b className={lnChain === 'xbt' ? 'text-purple-300' : 'text-bitcoin'}>{lnChain.toUpperCase()} Lightning</b>
            </p>
            <p className="text-[10px] text-gray-500 mt-1">
              Pay with a {lnChain === 'xbt' ? 'XBT Lightning' : 'Lightning'} wallet. To {lud16}
            </p>
            <div className="flex gap-2 w-full mt-3">
              <button
                onClick={() => copy(invoice, 'inv')}
                className="flex-1 py-2 rounded-lg text-xs font-medium bg-surface-700 text-gray-200 hover:bg-surface-600 flex items-center justify-center gap-1"
              >
                {copied === 'inv' ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5" />} Copy invoice
              </button>
              <a
                href={`lightning:${invoice}`}
                className="flex-1 py-2 rounded-lg text-xs font-semibold bg-bitcoin text-black hover:bg-bitcoin/90 flex items-center justify-center gap-1"
              >
                <Zap className="w-3.5 h-3.5" /> Open wallet
              </a>
            </div>
            <p className="text-[10px] text-gray-500 mt-3 flex items-center gap-1.5">
              {statusMessage.startsWith('Waiting') && <Loader2 className="w-3 h-3 animate-spin" />} {statusMessage}
            </p>
            <button onClick={() => { watchRef.current?.(); setStatus('idle'); }} className="text-[11px] text-gray-500 hover:text-white mt-2">
              Back
            </button>
          </div>
        )}

        {status === 'success' && (
          <div className="flex flex-col items-center py-6">
            <div className="w-10 h-10 rounded-full bg-green-500/20 flex items-center justify-center mb-3">
              <Check className="w-5 h-5 text-green-400" />
            </div>
            <p className="text-sm text-green-400 font-medium">{statusMessage}</p>
          </div>
        )}

        {status === 'error' && (
          <div className="flex flex-col items-center py-6">
            <div className="w-10 h-10 rounded-full bg-red-500/20 flex items-center justify-center mb-3">
              <AlertCircle className="w-5 h-5 text-red-400" />
            </div>
            <p className="text-sm text-red-400 text-center mb-4">
              {statusMessage}
            </p>
            <button
              onClick={() => setStatus('idle')}
              className="text-xs text-gray-400 hover:text-white transition-colors"
            >
              Try again
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
