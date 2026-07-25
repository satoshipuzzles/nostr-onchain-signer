import { useEffect, useMemo, useState } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { ArrowLeft, Download, Copy, Check, Share2, PenLine, Radio, History, Trash2 } from 'lucide-react';
import { base64 } from '@scure/base';
import { psbtToDoc, parseAnyPsbt, type PsbtDoc } from '@nostr-onchain/core';
import { getDoc, updateDoc, deleteDoc, renameDoc, type WalletDoc } from '../lib/storage';
import { getAccounts, type VaultAccount } from '../lib/vault';
import { signWithAccount, broadcastTx, formatSats } from '../lib/wallet';

type Tab = 'preview' | 'json' | 'raw' | 'history';

export function FileEditor() {
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation() as { state?: { accountId?: string } };
  const [doc, setDoc] = useState<WalletDoc | null>(null);
  const [tab, setTab] = useState<Tab>('preview');
  const [rawEdit, setRawEdit] = useState('');
  const [copied, setCopied] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [broadcastResult, setBroadcastResult] = useState('');
  const [signedTxHex, setSignedTxHex] = useState('');

  useEffect(() => {
    getDoc(id ?? '').then((d) => {
      setDoc(d ?? null);
      if (d) setRawEdit(d.data);
    });
  }, [id]);

  const psbtDoc: PsbtDoc | { error: string } | null = useMemo(() => {
    if (!doc || doc.kind !== 'psbt') return null;
    try {
      return psbtToDoc(doc.data);
    } catch (err) {
      return { error: err instanceof Error ? err.message : 'Unparseable PSBT' };
    }
  }, [doc]);

  if (!doc) {
    return <div className="text-stone-400 text-sm">Loading…</div>;
  }

  const isPsbt = doc.kind === 'psbt';
  const parsed = psbtDoc && !('error' in psbtDoc) ? psbtDoc : null;

  function copy(text: string) {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  function download(filename: string, data: Uint8Array | string, mime: string) {
    const payload: BlobPart = typeof data === 'string' ? data : (data.slice().buffer as ArrayBuffer);
    const blob = new Blob([payload], { type: mime });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  async function share() {
    if (!doc) return;
    const text = doc.data;
    if (navigator.share) {
      try {
        await navigator.share({ title: doc.name, text });
        return;
      } catch {
        // user cancelled or unsupported payload — fall back to clipboard
      }
    }
    copy(text);
    setStatus('Copied to clipboard for sharing');
  }

  async function saveRaw() {
    if (!doc) return;
    setError('');
    try {
      if (isPsbt) {
        const bytes = parseAnyPsbt(rawEdit.trim());
        const updated = await updateDoc(doc.id, base64.encode(bytes), 'Manual edit');
        setDoc({ ...updated });
      } else {
        if (doc.kind === 'wallet') JSON.parse(rawEdit); // must stay valid JSON
        const updated = await updateDoc(doc.id, rawEdit, 'Manual edit');
        setDoc({ ...updated });
      }
      setStatus('Saved');
      setTimeout(() => setStatus(''), 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invalid content');
    }
  }

  async function handleSign(account: VaultAccount) {
    if (!doc) return;
    setError('');
    setBusy(true);
    try {
      const { txHex, txid } = signWithAccount(doc.data, account);
      setSignedTxHex(txHex);
      setStatus(`Signed & finalized — txid ${txid.slice(0, 16)}…`);
      await updateDoc(doc.id, doc.data, `Signed by ${account.label}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Signing failed');
    } finally {
      setBusy(false);
    }
  }

  async function handleBroadcast() {
    setError('');
    setBusy(true);
    try {
      const txid = await broadcastTx(signedTxHex);
      setBroadcastResult(txid);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Broadcast failed');
    } finally {
      setBusy(false);
    }
  }

  const signerAccounts = getAccounts().filter((a) => !a.watchOnly);
  const preferredSigner =
    signerAccounts.find((a) => a.id === location.state?.accountId) ??
    signerAccounts.find((a) => parsed?.inputs.some((i) => i.tapInternalKey === a.publicKeyHex)) ??
    signerAccounts[0];

  return (
    <div className="space-y-4">
      <header className="flex items-center gap-3">
        <button className="btn-ghost" onClick={() => navigate('/files')} aria-label="Back">
          <ArrowLeft size={18} />
        </button>
        <input
          className="bg-transparent font-bold text-lg flex-1 min-w-0 focus:outline-none focus:border-b focus:border-accent"
          value={doc.name}
          onChange={(e) => setDoc({ ...doc, name: e.target.value })}
          onBlur={() => renameDoc(doc.id, doc.name)}
        />
        <button
          className="btn-ghost text-red-400"
          onClick={async () => {
            if (window.confirm('Delete this file?')) {
              await deleteDoc(doc.id);
              navigate('/files');
            }
          }}
        >
          <Trash2 size={16} />
        </button>
      </header>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-stone-800 text-sm">
        {(
          [
            ['preview', 'Preview'],
            ['json', 'JSON'],
            ['raw', 'Raw'],
            ['history', `History (${doc.revisions.length})`],
          ] as [Tab, string][]
        ).map(([t, labelText]) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-3 py-2 font-medium ${tab === t ? 'text-accent border-b-2 border-accent' : 'text-stone-400'}`}
          >
            {labelText}
          </button>
        ))}
      </div>

      {/* Preview */}
      {tab === 'preview' && isPsbt && parsed && (
        <div className="space-y-3">
          <div className="card grid grid-cols-2 gap-3 text-sm">
            <div><div className="text-xs text-stone-500">Inputs</div>{parsed.inputCount} ({parsed.totalInputSats !== null ? formatSats(parsed.totalInputSats) : '?'})</div>
            <div><div className="text-xs text-stone-500">Outputs</div>{parsed.outputCount} ({formatSats(parsed.totalOutputSats)})</div>
            <div><div className="text-xs text-stone-500">Fee</div>{parsed.feeSats !== null ? formatSats(parsed.feeSats) : 'unknown'}</div>
            <div><div className="text-xs text-stone-500">Status</div>{parsed.fullySigned ? <span className="text-green-400">Signed</span> : <span className="text-amber-400">Unsigned</span>}</div>
            <div><div className="text-xs text-stone-500">Version / locktime</div>v{parsed.txVersion} / {parsed.locktime}</div>
            <div><div className="text-xs text-stone-500">RBF</div>{parsed.inputs.some((i) => i.rbfSignaled) ? 'Yes' : 'No'}</div>
          </div>

          <div className="space-y-2">
            <h3 className="text-xs uppercase tracking-wide text-stone-500 font-medium">Inputs</h3>
            {parsed.inputs.map((inp) => (
              <div key={inp.index} className="card py-3 text-xs space-y-1">
                <div className="font-mono text-stone-400 break-all">{inp.txid.slice(0, 32)}…:{inp.vout}</div>
                <div className="flex justify-between">
                  <span>{inp.address ? `${inp.address.slice(0, 20)}…` : inp.type}</span>
                  <span className="font-semibold">{inp.amountSats !== null ? formatSats(inp.amountSats) : '?'}</span>
                </div>
                <div className={inp.signed ? 'text-green-400' : 'text-stone-500'}>{inp.signed ? `✓ ${inp.signatures} signature(s)` : 'awaiting signature'}</div>
              </div>
            ))}
            <h3 className="text-xs uppercase tracking-wide text-stone-500 font-medium">Outputs</h3>
            {parsed.outputs.map((out) => (
              <div key={out.index} className="card py-3 text-xs space-y-1">
                {out.type === 'op_return' ? (
                  <>
                    <div className="flex justify-between">
                      <span className="text-purple-300 font-semibold">OP_RETURN ({out.opReturn?.protocol})</span>
                      <span className={out.opReturn?.bip110Compliant ? 'text-green-400' : 'text-amber-400'}>
                        {out.opReturn?.scriptSize}B {out.opReturn?.bip110Compliant ? '· BIP-110 ok' : '· main chain only post-fork'}
                      </span>
                    </div>
                    {out.opReturn?.payloadText ? (
                      <div className="text-stone-300 break-words">“{out.opReturn.payloadText}”</div>
                    ) : (
                      <div className="font-mono text-stone-400 break-all">{out.opReturn?.payloadHex}</div>
                    )}
                  </>
                ) : (
                  <div className="flex justify-between">
                    <span className="font-mono text-stone-400 break-all mr-3">{out.address ?? out.scriptHex.slice(0, 24)}</span>
                    <span className="font-semibold shrink-0">{formatSats(out.amountSats)}</span>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
      {tab === 'preview' && isPsbt && psbtDoc && 'error' in psbtDoc && <p className="text-red-400 text-sm">{psbtDoc.error}</p>}
      {tab === 'preview' && !isPsbt && (
        <pre className="card text-xs font-mono whitespace-pre-wrap break-all max-h-[50vh] overflow-y-auto">{doc.data}</pre>
      )}

      {/* JSON */}
      {tab === 'json' && (
        <pre className="card text-xs font-mono whitespace-pre-wrap break-all max-h-[55vh] overflow-y-auto">
          {isPsbt && parsed ? JSON.stringify(parsed, null, 2) : doc.data}
        </pre>
      )}

      {/* Raw editor */}
      {tab === 'raw' && (
        <div className="space-y-2">
          <textarea className="input font-mono text-xs" rows={10} value={rawEdit} onChange={(e) => setRawEdit(e.target.value)} />
          <div className="flex gap-2">
            <button className="btn-primary text-xs" onClick={saveRaw}>
              <PenLine size={14} /> Save revision
            </button>
            <button className="btn-secondary text-xs" onClick={() => copy(rawEdit)}>
              {copied ? <Check size={14} /> : <Copy size={14} />} Copy
            </button>
          </div>
          <p className="text-xs text-stone-500">
            {isPsbt ? 'Paste a PSBT in base64 or hex (e.g. one a co-signer returned) and save — history keeps every version.' : 'Edit and save — every save is a revision.'}
          </p>
        </div>
      )}

      {/* History */}
      {tab === 'history' && (
        <div className="space-y-2">
          {[...doc.revisions].reverse().map((rev, i) => (
            <div key={rev.at} className="card py-3 text-xs flex items-center justify-between">
              <div>
                <div className="font-medium">{rev.note ?? 'Revision'}</div>
                <div className="text-stone-500">{new Date(rev.at).toLocaleString()}</div>
              </div>
              {i !== 0 && (
                <button
                  className="btn-secondary text-xs"
                  onClick={async () => {
                    const updated = await updateDoc(doc.id, rev.data, `Restored revision from ${new Date(rev.at).toLocaleString()}`);
                    setDoc({ ...updated });
                    setRawEdit(rev.data);
                  }}
                >
                  <History size={13} /> Restore
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Status / errors */}
      {status && <p className="text-green-400 text-sm">{status}</p>}
      {error && <p className="text-red-400 text-sm">{error}</p>}
      {broadcastResult && (
        <div className="card border-green-700 text-sm">
          Broadcast!{' '}
          <a className="text-accent underline" href={`https://mempool.space/tx/${broadcastResult}`} target="_blank" rel="noreferrer">
            {broadcastResult.slice(0, 24)}…
          </a>
        </div>
      )}

      {/* Actions */}
      <div className="flex flex-wrap gap-2 pt-1">
        {isPsbt && preferredSigner && !signedTxHex && (
          <button className="btn-primary text-xs" onClick={() => handleSign(preferredSigner)} disabled={busy}>
            <PenLine size={14} /> Sign with {preferredSigner.label}
          </button>
        )}
        {signedTxHex && !broadcastResult && (
          <button className="btn-primary text-xs" onClick={handleBroadcast} disabled={busy}>
            <Radio size={14} /> Broadcast
          </button>
        )}
        {isPsbt && (
          <>
            <button className="btn-secondary text-xs" onClick={() => download(`${doc.name}.psbt`, base64.decode(doc.data), 'application/octet-stream')}>
              <Download size={14} /> .psbt
            </button>
            <button className="btn-secondary text-xs" onClick={() => download(`${doc.name}.psbt.txt`, doc.data, 'text/plain')}>
              <Download size={14} /> base64
            </button>
            {parsed && (
              <button className="btn-secondary text-xs" onClick={() => download(`${doc.name}.json`, JSON.stringify(parsed, null, 2), 'application/json')}>
                <Download size={14} /> JSON
              </button>
            )}
          </>
        )}
        {!isPsbt && (
          <button className="btn-secondary text-xs" onClick={() => download(`${doc.name}.${doc.kind === 'wallet' ? 'json' : 'txt'}`, doc.data, 'text/plain')}>
            <Download size={14} /> Download
          </button>
        )}
        <button className="btn-secondary text-xs" onClick={share}>
          <Share2 size={14} /> Share
        </button>
      </div>
    </div>
  );
}
