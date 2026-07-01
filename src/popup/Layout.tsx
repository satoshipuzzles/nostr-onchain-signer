import { Outlet } from 'react-router-dom';
import { Sidebar } from './components/Sidebar';
import { BottomNav } from './components/BottomNav';
import { StatusBar } from './components/StatusBar';

export function Layout() {
  return (
    <div className="h-full flex flex-col">
      {/* BTC price / block height / fee ticker */}
      <StatusBar />

      <div className="flex-1 flex min-h-0">
        {/* Desktop sidebar */}
        <aside className="hidden md:flex md:w-60 md:flex-shrink-0">
          <Sidebar />
        </aside>

        {/* Main content */}
        <main className="flex-1 flex flex-col min-w-0 h-full">
          <div className="flex-1 overflow-y-auto pb-16 md:pb-0">
            <Outlet />
          </div>

          {/* Mobile bottom nav */}
          <div className="md:hidden">
            <BottomNav />
          </div>
        </main>
      </div>
    </div>
  );
}
