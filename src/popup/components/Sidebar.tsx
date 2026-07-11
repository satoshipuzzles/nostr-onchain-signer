import { NavLink } from 'react-router-dom';
import {
  LayoutDashboard, Wallet, Inbox, Compass, Settings,
  Shield, Radio, Edit3, Download, Lock,
  Rss, Trophy, MessageCircle, Fingerprint, Unlock, Blocks,
  Gamepad2,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { AccountSwitcher } from './AccountSwitcher';
import { ClickableAvatar } from './ClickableAvatar';
import { createMessageId } from '@/shared/messages';
import { pubkeyToNpub } from '@/lib/nostr/keys';

const mainNav = [
  { to: '/', icon: LayoutDashboard, label: 'Home' },
  { to: '/feed', icon: Rss, label: 'Feed' },
  { to: '/messages', icon: MessageCircle, label: 'Messages' },
  { to: '/leaderboard', icon: Trophy, label: 'Leaderboard' },
  { to: '/wallets', icon: Wallet, label: 'Wallets' },
  { to: '/signing', icon: Inbox, label: 'Signing' },
  { to: '/lightops', icon: Fingerprint, label: 'Light OPs' },
  { to: '/unlocks', icon: Unlock, label: 'Social Unlocks' },
  { to: '/discover', icon: Compass, label: 'Discover' },
  { to: '/explorer', icon: Blocks, label: 'Explorer' },
  { to: '/other', icon: Gamepad2, label: 'Audio & Games' },
];

const settingsNav = [
  { to: '/settings', icon: Settings, label: 'Settings' },
  { to: '/settings/relays', icon: Radio, label: 'Relays' },
  { to: '/settings/profile', icon: Edit3, label: 'Edit Profile' },
];

export function Sidebar() {
  const { myProfile, publicKey, accounts, activeAccountIndex, handleSwitchAccount, handleAddAccount, handleBackupKeys } = useAuth();
  const activeAccount = accounts[activeAccountIndex];
  const displayName = myProfile?.displayName || myProfile?.name || activeAccount?.displayName || activeAccount?.label || 'Anonymous';
  const npub = activeAccount?.npub || pubkeyToNpub(publicKey);

  async function handleLock() {
    await chrome.runtime.sendMessage({ type: 'vault:lock', id: createMessageId() });
    window.location.reload();
  }

  return (
    <div className="h-full w-60 bg-black border-r border-white/10 flex flex-col">
      {/* Logo + App name */}
      <div className="p-4 flex items-center gap-3 border-b border-white/10">
        <img src="/logo.svg" alt="Nostr Onchain" className="w-9 h-9 rounded-xl flex-shrink-0" />
        <div className="min-w-0">
          <p className="text-sm font-bold truncate">Nostr Onchain</p>
          <p className="text-[10px] text-gray-500">Signer</p>
        </div>
      </div>

      {/* User profile section */}
      <div className="px-4 py-3 border-b border-white/10">
        <div className="flex items-center gap-2.5">
          <ClickableAvatar
            key={publicKey}
            pubkey={publicKey}
            picture={myProfile?.picture || activeAccount?.picture}
            name={displayName}
            size="md"
          />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium truncate">{displayName}</p>
            <p className="text-[10px] text-gray-500 truncate font-mono" title={npub}>
              {npub.slice(0, 14)}...{npub.slice(-6)}
            </p>
          </div>
        </div>
      </div>

      {/* Main navigation */}
      <nav className="flex-1 px-2 py-3 space-y-0.5 overflow-y-auto">
        <p className="text-[10px] text-gray-500 uppercase tracking-wider px-3 mb-2">Navigation</p>
        {mainNav.map(({ to, icon: Icon, label }) => (
          <NavLink
            key={to}
            to={to}
            end={to === '/'}
            className={({ isActive }) =>
              `flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-colors ${
                isActive
                  ? 'bg-white/10 text-white'
                  : 'text-gray-400 hover:bg-white/5 hover:text-white'
              }`
            }
          >
            <Icon className="w-4.5 h-4.5" />
            {label}
          </NavLink>
        ))}

        <div className="pt-4">
          <p className="text-[10px] text-gray-500 uppercase tracking-wider px-3 mb-2">Settings</p>
          {settingsNav.map(({ to, icon: Icon, label }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                `flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-colors ${
                  isActive
                    ? 'bg-white/10 text-white'
                    : 'text-gray-400 hover:bg-white/5 hover:text-white'
                }`
              }
            >
              <Icon className="w-4.5 h-4.5" />
              {label}
            </NavLink>
          ))}
        </div>
      </nav>

      {/* Bottom actions */}
      <div className="px-3 py-3 border-t border-white/10 space-y-1">
        <button
          onClick={handleBackupKeys}
          className="w-full flex items-center gap-3 px-3 py-2 rounded-xl text-sm text-gray-400 hover:bg-white/5 hover:text-white transition-colors"
        >
          <Download className="w-4 h-4" />
          Backup Keys
        </button>
        <button
          onClick={handleLock}
          className="w-full flex items-center gap-3 px-3 py-2 rounded-xl text-sm text-gray-400 hover:bg-white/5 hover:text-red-400 transition-colors"
        >
          <Lock className="w-4 h-4" />
          Lock
        </button>
      </div>

      {/* Account switcher */}
      <div className="px-3 pb-3">
        <AccountSwitcher
          accounts={accounts}
          activeIndex={activeAccountIndex}
          onSwitch={handleSwitchAccount}
          onAddAccount={handleAddAccount}
        />
      </div>
    </div>
  );
}
