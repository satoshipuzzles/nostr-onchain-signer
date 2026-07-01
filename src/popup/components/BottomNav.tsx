import { NavLink } from 'react-router-dom';
import { LayoutDashboard, Wallet, Inbox, Rss, Settings } from 'lucide-react';

const tabs = [
  { to: '/', icon: LayoutDashboard, label: 'Home' },
  { to: '/feed', icon: Rss, label: 'Feed' },
  { to: '/wallets', icon: Wallet, label: 'Wallets' },
  { to: '/signing', icon: Inbox, label: 'Signing' },
  { to: '/settings', icon: Settings, label: 'Settings' },
];

export function BottomNav() {
  return (
    <nav className="fixed bottom-0 left-0 right-0 bg-surface-900/95 backdrop-blur-lg border-t border-surface-200/10 z-50"
      style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
    >
      <div className="flex items-center justify-around h-14">
        {tabs.map(({ to, icon: Icon, label }) => (
          <NavLink
            key={to}
            to={to}
            end={to === '/'}
            className={({ isActive }) =>
              `flex flex-col items-center justify-center gap-0.5 px-3 py-1.5 rounded-lg transition-colors ${
                isActive
                  ? 'text-bitcoin'
                  : 'text-gray-500 hover:text-gray-300'
              }`
            }
          >
            {({ isActive }) => (
              <>
                <Icon className={`w-5 h-5 ${isActive ? 'text-bitcoin' : ''}`} />
                <span className={`text-[10px] font-medium ${isActive ? 'text-bitcoin' : ''}`}>
                  {label}
                </span>
              </>
            )}
          </NavLink>
        ))}
      </div>
    </nav>
  );
}
