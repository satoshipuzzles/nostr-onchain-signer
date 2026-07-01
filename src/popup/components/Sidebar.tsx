import { NavLink } from 'react-router-dom';
import {
  LayoutDashboard, Wallet, Inbox, Compass, Settings,
  Shield, Radio, BookOpen, Edit3, Download, Lock,
  Rss, Trophy,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { AccountSwitcher } from './AccountSwitcher';
import { createMessageId } from '@/shared/messages';

const mainNav = [
  { to: '/', icon: LayoutDashboard, label: 'Home' },
  { to: '/feed', icon: Rss, label: 'Feed' },
  { to: '/leaderboard', icon: Trophy, label: 'Leaderboard' },
  { to: '/wallets', icon: Wallet, label: 'Wallets' },
  { to: '/signing', icon: Inbox, label: 'Signing' },
  { to: '/discover', icon: Compass, label: 'Discover' },
];

const settingsNav = [
  { to: '/settings', icon: Settings, label: 'Settings' },
  { to: '/settings/relays', icon: Radio, label: 'Relays' },
  { to: '/settings/profile', icon: Edit3, label: 'Edit Profile' },
];

export function Sidebar() {
  const { myProfile, publicKey, accounts, activeAccountIndex, handleSwitchAccount, handleAddAccount, handleBackupKeys } = useAuth();
  const displayName = myProfile?.displayName || myProfile?.name || 'Anonymous';

  async function handleLock() {
    await chrome.runtime.sendMessage({ type: 'vault:lock', id: createMessageId() });
    window.location.reload();
  }

  return (
    <div className="h-full w-60 bg-surface-800 border-r border-surface-200/10 flex flex-col">
      {/* Logo + App name */}
      <div className="p-4 flex items-center gap-3 border-b border-surface-200/10">
        <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-bitcoin to-nostr flex items-center justify-center flex-shrink-0">
          <Shield className="w-5 h-5 text-white" />
        </div>
        <div className="min-w-0">
          <p className="text-sm font-bold truncate">Nostr Onchain</p>
          <p className="text-[10px] text-gray-500">Signer</p>
        </div>
      </div>

      {/* User profile section */}
      <div className="px-4 py-3 border-b border-surface-200/10">
        <div className="flex items-center gap-2.5">
          {myProfile?.picture ? (
            <img src={myProfile.picture} alt="" className="w-9 h-9 rounded-full object-cover bg-surface-700 flex-shrink-0" />
          ) : (
            <div className="w-9 h-9 rounded-full bg-gradient-to-br from-bitcoin/40 to-nostr/40 flex items-center justify-center flex-shrink-0">
              <span className="text-sm font-bold text-white/80">
                {displayName.charAt(0).toUpperCase()}
              </span>
            </div>
          )}
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium truncate">{displayName}</p>
            <p className="text-[10px] text-gray-500 truncate">
              {publicKey.slice(0, 8)}...{publicKey.slice(-4)}
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
                  ? 'bg-bitcoin/10 text-bitcoin'
                  : 'text-gray-400 hover:bg-surface-700 hover:text-white'
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
                    ? 'bg-bitcoin/10 text-bitcoin'
                    : 'text-gray-400 hover:bg-surface-700 hover:text-white'
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
      <div className="px-3 py-3 border-t border-surface-200/10 space-y-1">
        <button
          onClick={handleBackupKeys}
          className="w-full flex items-center gap-3 px-3 py-2 rounded-xl text-sm text-gray-400 hover:bg-surface-700 hover:text-white transition-colors"
        >
          <Download className="w-4 h-4" />
          Backup Keys
        </button>
        <button
          onClick={handleLock}
          className="w-full flex items-center gap-3 px-3 py-2 rounded-xl text-sm text-gray-400 hover:bg-surface-700 hover:text-red-400 transition-colors"
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
