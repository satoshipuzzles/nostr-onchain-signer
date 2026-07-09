import { useState, useEffect } from 'react';
import { Routes, Route, Navigate, Outlet, useSearchParams } from 'react-router-dom';
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
import { ConnectedApps } from './pages/ConnectedApps';
import { SignedEventsLog } from './pages/SignedEventsLog';
import { SignedEventDetail } from './pages/SignedEventDetail';
import { InvoicePage } from './pages/InvoicePage';
import { SignPage } from './pages/SignPage';
import { ApproveSign } from './pages/ApproveSign';
import { SocialUnlocks } from './pages/SocialUnlocks';
import { SocialUnlockPage } from './pages/SocialUnlockPage';
import { LightOps } from './pages/LightOps';
import { OnchainExplorer } from './pages/OnchainExplorer';
import MoreMenu from './pages/MoreMenu';
import { AuthProvider, useAuth } from './context/AuthContext';
import { ProfilePopupProvider } from './context/ProfilePopupContext';
import { SigningConfirmation } from './components/SigningConfirmation';
import type { ExtensionMessage, VaultStatusResponse } from '@/shared/messages';
import { createMessageId } from '@/shared/messages';

function SigningOverlay() {
  const { signingRequest } = useAuth();
  if (!signingRequest) return null;
  return <SigningConfirmation request={signingRequest} />;
}

type AppStatus = 'loading' | 'landing' | 'setup' | 'unlock' | 'authenticated';

interface AuthGateProps {
  status: AppStatus;
  credentials: { publicKey: string; password: string };
  onGetStarted: () => void;
  onUnlocked: (publicKey: string, password: string) => void;
  onCreated: (publicKey: string, password: string) => void;
  onReset: () => void;
}

/** Blocks child routes until vault is ready; renders Outlet when authenticated. */
function AuthGate({ status, credentials, onGetStarted, onUnlocked, onCreated, onReset }: AuthGateProps) {
  if (status === 'loading') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-surface-900">
        <div className="animate-pulse text-bitcoin text-lg">Loading...</div>
      </div>
    );
  }

  if (status === 'landing') {
    return <Landing onGetStarted={onGetStarted} />;
  }

  if (status === 'setup') {
    return <Setup onCreated={onCreated} />;
  }

  if (status === 'unlock') {
    return <Unlock onUnlocked={onUnlocked} onReset={onReset} />;
  }

  return (
    <AuthProvider initialPublicKey={credentials.publicKey} initialPassword={credentials.password}>
      <ProfilePopupProvider>
        <SigningOverlay />
        <Outlet />
      </ProfilePopupProvider>
    </AuthProvider>
  );
}

export function App() {
  const [searchParams] = useSearchParams();
  const approvalId = searchParams.get('approval');
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

  if (approvalId) {
    return <ApproveSign />;
  }

  const gateProps = {
    status,
    credentials,
    onGetStarted: () => setStatus('setup'),
    onUnlocked: handleUnlocked,
    onCreated: handleCreated,
    onReset: () => setStatus('setup'),
  };

  return (
    <Routes>
      {/* Public pages — no vault required */}
      <Route
        path="/sign/:roundId"
        element={
          <ProfilePopupProvider>
            <SignPage />
          </ProfilePopupProvider>
        }
      />
      <Route
        path="/unlock/:eventId"
        element={
          <ProfilePopupProvider>
            <SocialUnlockPage />
          </ProfilePopupProvider>
        }
      />
      <Route
        path="/invoice/:eventId"
        element={
          <ProfilePopupProvider>
            <InvoicePage />
          </ProfilePopupProvider>
        }
      />

      {/* App routes — gated by vault status */}
      <Route element={<AuthGate {...gateProps} />}>
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
          <Route path="lightops" element={<LightOps />} />
          <Route path="explorer" element={<OnchainExplorer />} />
          <Route path="settings" element={<Settings />} />
          <Route path="settings/relays" element={<RelaySettingsWrapper />} />
          <Route path="settings/profile" element={<EditProfileWrapper />} />
          <Route path="settings/apps" element={<ConnectedApps />} />
          <Route path="settings/events" element={<SignedEventsLog />} />
          <Route path="settings/events/:eventId" element={<SignedEventDetail />} />
          <Route path="unlocks" element={<SocialUnlocks />} />
          <Route path="more" element={<MoreMenu />} />
        </Route>
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
