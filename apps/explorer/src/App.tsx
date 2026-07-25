import { Routes, Route, Link, Navigate } from 'react-router-dom';
import { Blocks, Info } from 'lucide-react';
import { Feed } from './pages/Feed';
import { TxPage } from './pages/TxPage';
import { ProfilePage } from './pages/ProfilePage';
import { About } from './pages/About';
import { LoginButton } from './components/LoginButton';

export default function App() {
  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-40 bg-ink/90 backdrop-blur border-b border-zinc-800">
        <div className="max-w-feed mx-auto flex items-center gap-3 px-4 py-3">
          <Link to="/" className="flex items-center gap-2 font-bold">
            <Blocks size={22} className="text-bitcoin" />
            <span>
              Nostr <span className="text-bitcoin">Block</span> Chain
            </span>
          </Link>
          <div className="flex-1" />
          <Link to="/about" className="btn-ghost px-2" aria-label="About">
            <Info size={18} />
          </Link>
          <LoginButton />
        </div>
      </header>

      <main className="max-w-feed mx-auto px-4 py-6">
        <Routes>
          <Route path="/" element={<Feed />} />
          <Route path="/tx/:txid" element={<TxPage />} />
          <Route path="/p/:input" element={<ProfilePage />} />
          <Route path="/about" element={<About />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>

      <footer className="max-w-feed mx-auto px-4 py-8 text-center text-xs text-zinc-600">
        Every card below is anchored in a Bitcoin OP_RETURN. Nostr is the content layer; Bitcoin is the timestamp.
      </footer>
    </div>
  );
}
