import { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { Loader2, Copy, Check, ExternalLink, Lock, Repeat } from 'lucide-react';
import { parseOnchainInvoice, type OnchainInvoiceContent } from '@/lib/nostr/kinds';

const RELAYS = ['wss://relay.damus.io', 'wss://nos.lol'];
const KIND_ONCHAIN_INVOICE = 9733;

interface InvoiceEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

export function InvoicePage() {
  const { eventId } = useParams<{ eventId: string }>();
  const [invoice, setInvoice] = useState<OnchainInvoiceContent | null>(null);
  const [event, setEvent] = useState<InvoiceEvent | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [passwordRequired, setPasswordRequired] = useState(false);
  const [passwordInput, setPasswordInput] = useState('');
  const [unlocked, setUnlocked] = useState(false);

  useEffect(() => {
    if (eventId) fetchInvoiceEvent(eventId);
  }, [eventId]);

  async function fetchInvoiceEvent(id: string) {
    setLoading(true);
    setError('');

    const fetchPromises = RELAYS.map((relayUrl) => fetchFromRelay(relayUrl, id));
    const results = await Promise.allSettled(fetchPromises);

    let foundEvent: InvoiceEvent | null = null;
    for (const result of results) {
      if (result.status === 'fulfilled' && result.value) {
        foundEvent = result.value;
        break;
      }
    }

    if (!foundEvent) {
      setError('Invoice not found on relays');
      setLoading(false);
      return;
    }

    setEvent(foundEvent);

    const parsed = parseOnchainInvoice(foundEvent.content);
    if (!parsed) {
      setError('Invalid invoice data');
      setLoading(false);
      return;
    }

    setInvoice(parsed);

    const passwordTag = foundEvent.tags.find((t) => t[0] === 'password');
    if (passwordTag && passwordTag[1]) {
      setPasswordRequired(true);
    } else {
      setUnlocked(true);
    }

    setLoading(false);
  }

  function fetchFromRelay(relayUrl: string, id: string): Promise<InvoiceEvent | null> {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        ws.close();
        resolve(null);
      }, 10000);

      let ws: WebSocket;
      try {
        ws = new WebSocket(relayUrl);
      } catch {
        clearTimeout(timeout);
        resolve(null);
        return;
      }

      const subId = `inv_${Math.random().toString(36).slice(2, 8)}`;

      ws.onopen = () => {
        ws.send(JSON.stringify(['REQ', subId, {
          ids: [id],
          kinds: [KIND_ONCHAIN_INVOICE],
          limit: 1,
        }]));
      };

      ws.onmessage = (msg) => {
        try {
          const data = JSON.parse(msg.data);
          if (data[0] === 'EVENT' && data[1] === subId && data[2]) {
            clearTimeout(timeout);
            ws.close();
            resolve(data[2] as InvoiceEvent);
          } else if (data[0] === 'EOSE') {
            clearTimeout(timeout);
            ws.close();
            resolve(null);
          }
        } catch {
          // ignore parse errors
        }
      };

      ws.onerror = () => {
        clearTimeout(timeout);
        resolve(null);
      };
    });
  }

  function handlePasswordSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!event) return;

    const passwordTag = event.tags.find((t) => t[0] === 'password');
    if (passwordTag && passwordTag[1] === passwordInput) {
      setUnlocked(true);
    } else {
      setError('Incorrect password');
    }
  }

  async function copyAddress() {
    if (!invoice?.address) return;
    await navigator.clipboard.writeText(invoice.address);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  function getQrUrl(address: string): string {
    return `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=bitcoin:${address}`;
  }

  function getMempoolUrl(address: string): string {
    return `https://mempool.space/address/${address}`;
  }

  function formatExpiry(timestamp: number): string {
    const date = new Date(timestamp * 1000);
    const now = Date.now();
    if (date.getTime() < now) return 'Expired';
    const diff = date.getTime() - now;
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    if (days > 0) return `${days}d ${hours}h remaining`;
    return `${hours}h remaining`;
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-surface-900 flex items-center justify-center p-4">
        <div className="text-center">
          <Loader2 className="w-8 h-8 animate-spin text-bitcoin mx-auto mb-3" />
          <p className="text-gray-400 text-sm">Fetching invoice from relays...</p>
        </div>
      </div>
    );
  }

  if (error && !invoice) {
    return (
      <div className="min-h-screen bg-surface-900 flex items-center justify-center p-4">
        <div className="text-center max-w-sm">
          <p className="text-red-400 text-sm mb-2">{error}</p>
          <p className="text-gray-500 text-xs">Event ID: {eventId}</p>
        </div>
      </div>
    );
  }

  if (passwordRequired && !unlocked) {
    return (
      <div className="min-h-screen bg-surface-900 flex items-center justify-center p-4">
        <div className="w-full max-w-sm bg-surface-800 rounded-2xl p-6 border border-surface-200/10">
          <div className="text-center mb-6">
            <Lock className="w-10 h-10 text-bitcoin mx-auto mb-3" />
            <h1 className="text-lg font-bold text-white">Password Protected</h1>
            <p className="text-gray-400 text-sm mt-1">This invoice requires a password to view</p>
          </div>
          <form onSubmit={handlePasswordSubmit} className="space-y-4">
            <input
              type="password"
              value={passwordInput}
              onChange={(e) => { setPasswordInput(e.target.value); setError(''); }}
              placeholder="Enter password"
              className="w-full px-4 py-3 bg-surface-700 border border-surface-200/10 rounded-xl text-white text-sm outline-none focus:border-bitcoin/50"
              autoFocus
            />
            {error && <p className="text-red-400 text-xs">{error}</p>}
            <button
              type="submit"
              className="w-full py-3 bg-bitcoin text-white rounded-xl font-medium text-sm hover:bg-bitcoin/90 transition-colors"
            >
              Unlock Invoice
            </button>
          </form>
        </div>
      </div>
    );
  }

  if (!invoice) return null;

  const imageTag = event?.tags.find((t) => t[0] === 'image');
  const imageUrl = imageTag?.[1];
  const isExpired = invoice.expires_at ? invoice.expires_at * 1000 < Date.now() : false;

  const recurringTag = event?.tags.find((t) => t[0] === 'recurring' && t[1] === 'true');
  const frequencyDaysTag = event?.tags.find((t) => t[0] === 'frequency_days');
  const frequencyBlocksTag = event?.tags.find((t) => t[0] === 'frequency_blocks');
  const occurrencesTag = event?.tags.find((t) => t[0] === 'occurrences');

  const isRecurring = !!recurringTag;
  const recurringLabel = frequencyDaysTag
    ? `Every ${frequencyDaysTag[1]} days`
    : frequencyBlocksTag
    ? `Every ${frequencyBlocksTag[1]} blocks`
    : 'Recurring';
  const occurrencesLabel = occurrencesTag
    ? occurrencesTag[1] === 'unlimited' ? 'Unlimited' : `${occurrencesTag[1]} payments`
    : null;

  return (
    <div className="min-h-screen bg-surface-900 flex items-center justify-center p-4">
      <div className="w-full max-w-sm bg-surface-800 rounded-2xl p-6 border border-surface-200/10">
        <div className="text-center mb-6">
          <h1 className="text-lg font-bold text-white">Onchain Invoice</h1>
          <p className="text-gray-400 text-xs mt-1">Bitcoin Payment Request</p>
        </div>

        {/* QR Code */}
        <div className="flex justify-center mb-4">
          <img
            src={getQrUrl(invoice.address)}
            alt="Bitcoin QR Code"
            className="w-48 h-48 rounded-xl bg-white p-2"
          />
        </div>

        {/* Amount */}
        {invoice.amount_sats && (
          <div className="text-center mb-4">
            <span className="text-2xl font-bold text-bitcoin">
              {invoice.amount_sats.toLocaleString()}
            </span>
            <span className="text-gray-400 text-sm ml-1">sats</span>
          </div>
        )}

        {/* Address */}
        <div className="bg-surface-700 rounded-xl p-3 mb-4">
          <p className="text-[10px] text-gray-500 mb-1">Bitcoin Address</p>
          <div className="flex items-center gap-2">
            <code className="text-xs text-white font-mono flex-1 break-all">{invoice.address}</code>
            <button onClick={copyAddress} className="flex-shrink-0 p-2 hover:bg-surface-600 rounded-lg transition-colors">
              {copied ? <Check className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4 text-gray-400" />}
            </button>
          </div>
        </div>

        {/* Memo */}
        {invoice.memo && (
          <div className="bg-surface-700 rounded-xl p-3 mb-4">
            <p className="text-[10px] text-gray-500 mb-1">Memo</p>
            <p className="text-sm text-white">{invoice.memo}</p>
          </div>
        )}

        {/* Attached Image */}
        {imageUrl && (
          <div className="rounded-xl overflow-hidden mb-4">
            <img src={imageUrl} alt="Invoice attachment" className="w-full h-auto rounded-xl" />
          </div>
        )}

        {/* Expiry */}
        {invoice.expires_at && (
          <div className="flex items-center justify-between bg-surface-700 rounded-xl p-3 mb-4">
            <span className="text-[10px] text-gray-500">Expiry</span>
            <span className={`text-xs font-medium ${isExpired ? 'text-red-400' : 'text-green-400'}`}>
              {formatExpiry(invoice.expires_at)}
            </span>
          </div>
        )}

        {/* Recurring / Subscription */}
        {isRecurring && (
          <div className="bg-surface-700 rounded-xl p-3 mb-4">
            <div className="flex items-center gap-2 mb-1">
              <Repeat className="w-3.5 h-3.5 text-nostr" />
              <span className="text-xs font-medium text-nostr">Subscription</span>
            </div>
            <p className="text-sm text-white">{recurringLabel}</p>
            {occurrencesLabel && (
              <p className="text-[10px] text-gray-500 mt-0.5">{occurrencesLabel}</p>
            )}
          </div>
        )}

        {/* Copy Address Button */}
        <button
          onClick={copyAddress}
          className="w-full py-3 bg-bitcoin text-white rounded-xl font-medium text-sm hover:bg-bitcoin/90 transition-colors flex items-center justify-center gap-2 mb-3"
        >
          {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
          {copied ? 'Copied!' : 'Copy Address'}
        </button>

        {/* View on Mempool */}
        <a
          href={getMempoolUrl(invoice.address)}
          target="_blank"
          rel="noopener noreferrer"
          className="w-full py-3 bg-surface-700 text-gray-300 rounded-xl font-medium text-sm hover:bg-surface-600 transition-colors flex items-center justify-center gap-2"
        >
          <ExternalLink className="w-4 h-4" />
          View on Mempool
        </a>

        {/* Event metadata */}
        <div className="mt-6 pt-4 border-t border-surface-200/10">
          <p className="text-[10px] text-gray-600 text-center">
            Event ID: {eventId?.slice(0, 16)}...
          </p>
        </div>
      </div>
    </div>
  );
}
