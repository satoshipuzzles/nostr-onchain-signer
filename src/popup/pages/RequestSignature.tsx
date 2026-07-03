import { useState } from 'react';
import { ArrowLeft, Send, Users, Loader2, Check } from 'lucide-react';
import { type ArchivedMultisig, savePendingRequest, type PendingSignatureRequest } from '@/lib/bitcoin/wallet-store';
import { createSigningRound, encodeSigningRequest, saveSigningRound } from '@/lib/bitcoin/signing-round';
import { createSigningRequestEvent, CUSTOM_KIND } from '@/lib/nostr/kinds';
import { publishEvent } from '@/lib/nostr/discovery';
import { createMessageId } from '@/shared/messages';
import { formatSats } from '@/lib/bitcoin/mempool';
import { pubkeyToNpub } from '@/lib/nostr/keys';
import { encryptDM } from '@/lib/nostr/dm';

interface Props {
  wallet: ArchivedMultisig;
  publicKey: string;
  onDone: () => void;
  onBack: () => void;
}

export function RequestSignature({ wallet, publicKey, onDone, onBack }: Props) {
  const [recipient, setRecipient] = useState('');
  const [amountSats, setAmountSats] = useState('');
  const [memo, setMemo] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');
  const [sentTo, setSentTo] = useState<string[]>([]);

  const otherSigners = wallet.keyHolders.filter((h) => !h.isOwnKey);

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setSending(true);

    try {
      const amount = parseInt(amountSats, 10);
      if (!amount || amount <= 0) throw new Error('Invalid amount');
      if (!recipient) throw new Error('Enter a recipient address');

      // Create a placeholder PSBT (in production this would be a real unsigned PSBT)
      // For now we encode the transaction intent
      const psbtPlaceholder = JSON.stringify({
        intent: 'send',
        from: wallet.wallet.address,
        to: recipient,
        amount,
        memo,
      });

      // Create signing round
      const signerPubkeys = wallet.keyHolders.map((h) => h.pubkey);
      const round = createSigningRound({
        multisigAddress: wallet.wallet.address,
        threshold: wallet.wallet.config.threshold,
        signerPubkeys,
        psbtHex: psbtPlaceholder,
        memo: memo || `Send ${formatSats(amount)} to ${recipient.slice(0, 12)}...`,
        ttlHours: 48,
      });

      await saveSigningRound(round);

      // Send signing requests to each co-signer via kind 9800
      const sentToPubkeys: string[] = [];

      for (const signer of otherSigners) {
        const requestEvent = createSigningRequestEvent(
          {
            psbt_hex: psbtPlaceholder,
            round_id: round.id,
            multisig_address: wallet.wallet.address,
            threshold: wallet.wallet.config.threshold,
            signed_count: 0,
            total_signers: signerPubkeys.length,
            memo: round.memo,
            expires_at: round.expiresAt,
          },
          signer.pubkey,
          publicKey
        );

        // Sign the request event
        const response = await chrome.runtime.sendMessage({
          type: 'nip07:signEvent',
          payload: { event: requestEvent },
          id: createMessageId(),
        });

        if (!response.error && response.result) {
          await publishEvent(response.result);
          sentToPubkeys.push(signer.pubkey);

          // Also send a DM with a signing link
          const signerName = signer.profile?.displayName || signer.profile?.name || 'Hey';
          const dmContent = `🔑 ${signerName}, you have a new signing request!\n\n` +
            `📝 ${round.memo}\n` +
            `💰 ${formatSats(amount)} sats\n` +
            `📍 ${wallet.wallet.address.slice(0, 20)}...\n` +
            `🔗 Round: ${round.id.slice(0, 16)}...\n\n` +
            `Open your Nostr Onchain signer to review and sign.\n` +
            `nostr:${response.result.id}`;

          let encryptedDmContent = dmContent;
          let dmKind = 4;
          try {
            const result = await encryptDM(signer.pubkey, dmContent);
            encryptedDmContent = result.content;
            dmKind = result.kind;
          } catch {
            console.warn('DM encryption failed — sending as plaintext');
          }

          const dmEvent = {
            kind: dmKind,
            content: encryptedDmContent,
            tags: [['p', signer.pubkey]],
            created_at: Math.floor(Date.now() / 1000),
            pubkey: publicKey,
          };

          const dmResponse = await chrome.runtime.sendMessage({
            type: 'nip07:signEvent',
            payload: { event: dmEvent },
            id: createMessageId(),
          });

          if (!dmResponse.error && dmResponse.result) {
            await publishEvent(dmResponse.result);
          }
        }

        // Track as pending outbound
        const pendingReq: PendingSignatureRequest = {
          id: `${round.id}_${signer.pubkey.slice(0, 8)}`,
          multisigId: wallet.id,
          roundId: round.id,
          direction: 'outbound',
          status: 'pending',
          psbtHex: psbtPlaceholder,
          recipientPubkey: signer.pubkey,
          amount,
          memo: round.memo,
          createdAt: Date.now(),
          expiresAt: round.expiresAt * 1000,
        };
        await savePendingRequest(pendingReq);
      }

      setSentTo(sentToPubkeys);
      setSent(true);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to send');
    } finally {
      setSending(false);
    }
  }

  if (sent) {
    return (
      <div className="h-full flex flex-col p-4 pb-24 md:pb-4 items-center justify-center">
        <div className="w-14 h-14 rounded-full bg-green-500/20 flex items-center justify-center mb-4">
          <Check className="w-7 h-7 text-green-400" />
        </div>
        <h2 className="text-lg font-bold mb-2">Signature Requests Sent</h2>
        <p className="text-sm text-gray-400 text-center mb-4">
          Sent to {sentTo.length} co-signer{sentTo.length > 1 ? 's' : ''} via Nostr
        </p>

        <div className="card w-full mb-4">
          <p className="text-xs text-gray-500 mb-2">Sent to:</p>
          {sentTo.map((pk) => {
            const holder = wallet.keyHolders.find((h) => h.pubkey === pk);
            return (
              <div key={pk} className="flex items-center gap-2 py-1.5">
                {holder?.profile?.picture ? (
                  <img src={holder.profile.picture} alt="" className="w-6 h-6 rounded-full object-cover" />
                ) : (
                  <div className="w-6 h-6 rounded-full bg-surface-700" />
                )}
                <span className="text-sm truncate">
                  {holder?.profile?.displayName || holder?.profile?.name || pk.slice(0, 12)}
                </span>
              </div>
            );
          })}
        </div>

        <p className="text-xs text-gray-500 text-center mb-4">
          Track progress in Signing Rounds. You'll receive signed PSBTs back as kind 9801 events.
        </p>

        <button onClick={onDone} className="btn-primary w-full">
          Done
        </button>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col p-4 overflow-y-auto pb-24">
      {/* Header */}
      <div className="page-header">
        <button onClick={onBack} className="btn-back">
          <ArrowLeft className="w-5 h-5" />
        </button>
        <h1>Spend from Multi-Sig</h1>
      </div>

      {/* Wallet info */}
      <div className="card mb-4">
        <div className="flex items-center gap-2 mb-2">
          <Users className="w-4 h-4 text-bitcoin" />
          <span className="text-sm font-medium">{wallet.name}</span>
          <span className="text-xs text-gray-500 ml-auto">
            {wallet.wallet.config.threshold}-of-{wallet.wallet.config.pubkeys.length}
          </span>
        </div>
        <p className="text-[10px] text-gray-500 font-mono">{wallet.wallet.address}</p>
      </div>

      {/* Transaction form */}
      <form onSubmit={handleSend} className="flex flex-col space-y-3">
        <div>
          <label className="text-xs text-gray-400 mb-1 block">Send to</label>
          <input
            value={recipient}
            onChange={(e) => setRecipient(e.target.value)}
            placeholder="bc1p... recipient address"
            className="input-field text-sm font-mono"
          />
        </div>

        <div>
          <label className="text-xs text-gray-400 mb-1 block">Amount (sats)</label>
          <input
            type="number"
            value={amountSats}
            onChange={(e) => setAmountSats(e.target.value)}
            placeholder="Amount in satoshis"
            className="input-field text-sm"
          />
        </div>

        <div>
          <label className="text-xs text-gray-400 mb-1 block">Memo (optional)</label>
          <input
            value={memo}
            onChange={(e) => setMemo(e.target.value)}
            placeholder="What is this payment for?"
            className="input-field text-sm"
          />
        </div>

        {/* Co-signers who will receive the request */}
        <div>
          <p className="text-xs text-gray-400 mb-2">
            Will request signatures from {otherSigners.length} co-signer{otherSigners.length > 1 ? 's' : ''}:
          </p>
          <div className="flex flex-wrap gap-1.5">
            {otherSigners.map((holder) => (
              <span key={holder.pubkey} className="flex items-center gap-1.5 bg-surface-700 rounded-full px-2 py-1">
                {holder.profile?.picture ? (
                  <img src={holder.profile.picture} alt="" className="w-4 h-4 rounded-full object-cover" />
                ) : (
                  <div className="w-4 h-4 rounded-full bg-nostr/30" />
                )}
                <span className="text-[10px] text-gray-300 truncate max-w-[80px]">
                  {holder.profile?.displayName || holder.profile?.name || holder.pubkey.slice(0, 8)}
                </span>
              </span>
            ))}
          </div>
        </div>

        {error && <p className="text-red-400 text-sm">{error}</p>}

        <button
          type="submit"
          disabled={!recipient || !amountSats || sending}
          className="btn-primary w-full flex items-center justify-center gap-2 !mt-6"
        >
          {sending ? (
            <><Loader2 className="w-4 h-4 animate-spin" /> Sending...</>
          ) : (
            <><Send className="w-4 h-4" /> Send to Co-Signers</>
          )}
        </button>
      </form>
    </div>
  );
}
