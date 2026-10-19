import { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import {
  ArrowLeft, Plus, Wallet, Users, Clock, ExternalLink,
  Copy, Check, Send, Loader2, Shield,
} from 'lucide-react';
import { pubkeyToNpub } from '@/lib/nostr/keys';
import { ProfileBadge } from '@/popup/components/ProfileBadge';
import { getMempoolAddressUrl, fetchBalance, formatSats } from '@/lib/bitcoin/mempool';
import { QRCode } from '@/popup/components/QRCode';
import {
  loadMultisigWallets, saveMultisigWallet, updateMultisigBalance, multisigChain,
  type ArchivedMultisig, type KeyHolder, type PendingSignatureRequest,
  getRequestsForWallet,
} from '@/lib/bitcoin/wallet-store';
import { CHAIN_INFO, type Chain } from '@/lib/bitcoin/chain';
import { ChainBadge } from '@/popup/components/ChainBadge';

interface Props {
  publicKey: string;
  onCreateNew: () => void;
  onRequestSignature: (wallet: ArchivedMultisig, chain: Chain) => void;
  onBack: () => void;
}

export function MultisigVault({ publicKey, onCreateNew, onRequestSignature, onBack }: Props) {
  const [wallets, setWallets] = useState<ArchivedMultisig[]>([]);
  const [selectedWallet, setSelectedWallet] = useState<ArchivedMultisig | null>(null);
  const [loading, setLoading] = useState(true);
  // /wallets/:id opens that vault directly
  const { id: routeId } = useParams<{ id: string }>();

  useEffect(() => {
    loadWallets();
  }, []);

  async function loadWallets() {
    setLoading(true);
    const all = await loadMultisigWallets();
    setWallets(all.sort((a, b) => b.lastActivityAt - a.lastActivityAt));
    if (routeId && !selectedWallet) {
      const hit = all.find((w) => w.id === routeId);
      if (hit) setSelectedWallet(hit);
    }
    setLoading(false);

    // Refresh balances in background for all wallets, each on its own chain
    for (const wallet of all) {
      try {
        const bal = await fetchBalance(wallet.wallet.address, { chain: multisigChain(wallet) });
        if (bal.total !== wallet.currentBalance) {
          await updateMultisigBalance(wallet.id, bal.total);
          setWallets((prev) =>
            prev.map((w) => w.id === wallet.id ? { ...w, currentBalance: bal.total } : w)
          );
        }
      } catch {}
    }
  }

  if (selectedWallet) {
    return (
      <WalletDetail
        wallet={selectedWallet}
        onRequestSignature={(chain) => onRequestSignature(selectedWallet, chain)}
        onBack={() => { setSelectedWallet(null); loadWallets(); }}
      />
    );
  }

  return (
    <div className="h-full flex flex-col p-4">
      {/* Header */}
      <div className="page-header">
        <button onClick={onBack} className="btn-back">
          <ArrowLeft className="w-5 h-5" />
        </button>
        <h1>Multi-Sig Wallets</h1>
        <button onClick={onCreateNew} className="btn-icon bg-bitcoin/20 text-bitcoin">
          <Plus className="w-5 h-5" />
        </button>
      </div>

      {loading ? (
        <div className="flex-1 flex items-center justify-center">
          <Loader2 className="w-5 h-5 animate-spin text-gray-400" />
        </div>
      ) : wallets.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center">
          <Shield className="w-12 h-12 text-gray-700 mb-3" />
          <p className="text-sm text-gray-500 mb-1">No multi-sig wallets yet</p>
          <p className="text-xs text-gray-600 mb-4">Create one from your following list</p>
          <button onClick={onCreateNew} className="btn-primary text-sm">
            Create Multi-Sig
          </button>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto space-y-2">
          {wallets.map((wallet) => (
            <WalletCard
              key={wallet.id}
              wallet={wallet}
              onClick={() => setSelectedWallet(wallet)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Wallet Card ────────────────────────────────────────────────

function WalletCard({ wallet, onClick }: { wallet: ArchivedMultisig; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="card w-full text-left hover:border-bitcoin/30 transition-colors"
    >
      <div className="flex items-center gap-3">
        {/* Key holder avatars stacked */}
        <div className="flex -space-x-2 flex-shrink-0">
          {wallet.keyHolders.slice(0, 4).map((holder, i) => (
            <div key={holder.pubkey} className="relative" style={{ zIndex: 4 - i }}>
              {holder.profile?.picture ? (
                <img
                  src={holder.profile.picture}
                  alt=""
                  className="w-8 h-8 rounded-full object-cover border-2 border-surface-800 bg-surface-700"
                />
              ) : (
                <div className="w-8 h-8 rounded-full bg-gradient-to-br from-bitcoin/30 to-nostr/30 border-2 border-surface-800 flex items-center justify-center">
                  <span className="text-[10px] font-bold text-white/70">
                    {(holder.profile?.displayName || holder.profile?.name || '?').charAt(0)}
                  </span>
                </div>
              )}
            </div>
          ))}
          {wallet.keyHolders.length > 4 && (
            <div className="w-8 h-8 rounded-full bg-surface-700 border-2 border-surface-800 flex items-center justify-center">
              <span className="text-[10px] text-gray-400">+{wallet.keyHolders.length - 4}</span>
            </div>
          )}
        </div>

        {/* Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <p className="text-sm font-medium truncate">{wallet.name}</p>
            <ChainBadge chain={multisigChain(wallet)} />
            <span className="text-[10px] bg-white/5 text-gray-300 px-1.5 py-0.5 rounded font-mono">
              {wallet.wallet.config.threshold}/{wallet.wallet.config.pubkeys.length}
            </span>
          </div>
          <p className="text-xs text-gray-500 font-mono truncate">
            {wallet.wallet.address.slice(0, 16)}...
          </p>
        </div>

        <div className="text-right flex-shrink-0">
          <p className={`text-sm font-medium ${wallet.currentBalance > 0 ? 'text-bitcoin' : 'text-gray-500'}`}>
            {formatSats(wallet.currentBalance)}
          </p>
          <p className="text-[10px] text-gray-600">
            {new Date(wallet.createdAt).toLocaleDateString()}
          </p>
        </div>
      </div>
    </button>
  );
}

// ─── Wallet Detail ──────────────────────────────────────────────

function WalletDetail({
  wallet,
  onRequestSignature,
  onBack,
}: {
  wallet: ArchivedMultisig;
  onRequestSignature: (chain: Chain) => void;
  onBack: () => void;
}) {
  // The vault's own chain, unless the user peeks at the same address on the other chain
  const homeChain = multisigChain(wallet);
  const [chain, setChain] = useState<Chain>(homeChain);
  const other: Chain = homeChain === 'xbt' ? 'btc' : 'xbt';
  const [balance, setBalance] = useState(wallet.currentBalance);
  const [loadingBalance, setLoadingBalance] = useState(false);
  const [copied, setCopied] = useState(false);
  const [requests, setRequests] = useState<PendingSignatureRequest[]>([]);

  useEffect(() => {
    loadRequests();
  }, []);
  useEffect(() => {
    refreshBalance(chain);
  }, [chain]);

  async function refreshBalance(c: Chain) {
    setLoadingBalance(true);
    const bal = await fetchBalance(wallet.wallet.address, { chain: c });
    setBalance(bal.total);
    // the stored balance (Wallets list, Home total) is always the vault's own chain
    if (c === homeChain) await updateMultisigBalance(wallet.id, bal.total);
    setLoadingBalance(false);
  }

  async function loadRequests() {
    const reqs = await getRequestsForWallet(wallet.id);
    setRequests(reqs.sort((a, b) => b.createdAt - a.createdAt));
  }

  async function copyAddress() {
    await navigator.clipboard.writeText(wallet.wallet.address);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const pendingCount = requests.filter((r) => r.status === 'pending').length;

  return (
    <div className="h-full flex flex-col p-4 overflow-y-auto">
      {/* Header */}
      <div className="page-header">
        <button onClick={onBack} className="btn-back">
          <ArrowLeft className="w-5 h-5" />
        </button>
        <h1>{wallet.name}</h1>
        <ChainBadge chain={homeChain} />
        <span className="text-xs bg-white/5 text-gray-300 px-2 py-0.5 rounded-full font-medium">
          {wallet.wallet.config.threshold}-of-{wallet.wallet.config.pubkeys.length}
        </span>
      </div>

      {/* Balance */}
      <div className={`card text-center mb-3 ${chain !== homeChain ? 'border-amber-400/40' : ''}`}>
        <p className={`text-2xl font-bold ${chain === 'xbt' ? 'text-purple-300' : 'text-bitcoin'}`}>
          {loadingBalance ? '...' : formatSats(balance)}
        </p>
        <p className="text-xs text-gray-500 mt-1">
          Balance on {CHAIN_INFO[chain].label}{chain !== homeChain ? ' (not this vault\'s chain)' : ''}
        </p>
        <button
          onClick={() => setChain(chain === homeChain ? other : homeChain)}
          className="mt-2 text-[11px] text-gray-400 hover:text-white underline underline-offset-2"
        >
          {chain === homeChain ? `Also view this address on ${CHAIN_INFO[other].ticker}` : `Back to ${CHAIN_INFO[homeChain].ticker}`}
        </button>
      </div>

      {/* Address + Receive QR */}
      <div className="card mb-3">
        <div className="flex flex-col items-center mb-3">
          <QRCode data={`bitcoin:${wallet.wallet.address}`} size={140} className="mb-2" />
          <p className="text-[10px] text-gray-500">Scan to deposit <b className={chain === 'xbt' ? 'text-purple-300' : 'text-bitcoin'}>{CHAIN_INFO[chain].ticker}</b> to this multisig</p>
        </div>
        <div className="flex items-center gap-2">
          <code className="text-[10px] text-gray-400 break-all flex-1 font-mono">
            {wallet.wallet.address}
          </code>
          <button onClick={copyAddress} className="p-2 hover:bg-surface-700 rounded-lg flex-shrink-0">
            {copied ? <Check className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4 text-gray-500" />}
          </button>
          <a
            href={getMempoolAddressUrl(wallet.wallet.address, chain)}
            target="_blank"
            rel="noopener"
            className="p-2 hover:bg-surface-700 rounded-lg flex-shrink-0"
          >
            <ExternalLink className="w-4 h-4 text-gray-500" />
          </a>
        </div>
        <button
          onClick={copyAddress}
          className="w-full mt-2 flex items-center justify-center gap-1.5 px-4 py-2 rounded-xl bg-surface-700 hover:bg-surface-600 transition-colors text-xs font-medium"
        >
          {copied ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5 text-gray-400" />}
          {copied ? 'Copied!' : 'Copy Address'}
        </button>
      </div>

      {/* Spend action (primary) */}
      <button
        onClick={() => onRequestSignature(chain)}
        className="btn-primary w-full flex items-center justify-center gap-2 mb-4"
      >
        <Send className="w-4 h-4" />
        Spend {CHAIN_INFO[chain].ticker} from this Wallet
      </button>

      {/* Key Holders */}
      <h2 className="text-xs text-gray-500 uppercase tracking-wider mb-2">Key Holders</h2>
      <div className="space-y-1 mb-4">
        {wallet.keyHolders.map((holder) => (
          <KeyHolderRow key={holder.pubkey} holder={holder} />
        ))}
      </div>

      {/* Pending Requests */}
      {requests.length > 0 && (
        <>
          <h2 className="text-xs text-gray-500 uppercase tracking-wider mb-2">
            Signing Requests {pendingCount > 0 && (
              <span className="text-bitcoin">({pendingCount} pending)</span>
            )}
          </h2>
          <div className="space-y-1 mb-4">
            {requests.slice(0, 5).map((req) => (
              <div key={req.id} className="flex items-center gap-3 px-3 py-2 rounded-lg bg-surface-800/50">
                <div className={`w-2 h-2 rounded-full ${
                  req.status === 'pending' ? 'bg-yellow-400' :
                  req.status === 'signed' ? 'bg-green-400' :
                  req.status === 'declined' ? 'bg-red-400' : 'bg-gray-500'
                }`} />
                <div className="flex-1 min-w-0">
                  <p className="text-xs truncate">{req.memo || 'Transaction'}</p>
                  <p className="text-[10px] text-gray-500">
                    {req.direction === 'outbound' ? 'Sent to signer' : 'Received to sign'}
                  </p>
                </div>
                <span className="text-xs text-gray-400">{formatSats(req.amount)}</span>
              </div>
            ))}
          </div>
        </>
      )}

      {/* Actions */}
      <div className="mt-auto space-y-2 pt-4">
        <button
          onClick={() => onRequestSignature(chain)}
          className="btn-primary w-full flex items-center justify-center gap-2"
        >
          <Send className="w-4 h-4" />
          Spend {CHAIN_INFO[chain].ticker} from Wallet
        </button>
        <p className="text-[10px] text-gray-500 text-center">
          Creates a transaction and requests signatures from {wallet.wallet.config.threshold - 1} co-signer{wallet.wallet.config.threshold > 2 ? 's' : ''}
        </p>
      </div>
    </div>
  );
}

// ─── Key Holder Row ─────────────────────────────────────────────

function KeyHolderRow({ holder }: { holder: KeyHolder }) {
  return (
    <div className="flex items-center gap-3 px-3 py-2 rounded-lg bg-surface-800/50">
      <div className="flex-1 min-w-0">
        <ProfileBadge pubkey={holder.pubkey} size="md" showNip05={true} showNpub={!holder.profile?.nip05} />
      </div>
      {holder.isOwnKey && (
        <span className="text-[9px] bg-bitcoin/20 text-bitcoin px-1.5 py-0.5 rounded flex-shrink-0">YOU</span>
      )}
    </div>
  );
}
