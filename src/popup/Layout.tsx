import { Suspense } from 'react';
import { Outlet } from 'react-router-dom';
import { Sidebar } from './components/Sidebar';
import { BottomNav } from './components/BottomNav';
import { StatusBar } from './components/StatusBar';

export function Layout() {
  return (
    <div className="h-full flex flex-col overflow-hidden">
      <StatusBar />

      <div className="flex-1 flex min-h-0">
        {/* Desktop sidebar */}
        <aside className="hidden md:flex md:w-60 md:flex-shrink-0">
          <Sidebar />
        </aside>

        {/* Main content — single scroll container. Suspense here keeps the
            nav/shell visible while a lazy-loaded page chunk downloads */}
        <main className="flex-1 min-w-0 min-h-0 overflow-y-auto pb-20 md:pb-0">
          <Suspense
            fallback={
              <div className="h-full min-h-[40vh] flex items-center justify-center">
                <div className="animate-pulse text-gray-500 text-sm">Loading…</div>
              </div>
            }
          >
            <Outlet />
          </Suspense>
        </main>

        {/* Mobile bottom nav */}
        <div className="md:hidden">
          <BottomNav />
        </div>
      </div>
    </div>
  );
}
