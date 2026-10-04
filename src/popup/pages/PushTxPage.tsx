import { useEffect, useState } from 'react';
import { Loader2, CheckCircle2, AlertTriangle, ExternalLink, Radio } from 'lucide-react';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { base64urlnopad } from '@scure/base';
import * as btc from '@scure/btc-signer';
import { broadcastTransaction, getMempoolTxUrl } from '@/lib/bitcoin/mempool';
import { type Chain } from '@/lib/bitcoin/chain';

/**
 * PushTx landing page: a hardware signer (the Q Signer firmware on a Coldcard
 * Q) shows this link over NFC or as a QR after signing. The signed
 * transaction rides in the URL fragment, so it never reaches server logs:
 *
 *   /pushtx#t=<base64url tx>&c=<base64url last 8 bytes of sha256(tx)>&chain=xbt|btc
 *
 * `c` catches a truncated tap. The page broadcasts at once (the user already
 * approved on the device) and shows the result.
 */

interface Parsed {
  hex: string;
  txid: string;
  chain: Chain;
  outputs: { address: string; sats: bigint }[];
  /** Every input carries a 65-byte SIGHASH_UNIFIED (0x21) signature. */
  unified: boolean;
}

function parse(fragment: string): Parsed {
  const q = new URLSearchParams(fragment.replace(/^#/, ''));
  const t = q.get('t');
  const c = q.get('c');
  if (!t || !c) throw new Error('This link is incomplete: it has no transaction. Tap the device again.');
  const raw = base64urlnopad.decode(t);
  const check = base64urlnopad.decode(c);
  const digest = sha256(raw);
  if (bytesToHex(digest.slice(24)) !== bytesToHex(check)) {
    throw new Error('The link was cut short during the tap. Hold the phone still and tap again.');
  }
  const chain: Chain = q.get('chain') === 'btc' ? 'btc' : 'xbt';
  const tx = btc.Transaction.fromRaw(raw, { allowUnknownOutputs: true, allowUnknownInputs: true, disableScriptCheck: true });
  const outputs = [];
  for (let i = 0; i < tx.outputsLength; i++) {
    const o = tx.getOutput(i);
    let address = 'non-standard output';
    try {
      address = btc.Address(btc.NETWORK).encode(btc.OutScript.decode(o.script!));
    } catch {
      if (o.script && o.script[0] === 0x6a) address = 'data (OP_RETURN)';
    }
    outputs.push({ address, sats: o.amount ?? 0n });
  }
  let unified = tx.inputsLength > 0;
  for (let i = 0; i < tx.inputsLength; i++) {
    const w = tx.getInput(i).finalScriptWitness ?? [];
    const sigs = w.filter((item) => item.length === 65);
    if (sigs.length === 0 || !sigs.every((s) => s[64] === 0x21)) unified = false;
  }
  return { hex: bytesToHex(raw), txid: tx.id, chain, outputs, unified };
}

function formatAmount(sats: bigint): string {
  const s = sats.toString().padStart(9, '0');
  const whole = s.slice(0, -8);
  const frac = s.slice(-8).replace(/0+$/, '').padEnd(2, '0');
  return `${whole}.${frac}`;
}

type Status = { kind: 'sending' } | { kind: 'sent'; txid: string } | { kind: 'failed'; message: string };

export function PushTxPage() {
  const [parsed, setParsed] = useState<Parsed | null>(null);
  const [error, setError] = useState('');
  const [status, setStatus] = useState<Status | null>(null);

  async function send(p: Parsed) {
    if (p.unified && p.chain === 'btc') {
      setStatus({ kind: 'failed', message: 'These signatures are XBT-only (SIGHASH_UNIFIED). Spam coin (BTC) nodes will reject them.' });
      return;
    }
    setStatus({ kind: 'sending' });
    try {
      const txid = await broadcastTransaction(p.hex, p.chain);
      setStatus({ kind: 'sent', txid });
    } catch (e) {
      let msg = e instanceof Error ? e.message : String(e);
      try {
        const j = JSON.parse(msg);
        if (typeof j?.error === 'string') msg = j.error;
      } catch {
        /* plain text */
      }
      // Already known means a previous tap went through.
      if (/already|txn-mempool-conflict|known/i.test(msg)) setStatus({ kind: 'sent', txid: p.txid });
      else setStatus({ kind: 'failed', message: msg });
    }
  }

  useEffect(() => {
    try {
      const p = parse(window.location.hash);
      setParsed(p);
      void send(p);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const label = parsed ? (parsed.chain === 'xbt' ? 'Bitcoin (XBT)' : 'Spam coin (BTC)') : '';
  const ticker = parsed?.chain === 'btc' ? 'BTC' : 'XBT';

  return (
    <div className="h-screen overflow-y-auto bg-surface-900">
      <div className="min-h-full flex items-center justify-center p-4 pb-20">
        <div className="w-full max-w-sm bg-surface-800 rounded-2xl p-6 border border-surface-200/10">
          <div className="text-center mb-5">
            <Radio className="w-9 h-9 text-bitcoin mx-auto mb-2" />
            <h1 className="text-lg font-bold text-white">Broadcast</h1>
            {parsed && <p className="text-gray-400 text-sm mt-1">to {label}</p>}
          </div>

          {error && (
            <div className="flex gap-2 text-red-400 text-sm">
              <AlertTriangle className="w-5 h-5 shrink-0" />
              <p>{error}</p>
            </div>
          )}

          {parsed && (
            <>
              <div className="space-y-3 mb-5">
                {parsed.outputs.map((o, i) => (
                  <div key={i} className="bg-surface-700 rounded-xl p-3">
                    <div className="text-white font-semibold">
                      {formatAmount(o.sats)} {ticker}
                    </div>
                    <div className="text-gray-400 text-xs break-all mt-1 font-mono">{o.address}</div>
                  </div>
                ))}
              </div>
              <p className="text-xs text-gray-400 mb-4">
                {parsed.unified
                  ? 'Signed with SIGHASH_UNIFIED: valid on Bitcoin (XBT) only, it cannot be replayed on Spam coin (BTC).'
                  : 'Legacy signatures: valid on both chains if these coins were never split.'}
              </p>

              {status?.kind === 'sending' && (
                <div className="flex items-center gap-2 text-gray-300 text-sm">
                  <Loader2 className="w-4 h-4 animate-spin" /> Sending to {label}…
                </div>
              )}
              {status?.kind === 'sent' && (
                <div className="space-y-3">
                  <div className="flex items-center gap-2 text-green-400 text-sm font-medium">
                    <CheckCircle2 className="w-5 h-5" /> Sent. It is in the mempool.
                  </div>
                  <a
                    href={getMempoolTxUrl(status.txid, parsed.chain)}
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center gap-1 text-bitcoin text-sm break-all"
                  >
                    {status.txid.slice(0, 16)}…{status.txid.slice(-8)} <ExternalLink className="w-4 h-4 shrink-0" />
                  </a>
                </div>
              )}
              {status?.kind === 'failed' && (
                <div className="space-y-3">
                  <div className="flex gap-2 text-red-400 text-sm">
                    <AlertTriangle className="w-5 h-5 shrink-0" />
                    <p className="break-words">Not accepted: {status.message}</p>
                  </div>
                  <button
                    onClick={() => void send(parsed)}
                    className="w-full py-3 bg-bitcoin text-black rounded-xl font-medium text-sm hover:bg-bitcoin/90 transition-colors"
                  >
                    Try again
                  </button>
                </div>
              )}
              <p className="text-[11px] text-gray-500 mt-5 break-all font-mono">txid {parsed.txid}</p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
