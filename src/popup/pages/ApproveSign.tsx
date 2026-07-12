import { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ShieldCheck, X, Loader2, Ban } from 'lucide-react';
import { createMessageId } from '@/shared/messages';
import { pubkeyToNpub } from '@/lib/nostr/keys';

const ACTION_LABELS: Record<string, string> = {
  'nip07:getPublicKey': 'Connect (share public key)',
  'nip07:signEvent': 'Sign Nostr event',
  'nip07:signSchnorr': 'Sign Bitcoin sighash',
  'nip07:nip04:encrypt': 'Encrypt message',
  'nip07:nip04:decrypt': 'Decrypt message',
  'nip07:nip44:encrypt': 'Encrypt message (NIP-44)',
  'nip07:nip44:decrypt': 'Decrypt message (NIP-44)',
  'btc:getAddress': 'Share Bitcoin address',
  'btc:signPsbt': 'Sign & finalize PSBT',
  'btc:signPsbtPartial': 'Partial-sign PSBT',
};

export function ApproveSign() {
  const [params] = useSearchParams();
  const approvalId = params.get('approval') || params.get('id') || '';
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [origin, setOrigin] = useState('');
  const [action, setAction] = useState('');
  const [preview, setPreview] = useState('');
  const [pubkey, setPubkey] = useState('');
  const [busy, setBusy] = useState(false);
  const [remember, setRemember] = useState(false);

  useEffect(() => {
    loadPending();
  }, [approvalId]);

  async function loadPending() {
    if (!approvalId) {
      setError('Missing approval id');
      setLoading(false);
      return;
    }
    try {
      const res = await chrome.runtime.sendMessage({
        type: 'approval:get',
        payload: { approvalId },
        id: createMessageId(),
      });
      if (res.error) {
        setError(res.error);
      } else {
        const p = res.result;
        setOrigin(p.origin || 'Unknown site');
        setAction(p.type || 'sign');
        setPreview(p.preview || '');
        setPubkey(p.pubkey || '');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load request');
    } finally {
      setLoading(false);
    }
  }

  async function respond(approved: boolean, block = false) {
    setBusy(true);
    try {
      await chrome.runtime.sendMessage({
        type: approved ? 'approval:confirm' : 'approval:reject',
        payload: approved ? { approvalId, remember } : { approvalId, block },
        id: createMessageId(),
      });
      window.close();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <div className="min-h-[480px] flex items-center justify-center p-6 bg-surface-900">
        <Loader2 className="w-6 h-6 animate-spin text-bitcoin" />
      </div>
    );
  }

  return (
    <div className="min-h-[480px] max-h-[600px] flex flex-col bg-surface-900 text-white overflow-hidden">
      {/* Header — fixed */}
      <div className="flex-shrink-0 flex items-center justify-between p-4 border-b border-surface-200/10">
        <div className="flex items-center gap-2">
          <ShieldCheck className="w-5 h-5 text-bitcoin" />
          <h1 className="text-base font-bold">Approve Signing</h1>
        </div>
        <button
          onClick={() => respond(false)}
          disabled={busy}
          className="p-1.5 hover:bg-surface-700 rounded-lg transition-colors"
        >
          <X className="w-4 h-4 text-gray-400" />
        </button>
      </div>

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto p-4 min-h-0">
        {error ? (
          <p className="text-red-400 text-sm">{error}</p>
        ) : (
          <>
            <p className="text-xs text-gray-400 mb-2 break-all">
              <span className="text-gray-500">Site:</span> {origin}
            </p>
            <p className="text-xs text-gray-400 mb-2">
              <span className="text-gray-500">Action:</span> {ACTION_LABELS[action] || action}
            </p>
            {pubkey && (
              <p className="text-xs font-mono text-bitcoin mb-3 truncate">
                {pubkeyToNpub(pubkey).slice(0, 28)}...
              </p>
            )}
            {preview && (
              <div className="bg-surface-800 rounded-lg p-3">
                <p className="text-xs text-gray-300 whitespace-pre-wrap break-words">{preview}</p>
              </div>
            )}

            <label className="flex items-center gap-2 mt-4 cursor-pointer">
              <input
                type="checkbox"
                checked={remember}
                onChange={(e) => setRemember(e.target.checked)}
                className="w-4 h-4 rounded accent-bitcoin"
              />
              <span className="text-xs text-gray-400">
                Always allow this site (skip future prompts)
              </span>
            </label>
          </>
        )}
      </div>

      {/* Buttons — always pinned at bottom */}
      {!error && (
        <div className="flex-shrink-0 p-4 border-t border-surface-200/10 bg-surface-900 space-y-2">
          <div className="flex gap-2">
            <button
              onClick={() => respond(false)}
              disabled={busy}
              className="btn-secondary flex-1 flex items-center justify-center gap-1"
            >
              <X className="w-4 h-4" /> Deny
            </button>
            <button
              onClick={() => respond(true)}
              disabled={busy}
              className="btn-primary flex-1"
            >
              {busy ? 'Working...' : remember ? 'Allow & Remember' : 'Allow Once'}
            </button>
          </div>
          <button
            onClick={() => respond(false, true)}
            disabled={busy}
            className="w-full flex items-center justify-center gap-1.5 text-[11px] text-red-400/80 hover:text-red-300 transition-colors py-1"
          >
            <Ban className="w-3.5 h-3.5" /> Block this site
          </button>
        </div>
      )}
    </div>
  );
}
