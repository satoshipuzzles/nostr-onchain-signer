import { Outlet, NavLink } from 'react-router-dom';
import { Wallet, Hammer, FolderOpen, Users, Settings as SettingsIcon } from 'lucide-react';

const tabs = [
  { to: '/', icon: Wallet, label: 'Wallets' },
  { to: '/send', icon: Hammer, label: 'Build' },
  { to: '/files', icon: FolderOpen, label: 'Files' },
  { to: '/contacts', icon: Users, label: 'People' },
  { to: '/settings', icon: SettingsIcon, label: 'Settings' },
];

export function Layout() {
  return (
    <div className="min-h-screen flex flex-col md:flex-row max-w-5xl mx-auto">
      {/* Desktop sidebar */}
      <nav className="hidden md:flex flex-col gap-1 w-52 shrink-0 p-4 border-r border-stone-800 min-h-screen safe-top">
        <div className="flex items-center gap-2 px-3 py-4">
          <img src="/icon.svg" alt="" className="w-8 h-8" />
          <div className="text-sm font-bold leading-tight">
            Bitcoin Wallet
            <br />
            Manager
          </div>
        </div>
        {tabs.map(({ to, icon: Icon, label }) => (
          <NavLink
            key={to}
            to={to}
            end={to === '/'}
            className={({ isActive }) =>
              `flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium ${
                isActive ? 'bg-accent/15 text-accent' : 'text-stone-400 hover:text-stone-200 hover:bg-surface-overlay'
              }`
            }
          >
            <Icon size={18} />
            {label}
          </NavLink>
        ))}
      </nav>

      {/* Content */}
      <main className="flex-1 safe-top pb-24 md:pb-8 px-4 pt-4 md:pt-8 max-w-2xl w-full mx-auto">
        <Outlet />
      </main>

      {/* Mobile bottom tab bar */}
      <nav className="md:hidden fixed bottom-0 inset-x-0 bg-surface-raised/95 backdrop-blur border-t border-stone-800 safe-bottom z-40">
        <div className="flex justify-around">
          {tabs.map(({ to, icon: Icon, label }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              className={({ isActive }) =>
                `flex flex-col items-center gap-1 py-2.5 px-3 text-[10px] font-medium ${
                  isActive ? 'text-accent' : 'text-stone-500'
                }`
              }
            >
              <Icon size={20} />
              {label}
            </NavLink>
          ))}
        </div>
      </nav>
    </div>
  );
}
