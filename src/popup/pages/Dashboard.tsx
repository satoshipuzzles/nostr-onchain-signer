import { useState } from 'react';
import { pubkeyToNpub } from '@/lib/nostr/keys';
import { pubkeyToTaprootAddress } from '@/lib/bitcoin/address';
import { createMessageId } from '@/shared/messages';
import { type ProfileMetadata } from '@/lib/nostr/social';
import {
  Copy, Users, Send, Lock, Check, Radio, Compass,
  Settings, Edit3, Server, Wallet,
} from 'lucide-react';

type Page = 'loading' | 'setup' | 'unlock' | 'dashboard' | 'multisig' | 'multisig-vault' | 'request-sig' | 'send' | 'signing' | 'discover' | 'profile-view' | 'relays' | 'edit-profile' | 'wallet';

interface Props {
  publicKey: string;
  profile: ProfileMetadata | null;
  followingCount: number;
  onNavigate: (page: Page) => void;
}

export function Dashboard({ publicKey, profile, followingCount, onNavigate }: Props) {
  const [copied, setCopied] = useState('');
  const npub = pubkeyToNpub(publicKey);
  const btcAddress = pubkeyToTaprootAddress(publicKey);
  const displayName = profile?.displayName || profile?.name || 'Anonymous';

  async function copyToClipboard(text: string, label: string) {
    await navigator.clipboard.writeText(text);
    setCopied(label);
    setTimeout(() => setCopied(''), 2000);
  }

  async function handleLock() {
    await chrome.runtime.sendMessage({ type: 'vault:lock', id: createMessageId() });
    window.close();
  }

  return (
    <div className="h-full flex flex-col p-4 overflow-y-auto">
      {/* Profile Header */}
      <div className="flex items-center gap-3 mb-4">
        <button onClick={() => onNavigate('edit-profile')} className="relative flex-shrink-0">
          {profile?.picture ? (
            <img src={profile.picture} alt="" className="w-11 h-11 rounded-full object-cover bg-surface-700" />
          ) : (
            <div className="w-11 h-11 rounded-full bg-gradient-to-br from-bitcoin/40 to-nostr/40 flex items-center justify-center">
              <span className="text-base font-bold text-white/80">
                {displayName.charAt(0).toUpperCase()}
              </span>
            </div>
          )}
          <div className="absolute -bottom-0.5 -right-0.5 w-4 h-4 bg-surface-900 rounded-full flex items-center justify-center">
            <Edit3 className="w-2.5 h-2.5 text-gray-400" />
          </div>
        </button>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold truncate">{displayName}</p>
          <p className="text-xs text-gray-500">{followingCount} following</p>
        </div>
        <button onClick={() => onNavigate('relays')} className="p-2 hover:bg-surface-700 rounded-lg">
          <Server className="w-4 h-4 text-gray-400" />
        </button>
        <button onClick={handleLock} className="p-2 hover:bg-surface-700 rounded-lg">
          <Lock className="w-4 h-4 text-gray-400" />
        </button>
      </div>

      {/* Nostr Identity */}
      <div className="card mb-2">
        <div className="flex items-center gap-2 mb-1.5">
          <div className="w-1.5 h-1.5 rounded-full bg-nostr" />
          <span className="text-[10px] text-gray-500 uppercase tracking-wider">Nostr</span>
        </div>
        <div className="flex items-center gap-2">
          <code className="text-xs text-gray-300 truncate flex-1 font-mono">
            {npub.slice(0, 22)}...{npub.slice(-6)}
          </code>
          <button onClick={() => copyToClipboard(npub, 'npub')} className="p-1 hover:bg-surface-700 rounded">
            {copied === 'npub' ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3 text-gray-500" />}
          </button>
        </div>
      </div>

      {/* Bitcoin Address */}
      <button onClick={() => onNavigate('wallet')} className="card mb-4 w-full text-left hover:border-bitcoin/30 transition-colors">
        <div className="flex items-center gap-2 mb-1.5">
          <div className="w-1.5 h-1.5 rounded-full bg-bitcoin" />
          <span className="text-[10px] text-gray-500 uppercase tracking-wider">Bitcoin (Taproot)</span>
          <Wallet className="w-3 h-3 text-gray-600 ml-auto" />
        </div>
        <div className="flex items-center gap-2">
          <code className="text-xs text-gray-300 truncate flex-1 font-mono">
            {btcAddress.slice(0, 20)}...{btcAddress.slice(-6)}
          </code>
          <button onClick={(e) => { e.stopPropagation(); copyToClipboard(btcAddress, 'btc'); }} className="p-1 hover:bg-surface-700 rounded">
            {copied === 'btc' ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3 text-gray-500" />}
          </button>
        </div>
      </button>

      {/* Actions */}
      <div className="space-y-2">
        <button onClick={() => onNavigate('send')} className="btn-primary w-full flex items-center justify-center gap-2">
          <Send className="w-4 h-4" />
          Send + Note
        </button>

        <div className="grid grid-cols-2 gap-2">
          <button onClick={() => onNavigate('multisig-vault')} className="btn-secondary flex items-center justify-center gap-1.5 text-sm">
            <Users className="w-3.5 h-3.5" />
            Multi-Sig
          </button>
          <button onClick={() => onNavigate('discover')} className="btn-secondary flex items-center justify-center gap-1.5 text-sm">
            <Compass className="w-3.5 h-3.5" />
            Discover
          </button>
        </div>

        <button onClick={() => onNavigate('signing')} className="btn-secondary w-full flex items-center justify-center gap-2 text-sm">
          <Radio className="w-3.5 h-3.5" />
          Signing Rounds
        </button>
      </div>

      {/* Status footer */}
      <div className="mt-auto pt-4 text-center">
        <p className="text-[10px] text-gray-600">
          NIP-07 active &bull; Bitcoin signer ready &bull; v0.1.0
        </p>
      </div>
    </div>
  );
}
