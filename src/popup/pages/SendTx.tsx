import { useState } from 'react';
import { createMessageId } from '@/shared/messages';
import { ArrowLeft, Send, FileText, Bitcoin } from 'lucide-react';

interface Props {
  publicKey: string;
  onBack: () => void;
}

export function SendTx({ publicKey, onBack }: Props) {
  const [recipient, setRecipient] = useState('');
  const [amountSats, setAmountSats] = useState('');
  const [noteContent, setNoteContent] = useState('');
  const [feeRate, setFeeRate] = useState('5');
  const [result, setResult] = useState<{
    signedNote: { id: string };
    opReturn: { scriptHex: string; size: number };
  } | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const response = await chrome.runtime.sendMessage({
        type: 'dual:signAndBroadcast',
        payload: {
          noteContent,
          recipientAddress: recipient,
          amountSats: parseInt(amountSats, 10),
          feeRate: parseFloat(feeRate),
        },
        id: createMessageId(),
      });

      if (response.error) {
        setError(response.error);
      } else {
        setResult(response.result);
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to sign');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="h-full flex flex-col p-4 overflow-y-auto">
      {/* Header */}
      <div className="flex items-center gap-2 mb-4">
        <button onClick={onBack} className="p-1.5 hover:bg-surface-700 rounded-lg">
          <ArrowLeft className="w-4 h-4" />
        </button>
        <h1 className="text-lg font-bold">Send + Note</h1>
      </div>

      {result ? (
        <div className="flex-1 space-y-3">
          <div className="card">
            <div className="flex items-center gap-2 mb-2">
              <FileText className="w-4 h-4 text-nostr" />
              <span className="text-sm font-medium">Nostr Note Signed</span>
            </div>
            <code className="text-xs text-gray-400 break-all">
              {result.signedNote.id}
            </code>
          </div>

          <div className="card">
            <div className="flex items-center gap-2 mb-2">
              <Bitcoin className="w-4 h-4 text-bitcoin" />
              <span className="text-sm font-medium">OP_RETURN Ready</span>
            </div>
            <p className="text-xs text-gray-400">
              {result.opReturn.size} bytes (max 80)
            </p>
            <code className="text-xs text-gray-500 break-all mt-1 block">
              {result.opReturn.scriptHex}
            </code>
          </div>

          <p className="text-xs text-gray-500 text-center">
            Transaction ready to broadcast via your connected wallet.
          </p>

          <button onClick={onBack} className="btn-secondary w-full">
            Done
          </button>
        </div>
      ) : (
        <form onSubmit={handleSend} className="flex-1 flex flex-col space-y-3">
          {/* Note content */}
          <div>
            <label className="text-xs text-gray-400 mb-1 block">
              Nostr Note (embedded in OP_RETURN)
            </label>
            <textarea
              value={noteContent}
              onChange={(e) => setNoteContent(e.target.value)}
              placeholder="Message to embed on-chain..."
              className="input-field h-20 resize-none text-sm"
            />
          </div>

          {/* Recipient */}
          <div>
            <label className="text-xs text-gray-400 mb-1 block">
              Recipient Address
            </label>
            <input
              value={recipient}
              onChange={(e) => setRecipient(e.target.value)}
              placeholder="bc1p..."
              className="input-field text-sm font-mono"
            />
          </div>

          {/* Amount */}
          <div className="flex gap-2">
            <div className="flex-1">
              <label className="text-xs text-gray-400 mb-1 block">Amount (sats)</label>
              <input
                type="number"
                value={amountSats}
                onChange={(e) => setAmountSats(e.target.value)}
                placeholder="10000"
                className="input-field text-sm"
              />
            </div>
            <div className="w-24">
              <label className="text-xs text-gray-400 mb-1 block">Fee (sat/vB)</label>
              <input
                type="number"
                value={feeRate}
                onChange={(e) => setFeeRate(e.target.value)}
                placeholder="5"
                className="input-field text-sm"
              />
            </div>
          </div>

          {error && <p className="text-red-400 text-sm">{error}</p>}

          <div className="mt-auto pt-2">
            <button
              type="submit"
              disabled={!recipient || !amountSats || loading}
              className="btn-primary w-full flex items-center justify-center gap-2"
            >
              {loading ? (
                'Signing...'
              ) : (
                <>
                  <Send className="w-4 h-4" />
                  Sign &amp; Prepare TX
                </>
              )}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
