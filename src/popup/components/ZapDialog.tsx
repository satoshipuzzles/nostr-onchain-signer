import { useState, useEffect } from 'react';
import { X, Zap, Loader2, Check, AlertCircle } from 'lucide-react';
import { useAuth } from '@/popup/context/AuthContext';
import { signEventWithFallback } from '@/lib/nostr/sign-event';
import { loadRelayList, getReadRelays, getWriteRelays } from '@/lib/nostr/relays';
import { loadNwcConnection, sendNwcPayment, type LightningChain } from '@/lib/nostr/nwc';
import {
  fetchLnurlPayInfo,
  requestZapInvoice,
  createZapRequestEvent,
} from '@/lib/nostr/zap';
import { type FeedNote } from '@/lib/nostr/feed';
import { detectAddressChain, invoiceChain, type LnChain } from '@/lib/nostr/lightning-chain';
import { type ProfileMetadata } from '@/lib/nostr/social';
import { useNavigate } from 'react-router-dom';

interface Props {
  note?: FeedNote;
  recipientPubkey: string;
  profile?: ProfileMetadata | null;
  onClose: () => void;
}

const ZAP_AMOUNTS = [21, 100, 420, 1000, 5000, 10000];

type ZapStatus = 'idle' | 'fetching' | 'paying' | 'success' | 'error';

export function ZapDialog({ note, recipientPubkey, profile, onClose }: Props) {
  const { publicKey } = useAuth();
  const navigate = useNavigate();
  const [amount, setAmount] = useState(1000);
  const [comment, setComment] = useState('');
  const [status, setStatus] = useState<ZapStatus>('idle');
  const [statusMessage, setStatusMessage] = useState('');
  // Which Lightning wallets are connected; null while loading
  const [wallets, setWallets] = useState<Record<LightningChain, boolean> | null>(null);
  const [chain, setChain] = useState<LightningChain>('xbt');
  // Which network the recipient's plain lud16 is actually on (see lightning-chain.ts)
  const [lud16Chain, setLud16Chain] = useState<LnChain | 'checking' | 'unknown' | null>(null);

  useEffect(() => {
    const addr = profile?.lud16;
    if (!addr) { setLud16Chain(null); return; }
    let live = true;
    setLud16Chain('checking');
    detectAddressChain(addr).then((c) => { if (live) setLud16Chain(c ?? 'unknown'); });
    return () => { live = false; };
  }, [profile?.lud16]);

  useEffect(() => {
    Promise.all([loadNwcConnection('xbt'), loadNwcConnection('btc')]).then(([x, b]) => {
      setWallets({ xbt: !!x, btc: !!b });
      // XBT first, like everywhere else in the suite
      setChain(x || !b ? 'xbt' : 'btc');
    });
  }, []);

  if (wallets === null) return null;

  if (!wallets.xbt && !wallets.btc) {
    return (
      <div
        className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4"
        onClick={onClose}
      >
        <div
          className="bg-surface-800 rounded-2xl border border-surface-200/10 p-5 w-full max-w-sm"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-semibold flex items-center gap-2">
              <Zap className="w-4 h-4 text-bitcoin" /> Connect Wallet
            </h3>
            <button
              onClick={onClose}
              className="text-gray-500 hover:text-white transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
          <p className="text-xs text-gray-400 mb-4">
            To send zaps, connect an XBT or BTC Lightning wallet via Nostr Wallet
            Connect on the Lightning page.
          </p>
          <button
            onClick={() => {
              onClose();
              navigate('/lightning');
            }}
            className="w-full py-2 bg-bitcoin text-black rounded-lg text-sm font-medium hover:bg-bitcoin/90 transition-colors"
          >
            Set up Lightning wallet
          </button>
        </div>
      </div>
    );
  }

  // XBT zaps go to the XBT Lightning address. Without one, the regular address
  // is used only if its invoices carry the BLAKE2b flag, i.e. it is an XBT node.
  const xbtFallback = chain === 'xbt' && !profile?.lud16Xbt;
  const lud16 = chain === 'xbt' ? (profile?.lud16Xbt || profile?.lud16) : profile?.lud16;
  const wrongNetwork =
    (xbtFallback && lud16Chain === 'btc') ||
    (chain === 'btc' && !!profile?.lud16 && lud16Chain === 'xbt');
  const otherChain: LightningChain = chain === 'xbt' ? 'btc' : 'xbt';

  async function handleZap() {
    if (!lud16) {
      setStatus('error');
      setStatusMessage(`This user has no ${chain.toUpperCase()} Lightning address set`);
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

    const amountMsats = amount * 1000;
    if (amountMsats < payInfo.minSendable || amountMsats > payInfo.maxSendable) {
      setStatus('error');
      setStatusMessage(
        `Amount must be between ${Math.ceil(payInfo.minSendable / 1000)} and ${Math.floor(payInfo.maxSendable / 1000)} sats`,
      );
      return;
    }

    let zapRequestJson: string | undefined;

    if (payInfo.allowsNostr && payInfo.nostrPubkey) {
      setStatusMessage('Creating zap request...');
      const relayList = await loadRelayList();
      const relays = [
        ...new Set([...getReadRelays(relayList), ...getWriteRelays(relayList)]),
      ].slice(0, 5);

      const zapReq = createZapRequestEvent(
        recipientPubkey, note?.id, publicKey, amountMsats, relays, comment,
      );
      // Rides inside the receipt, so clients can tell XBT zaps from BTC ones
      zapReq.tags.push(['chain', chain]);

      try {
        // Vault, extension or bunker: whichever signs for this account
        const signed = await signEventWithFallback(zapReq, publicKey);
        zapRequestJson = JSON.stringify(signed);
      } catch (err) {
        setStatus('error');
        setStatusMessage(`Failed to sign zap request: ${err instanceof Error ? err.message : err}`);
        return;
      }
    }

    setStatusMessage('Requesting invoice...');
    const invoiceResult = await requestZapInvoice(
      payInfo.callback, amountMsats, zapRequestJson,
    );
    if (invoiceResult.error || !invoiceResult.invoice) {
      setStatus('error');
      setStatusMessage(invoiceResult.error || 'Failed to get invoice');
      return;
    }

    // Last check before money moves: the invoice says which network minted it.
    const invChain = invoiceChain(invoiceResult.invoice);
    if (invChain !== chain) {
      setStatus('error');
      setStatusMessage(
        `${lud16} is a ${invChain.toUpperCase()} Lightning address, so it can't be paid from your ${chain.toUpperCase()} wallet. Nothing was sent.`,
      );
      return;
    }

    setStatus('paying');
    setStatusMessage(`Paying on ${chain.toUpperCase()} Lightning...`);

    const nwc = await loadNwcConnection(chain);
    if (!nwc) {
      setStatus('error');
      setStatusMessage(`No ${chain.toUpperCase()} Lightning wallet connected`);
      return;
    }

    const payResult = await sendNwcPayment(nwc, invoiceResult.invoice);
    if (payResult.error) {
      setStatus('error');
      setStatusMessage(
        xbtFallback
          ? `${payResult.error}. ${lud16} may not be on XBT Lightning; they haven't set an XBT Lightning address.`
          : payResult.error,
      );
      return;
    }

    setStatus('success');
    setStatusMessage(`Zapped ${amount.toLocaleString()} sats on ${chain.toUpperCase()}!`);
    setTimeout(onClose, 2000);
  }

  const displayName =
    profile?.displayName || profile?.name || recipientPubkey.slice(0, 12);

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <div
        className="bg-surface-800 rounded-2xl border border-surface-200/10 p-5 w-full max-w-sm"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold flex items-center gap-2">
            <Zap className="w-4 h-4 text-bitcoin" /> Zap {displayName}
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
              {(['xbt', 'btc'] as const).map((c) => (
                <button
                  key={c}
                  onClick={() => setChain(c)}
                  disabled={!wallets[c]}
                  title={wallets[c] ? undefined : `Connect a ${c.toUpperCase()} Lightning wallet in Settings`}
                  className={`flex-1 py-1.5 rounded-md transition-colors disabled:opacity-40 ${chain === c ? 'bg-bitcoin text-black' : 'text-gray-400 hover:text-white'}`}
                >
                  {c.toUpperCase()} Lightning
                </button>
              ))}
            </div>
            <p className="text-[11px] text-gray-500 mb-3 truncate" title={lud16}>
              {lud16 ? <>To {lud16}
                {xbtFallback && lud16Chain === 'checking' && <span className="text-gray-400"> · checking network…</span>}
                {xbtFallback && lud16Chain === 'xbt' && <span className="text-green-400"> · on XBT Lightning ✓</span>}
                {xbtFallback && lud16Chain === 'unknown' && <span className="text-amber-500"> · couldn't check network</span>}
              </> : `No ${chain.toUpperCase()} Lightning address`}
            </p>
            {wrongNetwork && (
              <div className="text-[11px] text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2 mb-3">
                {profile?.lud16} is on <b>{(lud16Chain as string).toUpperCase()} Lightning</b>, not {chain.toUpperCase()}.
                {wallets[otherChain]
                  ? <> <button onClick={() => setChain(otherChain)} className="underline font-medium">Zap with {otherChain.toUpperCase()} instead</button></>
                  : <> Connect a {otherChain.toUpperCase()} wallet in Settings to zap them.</>}
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

            <button
              onClick={handleZap}
              disabled={wrongNetwork || (xbtFallback && lud16Chain === 'checking')}
              className="w-full py-2.5 bg-bitcoin text-black rounded-lg text-sm font-semibold hover:bg-bitcoin/90 transition-colors flex items-center justify-center gap-2 disabled:opacity-40"
            >
              <Zap className="w-4 h-4" />
              Zap {amount.toLocaleString()} sats
            </button>
          </>
        )}

        {(status === 'fetching' || status === 'paying') && (
          <div className="flex flex-col items-center py-6">
            <Loader2 className="w-8 h-8 text-bitcoin animate-spin mb-3" />
            <p className="text-sm text-gray-300">{statusMessage}</p>
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
