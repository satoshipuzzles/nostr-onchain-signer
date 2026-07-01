import { useState } from 'react';
import { createMessageId } from '@/shared/messages';
import { createOnchainInvoice } from '@/lib/nostr/kinds';
import { publishEvent } from '@/lib/nostr/discovery';
import { pubkeyToTaprootAddress } from '@/lib/bitcoin/address';
import { npubToPubkey } from '@/lib/nostr/keys';
import { ArrowLeft, Loader2, Send } from 'lucide-react';

interface Props {
  publicKey: string;
  onClose: () => void;
  onCreated: () => void;
}

export function InvoiceCreator({ publicKey, onClose, onCreated }: Props) {
  const [recipientPubkey, setRecipientPubkey] = useState('');
  const [address, setAddress] = useState(() => pubkeyToTaprootAddress(publicKey));
  const [amountSats, setAmountSats] = useState('');
  const [memo, setMemo] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');

    const recipient = recipientPubkey.trim();
    if (!recipient) { setError('Recipient pubkey is required'); return; }
    if (recipient.length !== 64 && !recipient.startsWith('npub1')) {
      setError('Enter a valid hex pubkey or npub');
      return;
    }
    if (!address.trim()) { setError('Bitcoin address is required'); return; }

    setLoading(true);
    try {
      let recipientHex = recipient;
      if (recipient.startsWith('npub1')) {
        recipientHex = npubToPubkey(recipient);
      }

      const amount = amountSats ? parseInt(amountSats, 10) : undefined;
      const invoiceEvent = createOnchainInvoice(
        {
          address: address.trim(),
          amount_sats: amount,
          memo: memo.trim() || undefined,
          expires_at: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60,
        },
        recipientHex,
        publicKey
      );

      const signResponse = await chrome.runtime.sendMessage({
        type: 'nip07:signEvent',
        payload: { event: invoiceEvent },
        id: createMessageId(),
      });
      if (signResponse.error) throw new Error(signResponse.error);

      await publishEvent(signResponse.result);

      const dmContent = [
        `📄 Onchain Invoice`,
        ``,
        `Address: ${address.trim()}`,
        amount ? `Amount: ${amount.toLocaleString()} sats` : `Amount: Any`,
        memo.trim() ? `Memo: ${memo.trim()}` : '',
        ``,
        `Pay via Nostr Onchain Signer or any Bitcoin wallet.`,
      ].filter(Boolean).join('\n');

      const dmEvent = {
        kind: 4,
        content: dmContent,
        tags: [['p', recipientHex]],
        created_at: Math.floor(Date.now() / 1000),
        pubkey: publicKey,
      };

      const dmSignResponse = await chrome.runtime.sendMessage({
        type: 'nip07:signEvent',
        payload: { event: dmEvent },
        id: createMessageId(),
      });
      if (!dmSignResponse.error && dmSignResponse.result) {
        await publishEvent(dmSignResponse.result);
      }

      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create invoice');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="h-full flex flex-col">
      <div className="page-header px-4">
        <button onClick={onClose} className="btn-back">
          <ArrowLeft className="w-5 h-5" />
        </button>
        <h1>Create Invoice</h1>
      </div>

      <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto px-4 pb-20 space-y-4">
        <div>
          <label className="text-xs text-gray-400 mb-1 block">Recipient (npub or hex pubkey)</label>
          <input
            value={recipientPubkey}
            onChange={(e) => setRecipientPubkey(e.target.value)}
            placeholder="npub1... or 64-char hex"
            className="input-field text-sm font-mono"
          />
        </div>

        <div>
          <label className="text-xs text-gray-400 mb-1 block">Your Bitcoin Address</label>
          <input
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="bc1p..."
            className="input-field text-sm font-mono"
          />
          <p className="text-[10px] text-gray-600 mt-1">Auto-filled from your Taproot key</p>
        </div>

        <div>
          <label className="text-xs text-gray-400 mb-1 block">Amount (sats, optional)</label>
          <input
            type="number"
            value={amountSats}
            onChange={(e) => setAmountSats(e.target.value)}
            placeholder="Leave empty for any amount"
            className="input-field text-sm"
          />
        </div>

        <div>
          <label className="text-xs text-gray-400 mb-1 block">Memo (optional)</label>
          <textarea
            value={memo}
            onChange={(e) => setMemo(e.target.value)}
            placeholder="What is this invoice for?"
            className="input-field h-16 resize-none text-sm"
          />
        </div>

        {error && <p className="text-red-400 text-sm">{error}</p>}

        <button
          type="submit"
          disabled={loading || !recipientPubkey.trim()}
          className="btn-primary w-full flex items-center justify-center gap-2 min-h-[44px]"
        >
          {loading ? (
            <><Loader2 className="w-4 h-4 animate-spin" /> Creating Invoice...</>
          ) : (
            <><Send className="w-4 h-4" /> Create &amp; Send Invoice</>
          )}
        </button>

        <p className="text-[10px] text-gray-600 text-center">
          Creates a kind 9733 onchain invoice event and sends a DM notification to the recipient
        </p>
      </form>
    </div>
  );
}
