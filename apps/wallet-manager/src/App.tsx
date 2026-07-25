import { useEffect, useState } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { vaultExists, isUnlocked, onVaultChange } from './lib/vault';
import { Layout } from './components/Layout';
import { Onboarding } from './pages/Onboarding';
import { Unlock } from './pages/Unlock';
import { Home } from './pages/Home';
import { WalletDetail } from './pages/WalletDetail';
import { Builder } from './pages/Builder';
import { Files } from './pages/Files';
import { FileEditor } from './pages/FileEditor';
import { Contacts } from './pages/Contacts';
import { Settings } from './pages/Settings';

export default function App() {
  const [, forceRender] = useState(0);
  useEffect(() => onVaultChange(() => forceRender((n) => n + 1)), []);

  if (!vaultExists()) return <Onboarding />;
  if (!isUnlocked()) return <Unlock />;

  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<Home />} />
        <Route path="/wallet/:id" element={<WalletDetail />} />
        <Route path="/send" element={<Builder />} />
        <Route path="/files" element={<Files />} />
        <Route path="/files/:id" element={<FileEditor />} />
        <Route path="/contacts" element={<Contacts />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
