import { Link } from 'react-router-dom';
import {
  Rss, Trophy, MessageCircle, Fingerprint, Unlock, Blocks,
  Inbox, Compass, Settings, Radio, Edit3, Download, Lock,
  Shield,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { createMessageId } from '@/shared/messages';

const sections = [
  {
    title: 'Social',
    items: [
      { to: '/feed', icon: Rss, label: 'Feed' },
      { to: '/messages', icon: MessageCircle, label: 'Messages' },
      { to: '/leaderboard', icon: Trophy, label: 'Leaderboard' },
      { to: '/discover', icon: Compass, label: 'Discover' },
    ],
  },
  {
    title: 'Bitcoin',
    items: [
      { to: '/signing', icon: Inbox, label: 'Signing Inbox' },
      { to: '/lightops', icon: Fingerprint, label: 'Light OPs' },
      { to: '/unlocks', icon: Unlock, label: 'Social Unlocks' },
      { to: '/explorer', icon: Blocks, label: 'Explorer' },
    ],
  },
  {
    title: 'Settings',
    items: [
      { to: '/settings', icon: Settings, label: 'Settings' },
      { to: '/settings/relays', icon: Radio, label: 'Relays' },
      { to: '/settings/profile', icon: Edit3, label: 'Edit Profile' },
      { to: '/settings/apps', icon: Shield, label: 'Connected Apps' },
    ],
  },
];

export default function MoreMenu() {
  const { handleBackupKeys } = useAuth();

  async function handleLock() {
    await chrome.runtime.sendMessage({ type: 'vault:lock', id: createMessageId() });
    window.location.reload();
  }

  return (
    <div className="p-4 pb-24 space-y-6">
      <h1 className="text-xl font-bold">Menu</h1>

      {sections.map((section) => (
        <div key={section.title}>
          <p className="text-[11px] text-gray-500 uppercase tracking-wider mb-2 px-1">
            {section.title}
          </p>
          <div className="grid grid-cols-2 gap-2">
            {section.items.map(({ to, icon: Icon, label }) => (
              <Link
                key={to}
                to={to}
                className="flex items-center gap-3 px-4 py-3.5 rounded-xl bg-white/[0.04] border border-white/5 hover:bg-white/[0.08] transition-colors"
              >
                <Icon className="w-5 h-5 text-gray-400" />
                <span className="text-sm font-medium">{label}</span>
              </Link>
            ))}
          </div>
        </div>
      ))}

      <div className="pt-2 space-y-2">
        <button
          onClick={handleBackupKeys}
          className="w-full flex items-center gap-3 px-4 py-3.5 rounded-xl bg-white/[0.04] border border-white/5 hover:bg-white/[0.08] transition-colors"
        >
          <Download className="w-5 h-5 text-gray-400" />
          <span className="text-sm font-medium">Backup Keys</span>
        </button>
        <button
          onClick={handleLock}
          className="w-full flex items-center gap-3 px-4 py-3.5 rounded-xl bg-white/[0.04] border border-red-500/20 hover:bg-red-500/10 transition-colors"
        >
          <Lock className="w-5 h-5 text-red-400" />
          <span className="text-sm font-medium text-red-400">Lock</span>
        </button>
      </div>
    </div>
  );
}
