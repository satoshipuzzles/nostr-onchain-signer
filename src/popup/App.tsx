import { useState, useEffect, lazy, Suspense } from 'react';
import { Routes, Route, Navigate, Outlet, useSearchParams } from 'react-router-dom';
import { Landing } from './pages/Landing';
import { Unlock } from './pages/Unlock';
import { Setup } from './pages/Setup';
import { Layout } from './Layout';
import { Home } from './pages/Home';
import { FeedPage } from './pages/FeedPage';
import { ApproveSign } from './pages/ApproveSign';
import { AuthProvider, useAuth } from './context/AuthContext';

// Lazy-load everything off the critical path so the initial bundle only
// carries the auth gate, layout, home, and feed
const Wallets = lazy(() => import('./pages/Wallets').then((m) => ({ default: m.Wallets })));
const Leaderboard = lazy(() => import('./pages/Leaderboard').then((m) => ({ default: m.Leaderboard })));
const Messages = lazy(() => import('./pages/Messages').then((m) => ({ default: m.Messages })));
const SigningInboxWrapper = lazy(() => import('./pages/SigningInboxWrapper').then((m) => ({ default: m.SigningInboxWrapper })));
const DiscoverWrapper = lazy(() => import('./pages/DiscoverWrapper').then((m) => ({ default: m.DiscoverWrapper })));
const ProfileViewWrapper = lazy(() => import('./pages/ProfileViewWrapper').then((m) => ({ default: m.ProfileViewWrapper })));
const SendTxWrapper = lazy(() => import('./pages/SendTxWrapper').then((m) => ({ default: m.SendTxWrapper })));
const MultiSigWrapper = lazy(() => import('./pages/MultiSigWrapper').then((m) => ({ default: m.MultiSigWrapper })));
const MultisigVaultWrapper = lazy(() => import('./pages/MultisigVaultWrapper').then((m) => ({ default: m.MultisigVaultWrapper })));
const RequestSignatureWrapper = lazy(() => import('./pages/RequestSignatureWrapper').then((m) => ({ default: m.RequestSignatureWrapper })));
const WalletViewWrapper = lazy(() => import('./pages/WalletViewWrapper').then((m) => ({ default: m.WalletViewWrapper })));
const RelaySettingsWrapper = lazy(() => import('./pages/RelaySettingsWrapper').then((m) => ({ default: m.RelaySettingsWrapper })));
const EditProfileWrapper = lazy(() => import('./pages/EditProfileWrapper').then((m) => ({ default: m.EditProfileWrapper })));
const Settings = lazy(() => import('./pages/Settings').then((m) => ({ default: m.Settings })));
const ConnectedApps = lazy(() => import('./pages/ConnectedApps').then((m) => ({ default: m.ConnectedApps })));
const SignedEventsLog = lazy(() => import('./pages/SignedEventsLog').then((m) => ({ default: m.SignedEventsLog })));
const SignedEventDetail = lazy(() => import('./pages/SignedEventDetail').then((m) => ({ default: m.SignedEventDetail })));
const InvoicePage = lazy(() => import('./pages/InvoicePage').then((m) => ({ default: m.InvoicePage })));
const SignPage = lazy(() => import('./pages/SignPage').then((m) => ({ default: m.SignPage })));
const SocialUnlocks = lazy(() => import('./pages/SocialUnlocks').then((m) => ({ default: m.SocialUnlocks })));
const SocialUnlockPage = lazy(() => import('./pages/SocialUnlockPage').then((m) => ({ default: m.SocialUnlockPage })));
const LightOps = lazy(() => import('./pages/LightOps').then((m) => ({ default: m.LightOps })));
const OnchainExplorer = lazy(() => import('./pages/OnchainExplorer').then((m) => ({ default: m.OnchainExplorer })));
const MoreMenu = lazy(() => import('./pages/MoreMenu'));
const OtherStuff = lazy(() => import('./pages/OtherStuff'));

function PageFallback() {
  return (
    <div className="h-full min-h-[40vh] flex items-center justify-center">
      <div className="animate-pulse text-gray-500 text-sm">Loading…</div>
    </div>
  );
}
import { ProfilePopupProvider } from './context/ProfilePopupContext';
import { EmbedPlayerProvider } from './context/EmbedPlayerContext';
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
        <EmbedPlayerProvider>
          <SigningOverlay />
          <Suspense fallback={<PageFallback />}>
            <Outlet />
          </Suspense>
        </EmbedPlayerProvider>
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

  // The PWA session can vanish while the UI still shows the app (mobile PWA
  // process kill, storage cleared). When signing detects this, route the user
  // to the unlock screen instead of letting every action fail.
  useEffect(() => {
    const onSessionLost = () => {
      setStatus((prev) => (prev === 'authenticated' ? 'unlock' : prev));
    };
    window.addEventListener('nostr-onchain:session-lost', onSessionLost);
    return () => window.removeEventListener('nostr-onchain:session-lost', onSessionLost);
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
            <Suspense fallback={<PageFallback />}><SignPage /></Suspense>
          </ProfilePopupProvider>
        }
      />
      <Route
        path="/unlock/:eventId"
        element={
          <ProfilePopupProvider>
            <Suspense fallback={<PageFallback />}><SocialUnlockPage /></Suspense>
          </ProfilePopupProvider>
        }
      />
      <Route
        path="/invoice/:eventId"
        element={
          <ProfilePopupProvider>
            <Suspense fallback={<PageFallback />}><InvoicePage /></Suspense>
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
          <Route path="other" element={<OtherStuff />} />
          <Route path="more" element={<MoreMenu />} />
        </Route>
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
