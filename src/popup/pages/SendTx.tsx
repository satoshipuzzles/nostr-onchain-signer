import { useState, useEffect, useRef } from 'react';
import { createMessageId } from '@/shared/messages';
import { ArrowLeft, Send, Download, Loader2, Image, X, Copy, Check, FileDown, ExternalLink } from 'lucide-react';
import { fetchBalance, fetchFeeEstimates, formatSats, getMempoolAddressUrl } from '@/lib/bitcoin/mempool';
import { pubkeyToTaprootAddress } from '@/lib/bitcoin/address';
import { uploadFile, validateFile } from '@/lib/nostr/upload';
import { publishEvent } from '@/lib/nostr/discovery';
import { buildPsbt, downloadPsbtFile, downloadPsbtText, type PsbtResult } from '@/lib/bitcoin/psbt-builder';
import { encodeNostrOpReturn, encodeInvoiceOpReturn } from '@/lib/bitcoin/opreturn';

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
  const [psbtResult, setPsbtResult] = useState<PsbtResult | null>(null);
  const [noteId, setNoteId] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [notePublished, setNotePublished] = useState(false);
  const [copied, setCopied] = useState('');
  const [invoiceEventId, setInvoiceEventId] = useState('');
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
      if (bal.status === 'fulfilled') setBalance(bal.value.total);
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
    if (!validation.valid) { setError(validation.error || 'Invalid file'); return; }
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

  async function handleBuildPsbt(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const amount = parseInt(amountSats, 10);
      if (!amount || amount <= 0) throw new Error('Enter a valid amount');
      if (!recipient) throw new Error('Enter a recipient address');

      let opReturnData: Uint8Array | undefined;

      // If there's a note, sign it and create OP_RETURN
      if (noteContent.trim()) {
        let fullContent = noteContent;
        if (noteImages.length > 0) fullContent += '\n' + noteImages.join('\n');

        // Sign the note via background/mock
        const response = await chrome.runtime.sendMessage({
          type: 'nip07:signEvent',
          payload: {
            event: {
              kind: 1,
              content: fullContent,
              tags: noteImages.map((url) => ['image', url]),
              created_at: Math.floor(Date.now() / 1000),
            },
          },
          id: createMessageId(),
        });

        if (response.error) throw new Error(response.error);
        const signedNote = response.result;
        setNoteId(signedNote.id);

        // Encode event ID into OP_RETURN payload (without OP_RETURN opcode prefix)
        const opReturn = encodeNostrOpReturn({
          eventId: signedNote.id,
          kind: signedNote.kind,
          content: fullContent,
        });
        // opReturn.script includes OP_RETURN + push + payload
        // For the PSBT builder, pass just the payload (skip first 2 bytes: 0x6a + push len)
        opReturnData = opReturn.script.slice(2);
      }

      // If paying an invoice, use the invoice OP_RETURN instead (takes precedence if no note)
      if (!opReturnData && invoiceEventId.trim()) {
        const invoiceOpReturn = encodeInvoiceOpReturn(invoiceEventId.trim());
        opReturnData = invoiceOpReturn.script.slice(2);
      }

      const result = await buildPsbt({
        fromAddress: address,
        toAddress: recipient,
        amountSats: amount,
        feeRate: parseFloat(feeRate) || undefined,
        internalPubkeyHex: publicKey,
        opReturnData,
      });

      setPsbtResult(result);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to build transaction');
    } finally {
      setLoading(false);
    }
  }

  async function handlePublishNote() {
    if (!noteId) return;
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'nip07:signEvent',
        payload: {
          event: {
            kind: 1,
            content: noteContent + (noteImages.length ? '\n' + noteImages.join('\n') : ''),
            tags: noteImages.map((url) => ['image', url]),
            created_at: Math.floor(Date.now() / 1000),
          },
        },
        id: createMessageId(),
      });
      if (!response.error && response.result) {
        const pubResult = await publishEvent(response.result);
        if (pubResult.success.length > 0) setNotePublished(true);
        else setError('Failed to reach relays');
      }
    } catch { setError('Failed to publish note'); }
  }

  async function copyText(text: string, label: string) {
    await navigator.clipboard.writeText(text);
    setCopied(label);
    setTimeout(() => setCopied(''), 2000);
  }

  // ─── RESULT VIEW ─────────────────────────────────────────────

  if (psbtResult) {
    return (
    <div className="h-full flex flex-col p-4 overflow-y-auto pb-24 md:pb-4">
      <div className="page-header">
        <button onClick={() => setPsbtResult(null)} className="btn-back">
            <ArrowLeft className="w-5 h-5" />
          </button>
          <h1>PSBT Ready</h1>
        </div>

        {/* Summary */}
        <div className="card mb-3">
          <div className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-gray-500">Send</span>
              <span className="text-bitcoin font-semibold">{formatSats(parseInt(amountSats))}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-500">Fee</span>
              <span className="text-gray-300">{formatSats(psbtResult.fee)} ({feeRate} sat/vB)</span>
            </div>
            {psbtResult.changeSats > 0 && (
              <div className="flex justify-between">
                <span className="text-gray-500">Change</span>
                <span className="text-gray-300">{formatSats(psbtResult.changeSats)}</span>
              </div>
            )}
            <div className="flex justify-between">
              <span className="text-gray-500">Inputs</span>
              <span className="text-gray-300">{psbtResult.inputCount} UTXO{psbtResult.inputCount > 1 ? 's' : ''}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-500">Size</span>
              <span className="text-gray-300">~{psbtResult.vsize} vB</span>
            </div>
          </div>
        </div>

        {/* Nostr Note */}
        {noteId && (
          <div className="card mb-3 border-nostr/20">
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs text-nostr font-medium">Nostr Note (OP_RETURN)</span>
              {notePublished && <span className="text-[10px] text-green-400">Published</span>}
            </div>
            <code className="text-[10px] text-gray-500 break-all block">
              {noteId}
            </code>
            {!notePublished && (
              <button onClick={handlePublishNote} className="text-xs text-nostr hover:underline mt-2">
                Publish note to relays
              </button>
            )}
          </div>
        )}

        {/* Download actions */}
        <div className="space-y-2 mb-4">
          <button
            onClick={() => downloadPsbtFile(psbtResult.psbtBase64)}
            className="btn-primary w-full flex items-center justify-center gap-2"
          >
            <FileDown className="w-4 h-4" />
            Download .psbt for Sparrow
          </button>

          <button
            onClick={() => downloadPsbtText(psbtResult.psbtBase64)}
            className="btn-secondary w-full flex items-center justify-center gap-2"
          >
            <Download className="w-4 h-4" />
            Download as Base64 Text
          </button>
        </div>

        {/* Copy options */}
        <div className="space-y-2">
          <button
            onClick={() => copyText(psbtResult.psbtBase64, 'base64')}
            className="w-full flex items-center gap-2 px-3 py-2.5 rounded-xl bg-surface-800/50 hover:bg-surface-700 transition-colors"
          >
            {copied === 'base64' ? <Check className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4 text-gray-400" />}
            <span className="text-sm text-gray-300">Copy PSBT (Base64)</span>
          </button>

          <button
            onClick={() => copyText(psbtResult.psbtHex, 'hex')}
            className="w-full flex items-center gap-2 px-3 py-2.5 rounded-xl bg-surface-800/50 hover:bg-surface-700 transition-colors"
          >
            {copied === 'hex' ? <Check className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4 text-gray-400" />}
            <span className="text-sm text-gray-300">Copy PSBT (Hex)</span>
          </button>
        </div>

        <p className="text-[10px] text-gray-600 text-center mt-4">
          Open Sparrow Wallet → File → Open Transaction → paste or load the .psbt file → Sign → Broadcast
        </p>

        <div className="mt-4">
          <button onClick={() => { setPsbtResult(null); setNoteId(''); setNotePublished(false); }} className="btn-secondary w-full">
            Build Another
          </button>
        </div>
      </div>
    );
  }

  // ─── BUILD FORM ──────────────────────────────────────────────

  return (
    <div className="h-full flex flex-col p-4 overflow-y-auto pb-24 md:pb-4">
      <div className="page-header">
        <button onClick={onBack} className="btn-back">
          <ArrowLeft className="w-5 h-5" />
        </button>
        <h1>Transaction Builder</h1>
        {loadingBalance ? (
          <Loader2 className="w-3 h-3 animate-spin text-gray-500" />
        ) : (
          <span className="text-xs text-bitcoin font-medium">{formatSats(balance)}</span>
        )}
      </div>

      {/* From address */}
      <div className="card mb-3 flex items-center gap-2">
        <div className="flex-1 min-w-0">
          <p className="text-[10px] text-gray-500">From (your Taproot address)</p>
          <p className="text-xs font-mono text-gray-300 truncate">{address}</p>
        </div>
        <a href={getMempoolAddressUrl(address)} target="_blank" rel="noopener" className="btn-icon flex-shrink-0">
          <ExternalLink className="w-3.5 h-3.5 text-gray-500" />
        </a>
      </div>

      <form onSubmit={handleBuildPsbt} className="flex-1 flex flex-col space-y-3">
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
              <button type="button" onClick={() => setAmountSats(String(balance))} className="text-[10px] text-bitcoin hover:underline">
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
            <div className="flex gap-2 mt-2 flex-wrap">
              {[
                { label: '⚡', rate: feeEstimates.fastest, color: 'red' },
                { label: '30m', rate: feeEstimates.halfHour, color: 'bitcoin' },
                { label: '1h', rate: feeEstimates.hour, color: 'green' },
                { label: 'Eco', rate: feeEstimates.economy, color: 'blue' },
              ].map(({ label, rate, color }) => (
                <button
                  key={label}
                  type="button"
                  onClick={() => setFeeRate(String(rate))}
                  className={`text-[10px] px-2.5 py-1.5 rounded-lg font-medium ${
                    feeRate === String(rate)
                      ? `bg-${color}-500/20 text-${color}-400 border border-${color}-500/40`
                      : 'bg-surface-700 text-gray-400'
                  }`}
                >
                  {label}: {rate}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Optional Nostr note */}
        <div>
          <label className="text-xs text-gray-400 mb-1 flex items-center justify-between">
            <span>Nostr Note (optional, embedded via OP_RETURN)</span>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              className="text-[10px] text-nostr hover:underline flex items-center gap-1"
            >
              {uploading ? <Loader2 className="w-2.5 h-2.5 animate-spin" /> : <Image className="w-2.5 h-2.5" />}
              Image
            </button>
          </label>
          <textarea
            value={noteContent}
            onChange={(e) => setNoteContent(e.target.value)}
            placeholder="Optional message to embed on-chain..."
            className="input-field h-16 resize-none text-sm"
          />
          <input ref={fileInputRef} type="file" accept="image/*" onChange={handleImageUpload} className="hidden" />
          {noteImages.length > 0 && (
            <div className="flex gap-2 mt-2 flex-wrap">
              {noteImages.map((url) => (
                <div key={url} className="relative w-10 h-10 rounded-lg overflow-hidden bg-surface-700">
                  <img src={url} alt="" className="w-full h-full object-cover" />
                  <button type="button" onClick={() => setNoteImages((prev) => prev.filter((u) => u !== url))} className="absolute top-0 right-0 w-4 h-4 bg-red-500 rounded-full flex items-center justify-center">
                    <X className="w-2 h-2 text-white" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Optional invoice reference */}
        <div>
          <label className="text-xs text-gray-400 mb-1 block">Paying Invoice (optional, event ID)</label>
          <input
            value={invoiceEventId}
            onChange={(e) => setInvoiceEventId(e.target.value)}
            placeholder="Paste a kind 9733 invoice event ID..."
            className="input-field text-sm font-mono"
          />
          <p className="text-[10px] text-gray-600 mt-1">
            Links this payment to an onchain invoice via OP_RETURN
          </p>
        </div>

        {error && <p className="text-red-400 text-sm">{error}</p>}

        <div className="mt-auto pt-3">
          <button
            type="submit"
            disabled={!recipient || !amountSats || loading}
            className="btn-primary w-full flex items-center justify-center gap-2"
          >
            {loading ? (
              <><Loader2 className="w-4 h-4 animate-spin" /> Building PSBT...</>
            ) : (
              <><Send className="w-4 h-4" /> Build PSBT</>
            )}
          </button>
          <p className="text-[10px] text-gray-600 text-center mt-2">
            Generates an unsigned PSBT you can sign in Sparrow Wallet
          </p>
        </div>
      </form>
    </div>
  );
}
