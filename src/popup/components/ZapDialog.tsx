import { useState, useEffect } from 'react';
import { X, Zap, Loader2, Check, AlertCircle } from 'lucide-react';
import { useAuth } from '@/popup/context/AuthContext';
import { createMessageId } from '@/shared/messages';
import { loadRelayList, getReadRelays, getWriteRelays } from '@/lib/nostr/relays';
import { loadNwcConnection, sendNwcPayment } from '@/lib/nostr/nwc';
import {
  fetchLnurlPayInfo,
  requestZapInvoice,
  createZapRequestEvent,
} from '@/lib/nostr/zap';
import { type FeedNote } from '@/lib/nostr/feed';
import { type ProfileMetadata } from '@/lib/nostr/social';
import { useNavigate } from 'react-router-dom';

interface Props {
  note: FeedNote;
  profile?: ProfileMetadata | null;
  onClose: () => void;
}

const ZAP_AMOUNTS = [21, 100, 420, 1000, 5000, 10000];

type ZapStatus = 'idle' | 'fetching' | 'paying' | 'success' | 'error';

export function ZapDialog({ note, profile, onClose }: Props) {
  const { publicKey } = useAuth();
  const navigate = useNavigate();
  const [amount, setAmount] = useState(1000);
  const [comment, setComment] = useState('');
  const [status, setStatus] = useState<ZapStatus>('idle');
  const [statusMessage, setStatusMessage] = useState('');
  const [hasNwc, setHasNwc] = useState<boolean | null>(null);

  useEffect(() => {
    loadNwcConnection().then((conn) => setHasNwc(conn !== null));
  }, []);

  if (hasNwc === null) return null;

  if (hasNwc === false) {
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
            To send zaps, connect a Lightning wallet via Nostr Wallet Connect in
            Settings.
          </p>
          <button
            onClick={() => {
              onClose();
              navigate('/settings');
            }}
            className="w-full py-2 bg-bitcoin text-white rounded-lg text-sm font-medium hover:bg-bitcoin/90 transition-colors"
          >
            Go to Settings
          </button>
        </div>
      </div>
    );
  }

  async function handleZap() {
    const lud16 = profile?.lud16;
    if (!lud16) {
      setStatus('error');
      setStatusMessage('This user has no lightning address set');
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
        note.pubkey, note.id, publicKey, amountMsats, relays, comment,
      );

      const response = await chrome.runtime.sendMessage({
        type: 'nip07:signEvent',
        payload: { event: zapReq },
        id: createMessageId(),
      });

      if (response.error) {
        setStatus('error');
        setStatusMessage('Failed to sign zap request');
        return;
      }
      zapRequestJson = JSON.stringify(response.result);
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

    setStatus('paying');
    setStatusMessage('Paying via NWC...');

    const nwc = await loadNwcConnection();
    if (!nwc) {
      setStatus('error');
      setStatusMessage('NWC connection not found');
      return;
    }

    const payResult = await sendNwcPayment(nwc, invoiceResult.invoice);
    if (payResult.error) {
      setStatus('error');
      setStatusMessage(payResult.error);
      return;
    }

    setStatus('success');
    setStatusMessage(`Zapped ${amount.toLocaleString()} sats!`);
    setTimeout(onClose, 2000);
  }

  const displayName =
    profile?.displayName || profile?.name || note.pubkey.slice(0, 12);

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
              className="w-full py-2.5 bg-bitcoin text-white rounded-lg text-sm font-semibold hover:bg-bitcoin/90 transition-colors flex items-center justify-center gap-2"
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
