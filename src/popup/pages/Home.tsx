import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Send, Shield, Copy, Check, Wallet, Edit3, Inbox, Fingerprint, Unlock, Blocks } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { pubkeyToNpub } from '@/lib/nostr/keys';
import { pubkeyToTaprootAddress } from '@/lib/bitcoin/address';
import { fetchBalance, formatSats } from '@/lib/bitcoin/mempool';
import { loadMultisigWallets, type ArchivedMultisig } from '@/lib/bitcoin/wallet-store';
import { loadSigningRounds, type SigningRound } from '@/lib/bitcoin/signing-round';
import { safeImageUrl } from '@/lib/utils';

export function Home() {
  const navigate = useNavigate();
  const { publicKey, myProfile, following, accounts } = useAuth();
  const [balance, setBalance] = useState<number | null>(null);
  const [pendingSignatures, setPendingSignatures] = useState(0);
  const [multisigCount, setMultisigCount] = useState(0);
  const [copied, setCopied] = useState('');

  const npub = pubkeyToNpub(publicKey);
  const btcAddress = pubkeyToTaprootAddress(publicKey);
  const displayName = myProfile?.displayName || myProfile?.name || 'Anonymous';

  useEffect(() => {
    loadDashboardData();
  }, [publicKey]);

  async function loadDashboardData() {
    try {
      const [bal, wallets, rounds] = await Promise.allSettled([
        fetchBalance(btcAddress),
        loadMultisigWallets(),
        loadSigningRounds(),
      ]);
      if (bal.status === 'fulfilled') setBalance(bal.value.total);
      if (wallets.status === 'fulfilled') setMultisigCount(wallets.value.length);
      if (rounds.status === 'fulfilled') {
        const pending = rounds.value.filter((r: SigningRound) => r.status === 'collecting');
        setPendingSignatures(pending.length);
      }
    } catch {}
  }

  async function copyToClipboard(text: string, label: string) {
    await navigator.clipboard.writeText(text);
    setCopied(label);
    setTimeout(() => setCopied(''), 2000);
  }

  return (
    <div className="h-full flex flex-col p-4 md:p-6">
      {/* Mobile profile header */}
      <div className="flex items-center gap-3 mb-5 md:mb-6">
        <button onClick={() => navigate('/settings/profile')} className="relative flex-shrink-0">
          {myProfile?.picture ? (
            <img src={safeImageUrl(myProfile.picture)} alt="" className="w-12 h-12 rounded-full object-cover bg-surface-700" />
          ) : (
            <div className="w-12 h-12 rounded-full bg-gradient-to-br from-bitcoin/40 to-nostr/40 flex items-center justify-center">
              <span className="text-lg font-bold text-white/80">
                {displayName.charAt(0).toUpperCase()}
              </span>
            </div>
          )}
          <div className="absolute -bottom-0.5 -right-0.5 w-5 h-5 bg-surface-900 rounded-full flex items-center justify-center">
            <Edit3 className="w-3 h-3 text-gray-400" />
          </div>
        </button>
        <div className="flex-1 min-w-0">
          <p className="text-base font-semibold truncate">{displayName}</p>
          <p className="text-xs text-gray-500">{following instanceof Set ? following.size : 0} following &bull; {accounts.length} account{accounts.length !== 1 ? 's' : ''}</p>
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-5">
        {/* Balance card */}
        <button
          onClick={() => navigate('/wallets')}
          className="card hover:border-bitcoin/30 transition-colors text-left"
        >
          <div className="flex items-center gap-2 mb-2">
            <div className="w-8 h-8 rounded-lg bg-bitcoin/15 flex items-center justify-center">
              <Wallet className="w-4 h-4 text-bitcoin" />
            </div>
            <span className="text-xs text-gray-500">Balance</span>
          </div>
          <p className="text-xl font-bold text-bitcoin">
            {balance !== null ? formatSats(balance) : '—'}
          </p>
          <p className="text-[10px] text-gray-500 mt-1">Taproot wallet</p>
        </button>

        {/* Pending signatures card */}
        <button
          onClick={() => navigate('/signing')}
          className="card hover:border-nostr/30 transition-colors text-left"
        >
          <div className="flex items-center gap-2 mb-2">
            <div className="w-8 h-8 rounded-lg bg-nostr/15 flex items-center justify-center">
              <Inbox className="w-4 h-4 text-nostr" />
            </div>
            <span className="text-xs text-gray-500">Pending</span>
          </div>
          <p className="text-xl font-bold text-white">
            {pendingSignatures}
          </p>
          <p className="text-[10px] text-gray-500 mt-1">Signing rounds</p>
        </button>

        {/* Multi-sig wallets card */}
        <button
          onClick={() => navigate('/wallets')}
          className="card hover:border-green-500/30 transition-colors text-left"
        >
          <div className="flex items-center gap-2 mb-2">
            <div className="w-8 h-8 rounded-lg bg-green-500/15 flex items-center justify-center">
              <Shield className="w-4 h-4 text-green-400" />
            </div>
            <span className="text-xs text-gray-500">Multi-Sig</span>
          </div>
          <p className="text-xl font-bold text-white">
            {multisigCount}
          </p>
          <p className="text-[10px] text-gray-500 mt-1">Wallets</p>
        </button>
      </div>

      {/* Identity cards */}
      <div className="space-y-2 mb-5">
        {/* Nostr Identity */}
        <div className="card">
          <div className="flex items-center gap-2 mb-1.5">
            <div className="w-1.5 h-1.5 rounded-full bg-nostr" />
            <span className="text-[10px] text-gray-500 uppercase tracking-wider">Nostr</span>
          </div>
          <div className="flex items-center gap-2">
            <code className="text-xs text-gray-300 truncate flex-1 font-mono">
              {npub.slice(0, 22)}...{npub.slice(-6)}
            </code>
            <button onClick={() => copyToClipboard(npub, 'npub')} className="p-1.5 hover:bg-surface-700 rounded-lg">
              {copied === 'npub' ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3 text-gray-500" />}
            </button>
          </div>
        </div>

        {/* Bitcoin Address */}
        <div className="card">
          <div className="flex items-center gap-2 mb-1.5">
            <div className="w-1.5 h-1.5 rounded-full bg-bitcoin" />
            <span className="text-[10px] text-gray-500 uppercase tracking-wider">Bitcoin (Taproot)</span>
          </div>
          <div className="flex items-center gap-2">
            <code className="text-xs text-gray-300 truncate flex-1 font-mono">
              {btcAddress.slice(0, 20)}...{btcAddress.slice(-6)}
            </code>
            <button onClick={() => copyToClipboard(btcAddress, 'btc')} className="p-1.5 hover:bg-surface-700 rounded-lg">
              {copied === 'btc' ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3 text-gray-500" />}
            </button>
          </div>
        </div>
      </div>

      {/* Quick actions */}
      <div className="space-y-2 mt-auto">
        <button
          onClick={() => navigate('/send')}
          className="btn-primary w-full flex items-center justify-center gap-2"
        >
          <Send className="w-4 h-4" />
          Transaction Builder
        </button>

        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={() => navigate('/wallets/create')}
            className="btn-secondary flex items-center justify-center gap-1.5 text-sm"
          >
            <Shield className="w-3.5 h-3.5" />
            Create Multi-Sig
          </button>
          <button
            onClick={() => navigate('/lightops')}
            className="btn-secondary flex items-center justify-center gap-1.5 text-sm"
          >
            <Fingerprint className="w-3.5 h-3.5" />
            Light OPs
          </button>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={() => navigate('/unlocks')}
            className="btn-secondary flex items-center justify-center gap-1.5 text-sm"
          >
            <Unlock className="w-3.5 h-3.5" />
            Social Unlocks
          </button>
          <button
            onClick={() => navigate('/explorer')}
            className="btn-secondary flex items-center justify-center gap-1.5 text-sm"
          >
            <Blocks className="w-3.5 h-3.5" />
            Explorer
          </button>
        </div>
      </div>
    </div>
  );
}
