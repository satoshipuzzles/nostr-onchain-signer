import { NavLink } from 'react-router-dom';
import { LayoutDashboard, Wallet, Rss, MessageCircle, Menu, Search, Bell } from 'lucide-react';

const tabs = [
  { to: '/', icon: LayoutDashboard, label: 'Home' },
  { to: '/feed', icon: Rss, label: 'Feed' },
  { to: '/find', icon: Search, label: 'Search' },
  { to: '/notifications', icon: Bell, label: 'Alerts' },
  { to: '/wallets', icon: Wallet, label: 'Wallets' },
  { to: '/messages', icon: MessageCircle, label: 'Messages' },
  { to: '/more', icon: Menu, label: 'More' },
];

export function BottomNav({ unread = 0 }: { unread?: number }) {
  return (
    <nav className="fixed bottom-0 left-0 right-0 bg-black/95 backdrop-blur-md border-t border-white/10 z-50"
      style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
    >
      <div className="flex items-center justify-around h-14">
        {tabs.map(({ to, icon: Icon, label }) => (
          <NavLink
            key={to}
            to={to}
            end={to === '/'}
            className={({ isActive }) =>
              `flex flex-col items-center justify-center gap-0.5 px-2 py-1.5 min-w-[46px] rounded-lg transition-colors ${
                isActive
                  ? 'text-white'
                  : 'text-gray-600 hover:text-gray-400'
              }`
            }
          >
            {({ isActive }) => (
              <>
                <span className="relative">
                  <Icon className={`w-5 h-5 ${isActive ? 'text-white' : ''}`} />
                  {to === '/notifications' && unread > 0 && (
                    <span className="absolute -top-1.5 -right-2.5 min-w-[16px] h-4 px-1 rounded-full bg-purple-500 text-white text-[9px] font-bold flex items-center justify-center" data-testid="notif-badge">
                      {unread > 99 ? '99+' : unread}
                    </span>
                  )}
                </span>
                <span className={`text-[10px] font-medium ${isActive ? 'text-white' : ''}`}>
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
