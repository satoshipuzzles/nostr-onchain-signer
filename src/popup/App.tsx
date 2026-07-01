import { useState, useEffect } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { Landing } from './pages/Landing';
import { Unlock } from './pages/Unlock';
import { Setup } from './pages/Setup';
import { Layout } from './Layout';
import { Home } from './pages/Home';
import { Wallets } from './pages/Wallets';
import { Leaderboard } from './pages/Leaderboard';
import { FeedPage } from './pages/FeedPage';
import { Messages } from './pages/Messages';
import { SigningInboxWrapper } from './pages/SigningInboxWrapper';
import { DiscoverWrapper } from './pages/DiscoverWrapper';
import { ProfileViewWrapper } from './pages/ProfileViewWrapper';
import { SendTxWrapper } from './pages/SendTxWrapper';
import { MultiSigWrapper } from './pages/MultiSigWrapper';
import { MultisigVaultWrapper } from './pages/MultisigVaultWrapper';
import { RequestSignatureWrapper } from './pages/RequestSignatureWrapper';
import { WalletViewWrapper } from './pages/WalletViewWrapper';
import { RelaySettingsWrapper } from './pages/RelaySettingsWrapper';
import { EditProfileWrapper } from './pages/EditProfileWrapper';
import { Settings } from './pages/Settings';
import { AuthProvider } from './context/AuthContext';
import type { ExtensionMessage, VaultStatusResponse } from '@/shared/messages';
import { createMessageId } from '@/shared/messages';

type AppStatus = 'loading' | 'landing' | 'setup' | 'unlock' | 'authenticated';

export function App() {
  const [status, setStatus] = useState<AppStatus>('loading');
  const [credentials, setCredentials] = useState<{ publicKey: string; password: string }>({ publicKey: '', password: '' });

  useEffect(() => {
    checkVaultStatus();
  }, []);

  async function checkVaultStatus() {
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'vault:status',
        id: createMessageId(),
      } as ExtensionMessage);

      if (!response || response.error) {
        setStatus('landing');
        return;
      }

      const vaultStatus = response.result as VaultStatusResponse;
      if (!vaultStatus.exists) {
        setStatus('landing');
      } else if (!vaultStatus.unlocked) {
        setStatus('unlock');
      } else if (vaultStatus.publicKey) {
        setCredentials({ publicKey: vaultStatus.publicKey, password: '' });
        setStatus('authenticated');
      } else {
        setStatus('unlock');
      }
    } catch {
      setStatus('landing');
    }
  }

  function handleUnlocked(publicKey: string, password: string) {
    setCredentials({ publicKey, password });
    setStatus('authenticated');
  }

  function handleCreated(publicKey: string, password: string) {
    setCredentials({ publicKey, password });
    setStatus('authenticated');
  }

  if (status === 'loading') {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="animate-pulse text-bitcoin text-lg">Loading...</div>
      </div>
    );
  }

  if (status === 'landing') {
    return <Landing onGetStarted={() => setStatus('setup')} />;
  }

  if (status === 'setup') {
    return <Setup onCreated={handleCreated} />;
  }

  if (status === 'unlock') {
    return <Unlock onUnlocked={handleUnlocked} onReset={() => setStatus('setup')} />;
  }

  return (
    <AuthProvider initialPublicKey={credentials.publicKey} initialPassword={credentials.password}>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Home />} />
          <Route path="feed" element={<FeedPage />} />
          <Route path="messages" element={<Messages />} />
          <Route path="leaderboard" element={<Leaderboard />} />
          <Route path="wallets" element={<Wallets />} />
          <Route path="wallets/create" element={<MultiSigWrapper />} />
          <Route path="wallets/personal" element={<WalletViewWrapper />} />
          <Route path="wallets/sign" element={<RequestSignatureWrapper />} />
          <Route path="wallets/:id" element={<MultisigVaultWrapper />} />
          <Route path="signing" element={<SigningInboxWrapper />} />
          <Route path="discover" element={<DiscoverWrapper />} />
          <Route path="discover/:pubkey" element={<ProfileViewWrapper />} />
          <Route path="send" element={<SendTxWrapper />} />
          <Route path="settings" element={<Settings />} />
          <Route path="settings/relays" element={<RelaySettingsWrapper />} />
          <Route path="settings/profile" element={<EditProfileWrapper />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AuthProvider>
  );
}
