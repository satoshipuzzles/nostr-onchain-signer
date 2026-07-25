import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Plus, Trash2, Hammer, Zap } from 'lucide-react';
import {
  encodeCustomOpReturn,
  checkOpReturnCompliance,
  estimateVsize,
  opReturnScriptSize,
  type EsploraUtxo,
  type FeeEstimates,
} from '@nostr-onchain/core';
import { getAccounts, accountAddress, type VaultAccount } from '../lib/vault';
import { esplora, resolveRecipient, buildWalletTx, formatSats, type ResolvedRecipient } from '../lib/wallet';
import { loadSettings } from '../lib/storage';
import { createDoc } from '../lib/storage';

interface RecipientRow {
  raw: string;
  amount: string;
  resolved?: ResolvedRecipient;
  error?: string;
}

export function Builder() {
  const navigate = useNavigate();
  const location = useLocation() as { state?: { accountId?: string; recipient?: string } };
  const accounts = getAccounts();
  const network = loadSettings().network;

  const [accountId, setAccountId] = useState(location.state?.accountId ?? accounts[0]?.id ?? '');
  const account: VaultAccount | undefined = accounts.find((a) => a.id === accountId);

  const [utxos, setUtxos] = useState<EsploraUtxo[]>([]);
  const [selectedCoins, setSelectedCoins] = useState<Set<string>>(new Set());
  const [autoCoins, setAutoCoins] = useState(true);
  const [recipients, setRecipients] = useState<RecipientRow[]>([
    { raw: location.state?.recipient ?? '', amount: '' },
  ]);
  const [dataInput, setDataInput] = useState('');
  const [dataFormat, setDataFormat] = useState<'text' | 'hex'>('text');
  const [feeEstimates, setFeeEstimates] = useState<FeeEstimates | null>(null);
  const [feeRate, setFeeRate] = useState('');
  const [rbf, setRbf] = useState(true);
  const [locktime, setLocktime] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!account) return;
    const client = esplora();
    client.getUtxos(accountAddress(account, network)).then(setUtxos).catch((e) => setError(e.message));
    client.getFeeEstimates().then((est) => {
      setFeeEstimates(est);
      setFeeRate((prev) => prev || String(est.halfHour));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId]);

  const activeUtxos = useMemo(
    () => (autoCoins ? utxos : utxos.filter((u) => selectedCoins.has(`${u.txid}:${u.vout}`))),
    [utxos, autoCoins, selectedCoins]
  );

  const opReturn = useMemo(() => {
    if (!dataInput.trim()) return null;
    try {
      const encoded = encodeCustomOpReturn(dataInput, dataFormat);
      return { ...encoded, compliance: checkOpReturnCompliance(encoded.payload.length) };
    } catch (err) {
      return { error: err instanceof Error ? err.message : 'Invalid data' } as const;
    }
  }, [dataInput, dataFormat]);

  const totals = useMemo(() => {
    const sendTotal = recipients.reduce((sum, r) => sum + (parseInt(r.amount, 10) || 0), 0);
    const available = activeUtxos.reduce((sum, u) => sum + u.value, 0);
    const opLen = opReturn && 'payload' in opReturn ? opReturnScriptSize(opReturn.payload.length) : 0;
    const vsize = estimateVsize(Math.max(activeUtxos.length, 1), recipients.length + 1, opLen ? [opLen] : []);
    const fee = Math.ceil(vsize * (parseFloat(feeRate) || 0));
    return { sendTotal, available, vsize, fee };
  }, [recipients, activeUtxos, opReturn, feeRate]);

  function updateRecipient(idx: number, patch: Partial<RecipientRow>) {
    setRecipients((rows) => rows.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  }

  function resolveRow(idx: number) {
    setRecipients((rows) =>
      rows.map((r, i) => {
        if (i !== idx || !r.raw.trim()) return r;
        try {
          return { ...r, resolved: resolveRecipient(r.raw, network), error: undefined };
        } catch (err) {
          return { ...r, resolved: undefined, error: err instanceof Error ? err.message : 'Invalid recipient' };
        }
      })
    );
  }

  async function handleBuild() {
    if (!account) return;
    setError('');
    setBusy(true);
    try {
      const resolvedRecipients = recipients
        .filter((r) => r.raw.trim())
        .map((r) => {
          const resolved = r.resolved ?? resolveRecipient(r.raw, network);
          const amountSats = parseInt(r.amount, 10);
          if (!amountSats || amountSats < 546) throw new Error(`Amount for ${r.raw.slice(0, 16)}… must be ≥ 546 sats`);
          return { resolved, amountSats };
        });
      if (resolvedRecipients.length === 0) throw new Error('Add at least one recipient');
      if (opReturn && 'error' in opReturn) throw new Error(opReturn.error);

      const built = buildWalletTx({
        account,
        utxos: activeUtxos,
        recipients: resolvedRecipients,
        opReturn: opReturn && 'payload' in opReturn ? opReturn.payload : undefined,
        feeRate: parseFloat(feeRate),
        rbf,
        locktime: locktime ? parseInt(locktime, 10) : undefined,
        useAllUtxos: !autoCoins,
      });

      const name = `Send ${formatSats(resolvedRecipients.reduce((s, r) => s + r.amountSats, 0))} — ${new Date().toLocaleString()}`;
      const doc = await createDoc('psbt', name, built.psbtBase64);
      navigate(`/files/${doc.id}`, { state: { accountId: account.id } });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Build failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-2xl font-bold">Transaction Builder</h1>
        <p className="text-stone-400 text-sm">Full control: coins, outputs, data, fees. Output is a PSBT file you own.</p>
      </header>

      {/* From */}
      <div className="card space-y-3">
        <label className="label">From wallet</label>
        <select className="input" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.label}
              {a.watchOnly ? ' (watch-only)' : ''}
            </option>
          ))}
        </select>
        <div className="flex items-center justify-between text-xs text-stone-400">
          <span>{formatSats(totals.available)} spendable · {utxos.length} coins</span>
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={!autoCoins} onChange={(e) => setAutoCoins(!e.target.checked)} />
            Coin control
          </label>
        </div>
        {!autoCoins && (
          <div className="space-y-1.5 max-h-48 overflow-y-auto">
            {utxos.map((u) => {
              const key = `${u.txid}:${u.vout}`;
              return (
                <label key={key} className="flex items-center gap-2 text-xs font-mono text-stone-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={selectedCoins.has(key)}
                    onChange={(e) => {
                      const next = new Set(selectedCoins);
                      if (e.target.checked) next.add(key);
                      else next.delete(key);
                      setSelectedCoins(next);
                    }}
                  />
                  <span className="truncate flex-1">{u.txid.slice(0, 14)}…:{u.vout}</span>
                  <span>{formatSats(u.value)}</span>
                </label>
              );
            })}
          </div>
        )}
      </div>

      {/* Recipients */}
      <div className="card space-y-3">
        <div className="flex items-center justify-between">
          <label className="label mb-0">Recipients</label>
          <button className="btn-ghost text-xs" onClick={() => setRecipients((r) => [...r, { raw: '', amount: '' }])}>
            <Plus size={14} /> Add output
          </button>
        </div>
        {recipients.map((r, idx) => (
          <div key={idx} className="space-y-1.5">
            <div className="flex gap-2">
              <input
                className="input flex-1 font-mono text-xs"
                placeholder="bc1… address, npub1…, or sp1… silent payment"
                value={r.raw}
                onChange={(e) => updateRecipient(idx, { raw: e.target.value, resolved: undefined, error: undefined })}
                onBlur={() => resolveRow(idx)}
              />
              <input
                className="input w-32 text-right"
                placeholder="sats"
                inputMode="numeric"
                value={r.amount}
                onChange={(e) => updateRecipient(idx, { amount: e.target.value.replace(/\D/g, '') })}
              />
              {recipients.length > 1 && (
                <button className="btn-ghost px-2" onClick={() => setRecipients((rows) => rows.filter((_, i) => i !== idx))}>
                  <Trash2 size={14} />
                </button>
              )}
            </div>
            {r.resolved && (
              <p className="text-xs text-stone-500">
                {r.resolved.kind === 'npub' && (
                  <>
                    npub → <span className="font-mono">{r.resolved.address?.slice(0, 24)}…</span>
                  </>
                )}
                {r.resolved.kind === 'silent-payment' && (
                  <span className="text-purple-300">
                    <Zap size={11} className="inline mr-1" />
                    Silent payment — a fresh unlinkable address is derived when you build
                  </span>
                )}
                {r.resolved.kind === 'address' && 'Valid address'}
              </p>
            )}
            {r.error && <p className="text-xs text-red-400">{r.error}</p>}
          </div>
        ))}
      </div>

      {/* OP_RETURN */}
      <div className="card space-y-3">
        <div className="flex items-center justify-between">
          <label className="label mb-0">On-chain data (OP_RETURN)</label>
          <div className="flex gap-1">
            {(['text', 'hex'] as const).map((f) => (
              <button
                key={f}
                onClick={() => setDataFormat(f)}
                className={`px-2.5 py-1 rounded-lg text-xs font-medium ${dataFormat === f ? 'bg-accent text-stone-950' : 'bg-surface-overlay text-stone-400'}`}
              >
                {f}
              </button>
            ))}
          </div>
        </div>
        <textarea
          className="input font-mono text-xs"
          rows={2}
          placeholder={dataFormat === 'text' ? 'Optional message stored forever on-chain' : 'deadbeef…'}
          value={dataInput}
          onChange={(e) => setDataInput(e.target.value)}
        />
        {opReturn && 'compliance' in opReturn && (
          <p className={`text-xs ${opReturn.compliance.bip110Compliant ? 'text-green-400' : 'text-amber-400'}`}>
            {opReturn.compliance.summary}
          </p>
        )}
        {opReturn && 'error' in opReturn && <p className="text-xs text-red-400">{opReturn.error}</p>}
      </div>

      {/* Fees + advanced */}
      <div className="card space-y-3">
        <label className="label mb-0">Fee rate (sat/vB)</label>
        <div className="flex gap-2">
          {feeEstimates &&
            (
              [
                ['economy', feeEstimates.economy],
                ['1 hour', feeEstimates.hour],
                ['30 min', feeEstimates.halfHour],
                ['fastest', feeEstimates.fastest],
              ] as const
            ).map(([labelText, rate]) => (
              <button
                key={labelText}
                onClick={() => setFeeRate(String(rate))}
                className={`btn text-xs flex-1 ${feeRate === String(rate) ? 'bg-accent text-stone-950' : 'bg-surface-overlay text-stone-300'}`}
              >
                {labelText}
                <br />
                {rate}
              </button>
            ))}
        </div>
        <input className="input" inputMode="decimal" value={feeRate} onChange={(e) => setFeeRate(e.target.value)} placeholder="Custom sat/vB" />
        <button className="text-xs text-stone-400 underline" onClick={() => setShowAdvanced(!showAdvanced)}>
          {showAdvanced ? 'Hide' : 'Show'} advanced
        </button>
        {showAdvanced && (
          <div className="space-y-3 pt-1">
            <label className="flex items-center gap-2 text-sm text-stone-300 cursor-pointer">
              <input type="checkbox" checked={rbf} onChange={(e) => setRbf(e.target.checked)} />
              Signal replace-by-fee (RBF)
            </label>
            <div>
              <label className="label">Locktime (block height, optional)</label>
              <input className="input" inputMode="numeric" value={locktime} onChange={(e) => setLocktime(e.target.value.replace(/\D/g, ''))} />
            </div>
          </div>
        )}
      </div>

      {/* Summary + build */}
      <div className="card space-y-2 text-sm">
        <div className="flex justify-between"><span className="text-stone-400">Sending</span><span>{formatSats(totals.sendTotal)}</span></div>
        <div className="flex justify-between"><span className="text-stone-400">Est. fee</span><span>{formatSats(totals.fee)} (~{totals.vsize} vB)</span></div>
        <div className="flex justify-between font-semibold"><span className="text-stone-400">Total</span><span>{formatSats(totals.sendTotal + totals.fee)}</span></div>
      </div>

      {error && <p className="text-red-400 text-sm">{error}</p>}
      <button className="btn-primary w-full" onClick={handleBuild} disabled={busy || !account}>
        <Hammer size={16} />
        {busy ? 'Building…' : 'Build PSBT'}
      </button>
    </div>
  );
}
