import { useState, useEffect, useRef } from 'react';
import { createMessageId } from '@/shared/messages';
import { ArrowLeft, Send, FileText, Bitcoin, Loader2, Image, X, Zap, ExternalLink, Copy, Check } from 'lucide-react';
import { fetchBalance, fetchFeeEstimates, formatSats, getMempoolTxUrl } from '@/lib/bitcoin/mempool';
import { pubkeyToTaprootAddress } from '@/lib/bitcoin/address';
import { uploadFile, validateFile } from '@/lib/nostr/upload';
import { publishEvent } from '@/lib/nostr/discovery';

interface Props {
  publicKey: string;
  onBack: () => void;
}

interface FeeEstimate {
  fastest: number;
  halfHour: number;
  hour: number;
  economy: number;
}

export function SendTx({ publicKey, onBack }: Props) {
  const [recipient, setRecipient] = useState('');
  const [amountSats, setAmountSats] = useState('');
  const [noteContent, setNoteContent] = useState('');
  const [noteImages, setNoteImages] = useState<string[]>([]);
  const [feeRate, setFeeRate] = useState('');
  const [feeEstimates, setFeeEstimates] = useState<FeeEstimate | null>(null);
  const [balance, setBalance] = useState<number>(0);
  const [loadingBalance, setLoadingBalance] = useState(true);
  const [result, setResult] = useState<{
    signedNote: { id: string; sig: string; pubkey: string; kind: number; content: string; tags: string[][]; created_at: number };
    opReturn: { scriptHex: string; size: number };
    recipientAddress: string;
    amountSats: number;
  } | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [notePublished, setNotePublished] = useState(false);
  const [copied, setCopied] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const address = pubkeyToTaprootAddress(publicKey);

  useEffect(() => {
    loadBalanceAndFees();
  }, []);

  async function loadBalanceAndFees() {
    setLoadingBalance(true);
    try {
      const [bal, fees] = await Promise.allSettled([
        fetchBalance(address),
        fetchFeeEstimates(),
      ]);

      if (bal.status === 'fulfilled') {
        setBalance(bal.value.total);
      }

      if (fees.status === 'fulfilled') {
        setFeeEstimates(fees.value);
        setFeeRate(String(fees.value.halfHour));
      }
    } catch {} finally {
      setLoadingBalance(false);
    }
  }

  async function handleImageUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    const validation = validateFile(file);
    if (!validation.valid) {
      setError(validation.error || 'Invalid file');
      return;
    }

    setUploading(true);
    setError('');
    try {
      const result = await uploadFile(file, publicKey);
      setNoteImages((prev) => [...prev, result.url]);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
      e.target.value = '';
    }
  }

  function removeImage(url: string) {
    setNoteImages((prev) => prev.filter((u) => u !== url));
  }

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      // Include image URLs in note content
      let fullContent = noteContent;
      if (noteImages.length > 0) {
        fullContent += '\n' + noteImages.join('\n');
      }

      const response = await chrome.runtime.sendMessage({
        type: 'dual:signAndBroadcast',
        payload: {
          noteContent: fullContent,
          noteTags: noteImages.map((url) => ['image', url]),
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

  async function handlePublishNote() {
    if (!result?.signedNote) return;
    try {
      const pubResult = await publishEvent(result.signedNote as any);
      if (pubResult.success.length > 0) {
        setNotePublished(true);
      } else {
        setError('Failed to publish note to relays');
      }
    } catch {
      setError('Failed to publish note');
    }
  }

  async function copyOpReturn() {
    if (!result?.opReturn.scriptHex) return;
    await navigator.clipboard.writeText(result.opReturn.scriptHex);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="h-full flex flex-col p-4 overflow-y-auto">
      <div className="flex items-center gap-2 mb-4">
        <button onClick={onBack} className="p-1.5 hover:bg-surface-700 rounded-lg">
          <ArrowLeft className="w-4 h-4" />
        </button>
        <h1 className="text-lg font-bold flex-1">Transaction Builder</h1>
        {loadingBalance ? (
          <Loader2 className="w-3 h-3 animate-spin text-gray-500" />
        ) : (
          <span className="text-xs text-bitcoin font-medium">{formatSats(balance)}</span>
        )}
      </div>

      {result ? (
        <div className="flex-1 space-y-3">
          <div className="card border-green-500/30">
            <div className="flex items-center gap-2 mb-2">
              <FileText className="w-4 h-4 text-nostr" />
              <span className="text-sm font-medium">Note Signed</span>
              {notePublished && <span className="text-[10px] text-green-400 ml-auto">Published ✓</span>}
            </div>
            <code className="text-[10px] text-gray-400 break-all block mb-2">
              {result.signedNote.id}
            </code>
            {!notePublished && (
              <button onClick={handlePublishNote} className="text-xs text-nostr hover:underline">
                Publish note to relays →
              </button>
            )}
          </div>

          <div className="card">
            <div className="flex items-center gap-2 mb-2">
              <Bitcoin className="w-4 h-4 text-bitcoin" />
              <span className="text-sm font-medium">OP_RETURN Data</span>
              <span className="text-[10px] text-gray-500 ml-auto">{result.opReturn.size}/80 bytes</span>
            </div>
            <div className="flex items-center gap-2">
              <code className="text-[10px] text-gray-500 break-all flex-1">
                {result.opReturn.scriptHex}
              </code>
              <button onClick={copyOpReturn} className="p-1 hover:bg-surface-700 rounded flex-shrink-0">
                {copied ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3 text-gray-500" />}
              </button>
            </div>
          </div>

          <div className="card">
            <p className="text-xs text-gray-400 mb-1">Transaction Summary</p>
            <div className="space-y-1 text-sm">
              <div className="flex justify-between">
                <span className="text-gray-500">To</span>
                <span className="font-mono text-xs truncate max-w-[200px]">{result.recipientAddress}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Amount</span>
                <span className="text-bitcoin font-medium">{formatSats(result.amountSats)}</span>
              </div>
            </div>
          </div>

          <p className="text-[10px] text-gray-600 text-center">
            Use the OP_RETURN hex when constructing your transaction via mempool.space, Sparrow, or any wallet that supports custom scripts.
          </p>

          <div className="space-y-2 mt-4">
            <button onClick={() => setResult(null)} className="btn-secondary w-full">
              New Transaction
            </button>
            <button onClick={onBack} className="btn-primary w-full">
              Done
            </button>
          </div>
        </div>
      ) : (
        <form onSubmit={handleSend} className="flex-1 flex flex-col space-y-3">
          {/* Note content + image */}
          <div>
            <label className="text-xs text-gray-400 mb-1 flex items-center justify-between">
              <span>Nostr Note (embedded on-chain via OP_RETURN)</span>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
                className="text-[10px] text-nostr hover:underline flex items-center gap-1"
              >
                {uploading ? <Loader2 className="w-2.5 h-2.5 animate-spin" /> : <Image className="w-2.5 h-2.5" />}
                Attach image
              </button>
            </label>
            <textarea
              value={noteContent}
              onChange={(e) => setNoteContent(e.target.value)}
              placeholder="Message to embed on-chain..."
              className="input-field h-20 resize-none text-sm"
            />
            <input ref={fileInputRef} type="file" accept="image/*" onChange={handleImageUpload} className="hidden" />

            {/* Image previews */}
            {noteImages.length > 0 && (
              <div className="flex gap-2 mt-2 flex-wrap">
                {noteImages.map((url) => (
                  <div key={url} className="relative w-12 h-12 rounded-lg overflow-hidden bg-surface-700">
                    <img src={url} alt="" className="w-full h-full object-cover" />
                    <button
                      type="button"
                      onClick={() => removeImage(url)}
                      className="absolute top-0.5 right-0.5 w-4 h-4 bg-red-500 rounded-full flex items-center justify-center"
                    >
                      <X className="w-2.5 h-2.5 text-white" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Recipient */}
          <div>
            <label className="text-xs text-gray-400 mb-1 block">Recipient Address</label>
            <input
              value={recipient}
              onChange={(e) => setRecipient(e.target.value)}
              placeholder="bc1p... or bc1q..."
              className="input-field text-sm font-mono"
            />
          </div>

          {/* Amount */}
          <div>
            <label className="text-xs text-gray-400 mb-1 flex items-center justify-between">
              <span>Amount (sats)</span>
              {balance > 0 && (
                <button
                  type="button"
                  onClick={() => setAmountSats(String(balance))}
                  className="text-[10px] text-bitcoin hover:underline"
                >
                  Max: {formatSats(balance)}
                </button>
              )}
            </label>
            <input
              type="number"
              value={amountSats}
              onChange={(e) => setAmountSats(e.target.value)}
              placeholder="10000"
              className="input-field text-sm"
            />
          </div>

          {/* Fee rate */}
          <div>
            <label className="text-xs text-gray-400 mb-1 block">Fee Rate (sat/vB)</label>
            <input
              type="number"
              value={feeRate}
              onChange={(e) => setFeeRate(e.target.value)}
              placeholder="5"
              className="input-field text-sm"
            />
            {feeEstimates && (
              <div className="flex gap-2 mt-2">
                <button
                  type="button"
                  onClick={() => setFeeRate(String(feeEstimates.fastest))}
                  className={`text-[10px] px-2 py-1 rounded-lg ${feeRate === String(feeEstimates.fastest) ? 'bg-red-500/20 text-red-400' : 'bg-surface-700 text-gray-400'}`}
                >
                  ⚡ {feeEstimates.fastest}
                </button>
                <button
                  type="button"
                  onClick={() => setFeeRate(String(feeEstimates.halfHour))}
                  className={`text-[10px] px-2 py-1 rounded-lg ${feeRate === String(feeEstimates.halfHour) ? 'bg-bitcoin/20 text-bitcoin' : 'bg-surface-700 text-gray-400'}`}
                >
                  30m: {feeEstimates.halfHour}
                </button>
                <button
                  type="button"
                  onClick={() => setFeeRate(String(feeEstimates.hour))}
                  className={`text-[10px] px-2 py-1 rounded-lg ${feeRate === String(feeEstimates.hour) ? 'bg-green-500/20 text-green-400' : 'bg-surface-700 text-gray-400'}`}
                >
                  1h: {feeEstimates.hour}
                </button>
                <button
                  type="button"
                  onClick={() => setFeeRate(String(feeEstimates.economy))}
                  className={`text-[10px] px-2 py-1 rounded-lg ${feeRate === String(feeEstimates.economy) ? 'bg-blue-500/20 text-blue-400' : 'bg-surface-700 text-gray-400'}`}
                >
                  Eco: {feeEstimates.economy}
                </button>
              </div>
            )}
          </div>

          {error && <p className="text-red-400 text-sm">{error}</p>}

          <div className="mt-auto pt-2">
            <button
              type="submit"
              disabled={!recipient || !amountSats || loading}
              className="btn-primary w-full flex items-center justify-center gap-2"
            >
              {loading ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Signing...
                </>
              ) : (
                <>
                  <Send className="w-4 h-4" />
                  Sign &amp; Build Transaction
                </>
              )}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
