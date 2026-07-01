import { useState, useEffect } from 'react';
import {
  ArrowLeft, Plus, Wallet, Users, Clock, ExternalLink,
  Copy, Check, Send, Loader2, ChevronRight, Shield,
} from 'lucide-react';
import { pubkeyToNpub } from '@/lib/nostr/keys';
import { getMempoolAddressUrl, fetchBalance, formatSats } from '@/lib/bitcoin/mempool';
import {
  loadMultisigWallets, saveMultisigWallet, updateMultisigBalance,
  type ArchivedMultisig, type KeyHolder, type PendingSignatureRequest,
  getRequestsForWallet,
} from '@/lib/bitcoin/wallet-store';

interface Props {
  publicKey: string;
  onCreateNew: () => void;
  onRequestSignature: (wallet: ArchivedMultisig) => void;
  onBack: () => void;
}

export function MultisigVault({ publicKey, onCreateNew, onRequestSignature, onBack }: Props) {
  const [wallets, setWallets] = useState<ArchivedMultisig[]>([]);
  const [selectedWallet, setSelectedWallet] = useState<ArchivedMultisig | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadWallets();
  }, []);

  async function loadWallets() {
    setLoading(true);
    const all = await loadMultisigWallets();
    setWallets(all.sort((a, b) => b.lastActivityAt - a.lastActivityAt));
    setLoading(false);
  }

  if (selectedWallet) {
    return (
      <WalletDetail
        wallet={selectedWallet}
        onRequestSignature={() => onRequestSignature(selectedWallet)}
        onBack={() => { setSelectedWallet(null); loadWallets(); }}
      />
    );
  }

  return (
    <div className="h-full flex flex-col p-4">
      {/* Header */}
      <div className="flex items-center gap-2 mb-4">
        <button onClick={onBack} className="p-1.5 hover:bg-surface-700 rounded-lg">
          <ArrowLeft className="w-4 h-4" />
        </button>
        <h1 className="text-lg font-bold flex-1">Multi-Sig Wallets</h1>
        <button onClick={onCreateNew} className="p-1.5 bg-bitcoin/20 text-bitcoin rounded-lg hover:bg-bitcoin/30">
          <Plus className="w-4 h-4" />
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
            <span className="text-[10px] bg-bitcoin/15 text-bitcoin px-1.5 py-0.5 rounded font-mono">
              {wallet.wallet.config.threshold}/{wallet.wallet.config.pubkeys.length}
            </span>
          </div>
          <p className="text-xs text-gray-500 font-mono truncate">
            {wallet.wallet.address.slice(0, 16)}...
          </p>
        </div>

        <div className="text-right flex-shrink-0">
          {wallet.currentBalance > 0 ? (
            <p className="text-sm font-medium text-bitcoin">{formatSats(wallet.currentBalance)}</p>
          ) : (
            <ChevronRight className="w-4 h-4 text-gray-600" />
          )}
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
  onRequestSignature: () => void;
  onBack: () => void;
}) {
  const [balance, setBalance] = useState(wallet.currentBalance);
  const [loadingBalance, setLoadingBalance] = useState(false);
  const [copied, setCopied] = useState(false);
  const [requests, setRequests] = useState<PendingSignatureRequest[]>([]);

  useEffect(() => {
    refreshBalance();
    loadRequests();
  }, []);

  async function refreshBalance() {
    setLoadingBalance(true);
    const bal = await fetchBalance(wallet.wallet.address);
    setBalance(bal.total);
    await updateMultisigBalance(wallet.id, bal.total);
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
      <div className="flex items-center gap-2 mb-4">
        <button onClick={onBack} className="p-1.5 hover:bg-surface-700 rounded-lg">
          <ArrowLeft className="w-4 h-4" />
        </button>
        <h1 className="text-lg font-bold flex-1 truncate">{wallet.name}</h1>
        <span className="text-xs bg-bitcoin/15 text-bitcoin px-2 py-0.5 rounded-full font-medium">
          {wallet.wallet.config.threshold}-of-{wallet.wallet.config.pubkeys.length}
        </span>
      </div>

      {/* Balance */}
      <div className="card text-center mb-3">
        <p className="text-2xl font-bold text-bitcoin">
          {loadingBalance ? '...' : formatSats(balance)}
        </p>
        <p className="text-xs text-gray-500 mt-1">Current balance</p>
      </div>

      {/* Address */}
      <div className="card mb-3">
        <div className="flex items-center gap-2">
          <code className="text-[10px] text-gray-400 truncate flex-1 font-mono">
            {wallet.wallet.address}
          </code>
          <button onClick={copyAddress} className="p-1 hover:bg-surface-700 rounded">
            {copied ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3 text-gray-500" />}
          </button>
          <a
            href={getMempoolAddressUrl(wallet.wallet.address)}
            target="_blank"
            rel="noopener"
            className="p-1 hover:bg-surface-700 rounded"
          >
            <ExternalLink className="w-3 h-3 text-gray-500" />
          </a>
        </div>
      </div>

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
      <div className="mt-auto space-y-2">
        <button
          onClick={onRequestSignature}
          className="btn-primary w-full flex items-center justify-center gap-2"
        >
          <Send className="w-4 h-4" />
          Request Signatures
        </button>
      </div>
    </div>
  );
}

// ─── Key Holder Row ─────────────────────────────────────────────

function KeyHolderRow({ holder }: { holder: KeyHolder }) {
  const displayName = holder.profile?.displayName || holder.profile?.name || holder.pubkey.slice(0, 12);
  const npub = pubkeyToNpub(holder.pubkey);

  return (
    <div className="flex items-center gap-3 px-3 py-2 rounded-lg bg-surface-800/50">
      {holder.profile?.picture ? (
        <img src={holder.profile.picture} alt="" className="w-8 h-8 rounded-full object-cover bg-surface-700" />
      ) : (
        <div className="w-8 h-8 rounded-full bg-gradient-to-br from-bitcoin/30 to-nostr/30 flex items-center justify-center">
          <span className="text-xs font-bold text-white/70">{displayName.charAt(0).toUpperCase()}</span>
        </div>
      )}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <p className="text-sm truncate">{displayName}</p>
          {holder.isOwnKey && (
            <span className="text-[9px] bg-bitcoin/20 text-bitcoin px-1.5 py-0.5 rounded">YOU</span>
          )}
        </div>
        <p className="text-[10px] text-gray-500 font-mono truncate">
          {holder.profile?.nip05 || `${npub.slice(0, 18)}...`}
        </p>
      </div>
    </div>
  );
}
