import { useState, useEffect, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { createMessageId } from '@/shared/messages';
import { ArrowLeft, Send, Download, Loader2, Copy, Check, FileDown, ExternalLink, Key, AlertTriangle, ChevronDown, ChevronUp, DollarSign, Coins } from 'lucide-react';
import { fetchBalance, fetchFeeEstimates, fetchUTXOs, formatSats, getMempoolAddressUrl, getMempoolTxUrl, broadcastTransaction, type UTXO } from '@/lib/bitcoin/mempool';
import { pubkeyToTaprootAddress } from '@/lib/bitcoin/address';
import { buildPsbt, downloadPsbtFile, downloadPsbtText, type PsbtResult } from '@/lib/bitcoin/psbt-builder';
import { encodePlainMemoOpReturn, encodeInvoiceOpReturn } from '@/lib/bitcoin/opreturn';
import { loadBitcoinNodeConfig } from '@/lib/bitcoin/node';
import { detectBitcoinSigners, tryExternalPsbtSign, promptExtensionAccess, type BitcoinSignerSource } from '@/lib/bitcoin/psbt-external-sign';
import { loadMultisigWallets, type ArchivedMultisig } from '@/lib/bitcoin/wallet-store';
import { useAuth } from '../context/AuthContext';
import { RecipientPicker } from '../components/RecipientPicker';

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

const BTC_PRICE_API = 'https://mempool.space/api/v1/prices';

export function SendTx({ publicKey, onBack }: Props) {
  const [searchParams] = useSearchParams();
  const { canSignOnchain, handleUpgradeWithNsec, vaultPassword } = useAuth();
  const [recipient, setRecipient] = useState('');
  const [amountSats, setAmountSats] = useState('');
  const [memo, setMemo] = useState('');
  const [feeRate, setFeeRate] = useState('');
  const [feeEstimates, setFeeEstimates] = useState<FeeEstimate | null>(null);
  const [balance, setBalance] = useState<number>(0);
  const [loadingBalance, setLoadingBalance] = useState(true);
  const [psbtResult, setPsbtResult] = useState<PsbtResult | null>(null);
  const [broadcastTxid, setBroadcastTxid] = useState('');
  const [broadcastVia, setBroadcastVia] = useState<'node' | 'esplora'>('esplora');
  const [signSource, setSignSource] = useState<BitcoinSignerSource | ''>('');
  const [signerInfo, setSignerInfo] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState('');
  const [invoiceEventId, setInvoiceEventId] = useState('');
  const [prefilledFromInvoice, setPrefilledFromInvoice] = useState(false);
  const [showNsecUpgrade, setShowNsecUpgrade] = useState(false);
  const [nsecInput, setNsecInput] = useState('');
  const [upgrading, setUpgrading] = useState(false);

  // Coin control state
  const [utxos, setUtxos] = useState<UTXO[]>([]);
  const [selectedUtxos, setSelectedUtxos] = useState<Set<string>>(new Set());
  const [showCoinControl, setShowCoinControl] = useState(false);
  const [loadingUtxos, setLoadingUtxos] = useState(false);

  // Sender picker state
  const [senderSource, setSenderSource] = useState<'personal' | string>('personal');
  const [multisigWallets, setMultisigWallets] = useState<ArchivedMultisig[]>([]);
  const [showSenderPicker, setShowSenderPicker] = useState(false);

  // BTC price for USD estimate
  const [btcPriceUsd, setBtcPriceUsd] = useState<number>(0);

  const personalAddress = pubkeyToTaprootAddress(publicKey);

  const activeAddress = useMemo(() => {
    if (senderSource === 'personal') return personalAddress;
    const ms = multisigWallets.find(w => w.id === senderSource);
    return ms?.wallet?.address || personalAddress;
  }, [senderSource, multisigWallets, personalAddress]);

  // Fee + size estimate
  const estimatedVsize = useMemo(() => {
    const inputCount = selectedUtxos.size > 0 ? selectedUtxos.size : Math.max(1, Math.ceil((parseInt(amountSats) || 10000) / 50000));
    return 10.5 + inputCount * 57.5 + 2 * 43;
  }, [selectedUtxos, amountSats]);

  const estimatedFeeUsd = useMemo(() => {
    if (!btcPriceUsd || !feeRate) return null;
    const feeSats = Math.ceil(estimatedVsize * parseFloat(feeRate));
    return (feeSats / 1e8) * btcPriceUsd;
  }, [btcPriceUsd, feeRate, estimatedVsize]);

  const totalSelectedSats = useMemo(() => {
    if (selectedUtxos.size === 0) return 0;
    return utxos
      .filter(u => selectedUtxos.has(`${u.txid}:${u.vout}`))
      .reduce((sum, u) => sum + u.value, 0);
  }, [selectedUtxos, utxos]);

  async function signAndBroadcast(psbtHex: string): Promise<{ txid: string; via: 'node' | 'esplora' }> {
    if (!canSignOnchain) {
      await promptExtensionAccess();
      const external = await tryExternalPsbtSign(psbtHex, publicKey);
      if (external) {
        setSignSource(external.source);
        const nodeCfg = await loadBitcoinNodeConfig();
        const txid = await broadcastTransaction(external.txHex);
        return {
          txid,
          via: nodeCfg?.enabled && nodeCfg.rpcUrl ? 'node' : 'esplora',
        };
      }
      const info = detectBitcoinSigners();
      throw new Error(
        info.webbtc || info.signSchnorr || info.bitcoinApi
          ? 'NIP-07 signing failed. Unlock the Nostr Onchain extension, or approve in Alby.'
          : 'No Bitcoin signer found. Install Alby, unlock our extension, or import nsec.'
      );
    }

    await promptExtensionAccess();
    const nip07 = await tryExternalPsbtSign(psbtHex, publicKey);
    if (nip07) {
      setSignSource(nip07.source);
      const nodeCfg = await loadBitcoinNodeConfig();
      const txid = await broadcastTransaction(nip07.txHex);
      return {
        txid,
        via: nodeCfg?.enabled && nodeCfg.rpcUrl ? 'node' : 'esplora',
      };
    }

    const signResponse = await chrome.runtime.sendMessage({
      type: 'btc:signPsbt',
      payload: { psbtHex },
      id: createMessageId(),
    });
    if (signResponse.error) {
      throw new Error(signResponse.error);
    }
    setSignSource((signResponse.result.source as BitcoinSignerSource) || 'vault');
    const nodeCfg = await loadBitcoinNodeConfig();
    const txid = await broadcastTransaction(signResponse.result.txHex);
    return {
      txid,
      via: nodeCfg?.enabled && nodeCfg.rpcUrl ? 'node' : 'esplora',
    };
  }

  async function handleRetrySignAndBroadcast() {
    if (!psbtResult) return;
    setError('');
    setLoading(true);
    try {
      const { txid, via } = await signAndBroadcast(psbtResult.psbtHex);
      setBroadcastTxid(txid);
      setBroadcastVia(via);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to sign and broadcast';
      setError(msg);
      if (msg.includes('Alby') || msg.includes('nos2x') || msg.includes('No Bitcoin signer')) {
        setShowNsecUpgrade(true);
      }
    } finally {
      setLoading(false);
    }
  }

  async function handleUpgradeNsec(e: React.FormEvent) {
    e.preventDefault();
    if (!nsecInput.trim()) return;
    if (!vaultPassword) {
      setError('Lock and unlock your vault first, then try again.');
      return;
    }
    setUpgrading(true);
    setError('');
    try {
      await handleUpgradeWithNsec(nsecInput.trim());
      setNsecInput('');
      setShowNsecUpgrade(false);
      if (psbtResult) {
        const { txid, via } = await signAndBroadcast(psbtResult.psbtHex);
        setBroadcastTxid(txid);
        setBroadcastVia(via);
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to import nsec');
    } finally {
      setUpgrading(false);
    }
  }

  useEffect(() => {
    loadBalanceAndFees();
    loadWallets();
    fetchBtcPrice();
    const info = detectBitcoinSigners();
    setSignerInfo(info.label);

    const invoice = searchParams.get('invoice');
    const to = searchParams.get('to');
    const amount = searchParams.get('amount');
    if (invoice || to || amount) {
      if (invoice) setInvoiceEventId(invoice);
      if (to) setRecipient(to);
      if (amount) setAmountSats(amount);
      setPrefilledFromInvoice(true);
    }
  }, [searchParams]);

  useEffect(() => {
    if (activeAddress) {
      loadBalanceForAddress(activeAddress);
      loadUtxosForAddress(activeAddress);
    }
  }, [activeAddress]);

  async function fetchBtcPrice() {
    try {
      const res = await fetch(BTC_PRICE_API);
      if (res.ok) {
        const data = await res.json();
        if (data.USD) setBtcPriceUsd(data.USD);
      }
    } catch {}
  }

  async function loadWallets() {
    try {
      const wallets = await loadMultisigWallets();
      setMultisigWallets(wallets);
    } catch {}
  }

  async function loadBalanceForAddress(addr: string) {
    setLoadingBalance(true);
    try {
      const bal = await fetchBalance(addr);
      setBalance(bal.total);
    } catch {} finally {
      setLoadingBalance(false);
    }
  }

  async function loadUtxosForAddress(addr: string) {
    setLoadingUtxos(true);
    try {
      const fetched = await fetchUTXOs(addr);
      setUtxos(fetched);
      setSelectedUtxos(new Set());
    } catch {} finally {
      setLoadingUtxos(false);
    }
  }

  async function loadBalanceAndFees() {
    setLoadingBalance(true);
    try {
      const [bal, fees] = await Promise.allSettled([
        fetchBalance(activeAddress),
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

  function toggleUtxo(id: string) {
    setSelectedUtxos(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectAllUtxos() {
    setSelectedUtxos(new Set(utxos.map(u => `${u.txid}:${u.vout}`)));
  }

  function clearUtxoSelection() {
    setSelectedUtxos(new Set());
  }

  async function handleSendTransaction(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    setBroadcastTxid('');
    setPsbtResult(null);

    try {
      const amount = parseInt(amountSats, 10);
      if (!amount || amount <= 0) throw new Error('Enter a valid amount');
      if (!recipient) throw new Error('Enter a recipient address');

      let opReturnData: Uint8Array | undefined;

      if (invoiceEventId.trim()) {
        const invoiceOpReturn = encodeInvoiceOpReturn(invoiceEventId.trim());
        opReturnData = invoiceOpReturn.script.slice(2);
      } else if (memo.trim()) {
        const memoOpReturn = encodePlainMemoOpReturn(memo.trim());
        opReturnData = memoOpReturn.script.slice(2);
      }

      const preSelected = selectedUtxos.size > 0
        ? utxos.filter(u => selectedUtxos.has(`${u.txid}:${u.vout}`))
        : undefined;

      const result = await buildPsbt({
        fromAddress: activeAddress,
        toAddress: recipient,
        amountSats: amount,
        feeRate: parseFloat(feeRate) || undefined,
        internalPubkeyHex: publicKey,
        opReturnData,
        selectedUtxos: preSelected,
      });

      setPsbtResult(result);

      const { txid, via } = await signAndBroadcast(result.psbtHex);
      setBroadcastTxid(txid);
      setBroadcastVia(via);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to send transaction';
      setError(msg);
      if (msg.includes('nos2x') || msg.includes('Alby') || msg.includes('No Bitcoin signer')) {
        setShowNsecUpgrade(true);
      }
    } finally {
      setLoading(false);
    }
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
        <button onClick={() => { setPsbtResult(null); setBroadcastTxid(''); }} className="btn-back">
            <ArrowLeft className="w-5 h-5" />
          </button>
          <h1>{broadcastTxid ? 'Transaction Sent' : 'Transaction Failed'}</h1>
        </div>

        {broadcastTxid && (
          <div className="card mb-3 border-green-500/30 bg-green-500/5">
            <p className="text-xs text-green-400 font-medium mb-1">Broadcast successful</p>
            <code className="text-[10px] text-gray-400 break-all block">{broadcastTxid}</code>
            <p className="text-[10px] text-gray-500 mt-1">
              Signed via {signSource === 'webbtc' ? 'Alby (WebBTC)' : signSource === 'nip07-schnorr' ? 'NIP-07 signSchnorr' : signSource === 'bitcoin-api' ? 'Nostr Onchain extension' : signSource === 'vault' ? 'vault key' : 'signer'}
              {' · '}Broadcast via {broadcastVia === 'node' ? 'your Bitcoin node' : 'public mempool'}
            </p>
            <a
              href={getMempoolTxUrl(broadcastTxid)}
              target="_blank"
              rel="noopener"
              className="text-xs text-bitcoin hover:underline mt-2 inline-flex items-center gap-1"
            >
              View on mempool.space <ExternalLink className="w-3 h-3" />
            </a>
          </div>
        )}

        {error && !broadcastTxid && (
          <div className="card mb-3 border-red-500/30 bg-red-500/5">
            <div className="flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" />
              <div>
                <p className="text-xs text-red-400 font-medium mb-1">Signing failed — PSBT is unsigned</p>
                <p className="text-xs text-gray-400">{error}</p>
              </div>
            </div>
          </div>
        )}

        {/* Summary */}
        <div className="card mb-3">
          <div className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-gray-500">Send</span>
              <span className="text-bitcoin font-semibold">{formatSats(parseInt(amountSats))}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-500">Fee</span>
              <span className="text-gray-300">
                {formatSats(psbtResult.fee)} ({feeRate} sat/vB)
                {btcPriceUsd > 0 && (
                  <span className="text-gray-500 ml-1">
                    ≈ ${((psbtResult.fee / 1e8) * btcPriceUsd).toFixed(2)}
                  </span>
                )}
              </span>
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

        {/* Advanced: export PSBT for external signing */}
        {broadcastTxid && (
          <details className="mb-4">
            <summary className="text-xs text-gray-500 cursor-pointer">Advanced: export PSBT</summary>
            <div className="space-y-2 mt-2">
              <button
                onClick={() => downloadPsbtFile(psbtResult.psbtBase64)}
                className="btn-secondary w-full flex items-center justify-center gap-2 text-sm"
              >
                <FileDown className="w-4 h-4" />
                Download .psbt
              </button>
              <button
                onClick={() => copyText(psbtResult.psbtBase64, 'base64')}
                className="w-full flex items-center gap-2 px-3 py-2 rounded-xl bg-surface-800/50 hover:bg-surface-700 transition-colors"
              >
                {copied === 'base64' ? <Check className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4 text-gray-400" />}
                <span className="text-sm text-gray-300">Copy PSBT (Base64)</span>
              </button>
            </div>
          </details>
        )}

        {!broadcastTxid && (
          <>
            {canSignOnchain && (
              <button
                onClick={handleRetrySignAndBroadcast}
                disabled={loading}
                className="btn-primary w-full flex items-center justify-center gap-2 mb-3"
              >
                {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                {loading ? 'Signing & broadcasting...' : 'Retry Sign & Broadcast'}
              </button>
            )}

            {(showNsecUpgrade || !canSignOnchain) && (
              <div className="card mb-3 border-bitcoin/30">
                <div className="flex items-center gap-2 mb-2">
                  <Key className="w-4 h-4 text-bitcoin" />
                  <p className="text-xs font-medium text-bitcoin">Enable onchain signing</p>
                </div>
                <p className="text-[10px] text-gray-500 mb-2">
                  Standard NIP-07 (nos2x) only signs Nostr events. For Bitcoin without pasting nsec, use <strong className="text-gray-400">Alby</strong> — it exposes <code className="text-gray-500">webbtc.signPsbt</code> and signs in the extension popup.
                </p>
                <form onSubmit={handleUpgradeNsec} className="space-y-2">
                  <input
                    type="password"
                    value={nsecInput}
                    onChange={(e) => setNsecInput(e.target.value)}
                    placeholder="nsec1..."
                    className="input-field text-xs font-mono"
                  />
                  <button type="submit" disabled={upgrading || !nsecInput.trim()} className="btn-secondary w-full text-sm">
                    {upgrading ? 'Importing & sending...' : 'Import nsec & Send'}
                  </button>
                </form>
              </div>
            )}

            <details className="mb-3">
              <summary className="text-xs text-gray-500 cursor-pointer">Or sign in Sparrow Wallet</summary>
              <p className="text-[10px] text-gray-600 mt-2 mb-2">
                The downloaded PSBT is <strong className="text-gray-400">unsigned</strong> — that is correct. Sparrow opens unsigned PSBTs, signs with your imported nsec, then broadcasts.
              </p>
              <ol className="text-[10px] text-gray-600 list-decimal list-inside space-y-1 mb-2">
                <li>Download the .psbt below</li>
                <li>Sparrow → File → Open Transaction</li>
                <li>Import your nsec as a wallet (if not already)</li>
                <li>Sign → Broadcast</li>
              </ol>
            </details>

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
          </>
        )}

        <div className="mt-4">
          <button onClick={() => { setPsbtResult(null); setBroadcastTxid(''); }} className="btn-secondary w-full">
            {broadcastTxid ? 'Send Another' : 'Try Again'}
          </button>
        </div>
      </div>
    );
  }

  // ─── BUILD FORM ──────────────────────────────────────────────

  return (
    <div className="h-full flex flex-col p-4 overflow-y-auto pb-safe" style={{ paddingBottom: 'calc(6rem + var(--safe-bottom))' }}>
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

      {prefilledFromInvoice && (
        <div className="card mb-3 border-nostr/30 bg-nostr/5">
          <p className="text-xs text-nostr font-medium">Pre-filled from invoice</p>
          <p className="text-[10px] text-gray-400 mt-1">
            OP_RETURN proof will be included automatically when you send.
          </p>
        </div>
      )}

      {/* ─── SENDER PICKER ─── */}
      <div className="card mb-3">
        <button
          type="button"
          onClick={() => setShowSenderPicker(!showSenderPicker)}
          className="w-full flex items-center justify-between"
        >
          <div className="flex-1 min-w-0">
            <p className="text-[10px] text-gray-500 text-left">
              {senderSource === 'personal' ? 'From (your Taproot address)' : 'From (Multisig wallet)'}
            </p>
            <p className="text-xs font-mono text-gray-300 truncate text-left">{activeAddress}</p>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <a
              href={getMempoolAddressUrl(activeAddress)}
              target="_blank"
              rel="noopener"
              className="btn-icon"
              onClick={(e) => e.stopPropagation()}
            >
              <ExternalLink className="w-3.5 h-3.5 text-gray-500" />
            </a>
            {multisigWallets.length > 0 && (
              showSenderPicker ? <ChevronUp className="w-4 h-4 text-gray-500" /> : <ChevronDown className="w-4 h-4 text-gray-500" />
            )}
          </div>
        </button>

        {showSenderPicker && (
          <div className="mt-3 border-t border-white/5 pt-3 space-y-2">
            <button
              type="button"
              onClick={() => { setSenderSource('personal'); setShowSenderPicker(false); }}
              className={`w-full text-left p-2 rounded-lg transition-colors ${senderSource === 'personal' ? 'bg-purple-500/10 border border-purple-500/30' : 'hover:bg-surface-700'}`}
            >
              <p className="text-xs font-medium text-gray-200">Personal Taproot</p>
              <p className="text-[10px] font-mono text-gray-500 truncate">{personalAddress}</p>
            </button>
            {multisigWallets.map((w) => (
              <button
                key={w.id}
                type="button"
                onClick={() => { setSenderSource(w.id); setShowSenderPicker(false); }}
                className={`w-full text-left p-2 rounded-lg transition-colors ${senderSource === w.id ? 'bg-purple-500/10 border border-purple-500/30' : 'hover:bg-surface-700'}`}
              >
                <p className="text-xs font-medium text-gray-200">{w.name || 'Multisig'}</p>
                <p className="text-[10px] text-gray-500">
                  {w.wallet.config.threshold}-of-{w.wallet.config.pubkeys.length}
                </p>
                <p className="text-[10px] font-mono text-gray-500 truncate">{w.wallet.address}</p>
              </button>
            ))}
          </div>
        )}
      </div>

      {!canSignOnchain && (
        <div className="card mb-3 border-amber-500/30 bg-amber-500/5">
          <p className="text-xs text-amber-400">
            External signer — <span className="text-gray-300">{signerInfo}</span>
          </p>
          <p className="text-[10px] text-gray-500 mt-1">
            {signerInfo === 'None detected'
              ? 'Install Alby, unlock the Nostr Onchain extension, or import nsec once.'
              : 'Send uses NIP-07 signSchnorr — your extension will prompt to approve. Unlock our extension if using it as signer.'}
          </p>
        </div>
      )}

      <form onSubmit={handleSendTransaction} className="flex-1 flex flex-col space-y-3">
        {/* Recipient */}
        <div>
          <label className="text-xs text-gray-400 mb-1 block">Recipient</label>
          <RecipientPicker
            publicKey={publicKey}
            value={recipient}
            onChange={setRecipient}
            onAmountSuggestion={setAmountSats}
            onInvoiceSelect={setInvoiceEventId}
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
          <div className="flex items-center justify-between mt-1">
            {balance > 0 && (
              <div className="flex gap-2 mt-1 flex-wrap">
                {[
                  { label: '25%', value: Math.floor(balance * 0.25) },
                  { label: '50%', value: Math.floor(balance * 0.5) },
                  { label: '75%', value: Math.floor(balance * 0.75) },
                ].map(({ label, value }) => (
                  <button
                    key={label}
                    type="button"
                    onClick={() => setAmountSats(String(value))}
                    className="text-[10px] px-2.5 py-1.5 rounded-lg font-medium bg-surface-700 text-gray-400 hover:bg-surface-600 min-h-[28px]"
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}
            {btcPriceUsd > 0 && amountSats && (
              <p className="text-[10px] text-gray-500 flex items-center gap-1">
                <DollarSign className="w-3 h-3" />
                ≈ ${((parseInt(amountSats) / 1e8) * btcPriceUsd).toFixed(2)} USD
              </p>
            )}
          </div>
        </div>

        {/* Fee rate with sub-sat support */}
        <div>
          <label className="text-xs text-gray-400 mb-1 flex items-center justify-between">
            <span>Fee Rate (sat/vB)</span>
            {estimatedFeeUsd !== null && (
              <span className="text-[10px] text-gray-500 flex items-center gap-1">
                <DollarSign className="w-3 h-3" />
                ≈ ${estimatedFeeUsd.toFixed(2)} fee
              </span>
            )}
          </label>
          <input
            type="number"
            step="0.1"
            min="0.1"
            value={feeRate}
            onChange={(e) => setFeeRate(e.target.value)}
            placeholder="5"
            className="input-field text-sm"
          />
          {feeEstimates && (
            <div className="flex gap-1.5 mt-2 flex-wrap">
              {[
                { label: '⚡ Fast', rate: feeEstimates.fastest, color: 'red' },
                { label: '30m', rate: feeEstimates.halfHour, color: 'bitcoin' },
                { label: '1h', rate: feeEstimates.hour, color: 'green' },
                { label: 'Eco', rate: feeEstimates.economy, color: 'blue' },
                { label: '0.5', rate: 0.5, color: 'purple' },
                { label: '0.1', rate: 0.1, color: 'purple' },
              ].map(({ label, rate, color }) => (
                <button
                  key={label}
                  type="button"
                  onClick={() => setFeeRate(String(rate))}
                  className={`text-[10px] px-2 py-1.5 rounded-lg font-medium transition-colors ${
                    parseFloat(feeRate) === rate
                      ? `bg-${color}-500/20 text-${color}-400 border border-${color}-500/40`
                      : 'bg-surface-700 text-gray-400 hover:bg-surface-600'
                  }`}
                >
                  {label}{typeof rate === 'number' && rate >= 1 ? `: ${rate}` : rate < 1 ? ' sat/vB' : ''}
                </button>
              ))}
            </div>
          )}
          <p className="text-[10px] text-gray-600 mt-1">
            Sub-sat rates (0.5, 0.1) may take longer to confirm but save fees
          </p>
        </div>

        {/* ─── COIN CONTROL ─── */}
        <div>
          <button
            type="button"
            onClick={() => setShowCoinControl(!showCoinControl)}
            className="flex items-center gap-2 text-xs text-gray-400 hover:text-gray-300 transition-colors"
          >
            <Coins className="w-3.5 h-3.5" />
            <span>Coin Control (UTXOs)</span>
            {selectedUtxos.size > 0 && (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-purple-500/20 text-purple-400">
                {selectedUtxos.size} selected
              </span>
            )}
            {showCoinControl ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
          </button>

          {showCoinControl && (
            <div className="mt-2 rounded-xl bg-surface-800/50 border border-white/5 p-3">
              <div className="flex items-center justify-between mb-2">
                <p className="text-[10px] text-gray-500">
                  {utxos.length} UTXO{utxos.length !== 1 ? 's' : ''} available
                  {totalSelectedSats > 0 && (
                    <span className="ml-2 text-purple-400">
                      Selected: {formatSats(totalSelectedSats)}
                    </span>
                  )}
                </p>
                <div className="flex gap-2">
                  <button type="button" onClick={selectAllUtxos} className="text-[10px] text-purple-400 hover:underline">
                    All
                  </button>
                  <button type="button" onClick={clearUtxoSelection} className="text-[10px] text-gray-500 hover:underline">
                    None
                  </button>
                </div>
              </div>

              {loadingUtxos ? (
                <div className="flex items-center justify-center py-4">
                  <Loader2 className="w-4 h-4 animate-spin text-gray-500" />
                </div>
              ) : utxos.length === 0 ? (
                <p className="text-[10px] text-gray-600 text-center py-3">No UTXOs found</p>
              ) : (
                <div className="space-y-1.5 max-h-48 overflow-y-auto">
                  {utxos.map((utxo) => {
                    const id = `${utxo.txid}:${utxo.vout}`;
                    const isSelected = selectedUtxos.has(id);
                    return (
                      <button
                        key={id}
                        type="button"
                        onClick={() => toggleUtxo(id)}
                        className={`w-full text-left p-2 rounded-lg transition-all ${
                          isSelected
                            ? 'bg-purple-500/10 border border-purple-500/30'
                            : 'bg-surface-700/50 border border-transparent hover:border-white/10'
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2 min-w-0">
                            <div className={`w-3 h-3 rounded-sm border flex items-center justify-center ${
                              isSelected ? 'bg-purple-500 border-purple-500' : 'border-gray-600'
                            }`}>
                              {isSelected && <Check className="w-2 h-2 text-white" />}
                            </div>
                            <span className="text-[10px] font-mono text-gray-500 truncate">
                              {utxo.txid.slice(0, 8)}…:{utxo.vout}
                            </span>
                          </div>
                          <div className="text-right flex-shrink-0 ml-2">
                            <span className="text-xs font-medium text-gray-200">
                              {formatSats(utxo.value)}
                            </span>
                            {btcPriceUsd > 0 && (
                              <span className="text-[9px] text-gray-500 ml-1">
                                (${((utxo.value / 1e8) * btcPriceUsd).toFixed(2)})
                              </span>
                            )}
                          </div>
                        </div>
                        <div className="flex items-center gap-2 mt-0.5 ml-5">
                          <span className={`text-[9px] px-1.5 py-0.5 rounded ${
                            utxo.status.confirmed
                              ? 'bg-green-500/10 text-green-400'
                              : 'bg-amber-500/10 text-amber-400'
                          }`}>
                            {utxo.status.confirmed ? 'confirmed' : 'unconfirmed'}
                          </span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Optional on-chain memo */}
        <div>
          <label className="text-xs text-gray-400 mb-1 block">Memo (optional, plain text on-chain)</label>
          <input
            value={memo}
            onChange={(e) => setMemo(e.target.value)}
            placeholder="Short message embedded in OP_RETURN..."
            maxLength={75}
            className="input-field text-sm"
          />
          <p className="text-[10px] text-gray-600 mt-1">No Nostr event — just text in the transaction</p>
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

        {/* Transaction cost summary */}
        {feeRate && amountSats && (
          <div className="rounded-xl bg-surface-800/30 border border-white/5 p-3">
            <div className="flex items-center justify-between text-[11px]">
              <span className="text-gray-500">Est. tx size</span>
              <span className="text-gray-300">~{Math.round(estimatedVsize)} vB</span>
            </div>
            <div className="flex items-center justify-between text-[11px] mt-1">
              <span className="text-gray-500">Est. fee</span>
              <span className="text-gray-300">
                {formatSats(Math.ceil(estimatedVsize * parseFloat(feeRate)))}
                {estimatedFeeUsd !== null && (
                  <span className="text-gray-500 ml-1">≈ ${estimatedFeeUsd.toFixed(2)}</span>
                )}
              </span>
            </div>
            <div className="flex items-center justify-between text-[11px] mt-1">
              <span className="text-gray-500">Total cost</span>
              <span className="text-bitcoin font-medium">
                {formatSats(parseInt(amountSats) + Math.ceil(estimatedVsize * parseFloat(feeRate)))}
                {btcPriceUsd > 0 && (
                  <span className="text-gray-500 ml-1">
                    ≈ ${(((parseInt(amountSats) + Math.ceil(estimatedVsize * parseFloat(feeRate))) / 1e8) * btcPriceUsd).toFixed(2)}
                  </span>
                )}
              </span>
            </div>
          </div>
        )}

        <div className="mt-auto pt-3 pb-safe">
          <button
            type="submit"
            disabled={!recipient || !amountSats || loading}
            className="btn-primary w-full flex items-center justify-center gap-2 min-h-[48px]"
          >
            {loading ? (
              <><Loader2 className="w-4 h-4 animate-spin" /> Sending...</>
            ) : (
              <><Send className="w-4 h-4" /> Send Transaction</>
            )}
          </button>
          <p className="text-[10px] text-gray-600 text-center mt-2">
            Build → sign via extension or vault → broadcast (node or mempool)
          </p>
        </div>
      </form>
    </div>
  );
}
