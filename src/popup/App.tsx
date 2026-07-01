import { useState, useEffect, useCallback } from 'react';
import { Unlock } from './pages/Unlock';
import { Setup } from './pages/Setup';
import { Dashboard } from './pages/Dashboard';
import { MultiSig } from './pages/MultiSig';
import { MultisigVault } from './pages/MultisigVault';
import { RequestSignature } from './pages/RequestSignature';
import { SendTx } from './pages/SendTx';
import { SigningRounds } from './pages/SigningRounds';
import { Discover } from './pages/Discover';
import { ProfileView } from './pages/ProfileView';
import { RelaySettings } from './pages/RelaySettings';
import { EditProfile } from './pages/EditProfile';
import { WalletView } from './pages/WalletView';
import type { ExtensionMessage, VaultStatusResponse } from '@/shared/messages';
import { createMessageId } from '@/shared/messages';
import { fetchMyProfile, createFollowListEvent, publishEvent, type DiscoveredUser } from '@/lib/nostr/discovery';
import { fetchFollowingList, type ProfileMetadata } from '@/lib/nostr/social';
import { signEvent } from '@/lib/nostr/events';
import { type ArchivedMultisig } from '@/lib/bitcoin/wallet-store';

type Page = 'loading' | 'setup' | 'unlock' | 'dashboard' | 'multisig' | 'multisig-vault' | 'request-sig' | 'send' | 'signing' | 'discover' | 'profile-view' | 'relays' | 'edit-profile' | 'wallet';

export function App() {
  const [page, setPage] = useState<Page>('loading');
  const [publicKey, setPublicKey] = useState('');
  const [myProfile, setMyProfile] = useState<ProfileMetadata | null>(null);
  const [following, setFollowing] = useState<Set<string>>(new Set());
  const [viewingUser, setViewingUser] = useState<DiscoveredUser | null>(null);
  const [selectedMultisigWallet, setSelectedMultisigWallet] = useState<ArchivedMultisig | null>(null);

  useEffect(() => {
    checkVaultStatus();
  }, []);

  async function checkVaultStatus() {
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'vault:status',
        id: createMessageId(),
      } as ExtensionMessage);

      const status = response.result as VaultStatusResponse;
      if (!status.exists) {
        setPage('setup');
      } else if (!status.unlocked) {
        setPage('unlock');
      } else {
        setPublicKey(status.publicKey ?? '');
        setPage('dashboard');
        loadProfileAndFollows(status.publicKey ?? '');
      }
    } catch {
      setPage('setup');
    }
  }

  async function loadProfileAndFollows(pubkey: string) {
    if (!pubkey) return;
    // Try local storage first for instant load
    const stored = await chrome.storage.local.get(`profile_${pubkey}`);
    if (stored[`profile_${pubkey}`]) {
      setMyProfile(stored[`profile_${pubkey}`]);
    }
    // Then fetch fresh from relays
    const profile = await fetchMyProfile(pubkey);
    if (profile) {
      setMyProfile(profile);
      await chrome.storage.local.set({ [`profile_${pubkey}`]: profile });
    }
    // Load following list
    const contacts = await fetchFollowingList(pubkey);
    if (contacts.length > 0) {
      setFollowing(new Set(contacts.map((c) => c.pubkey)));
      await chrome.storage.local.set({ [`following_${pubkey}`]: contacts.map((c) => c.pubkey) });
    } else {
      // Fall back to locally saved list
      const savedFollowing = await chrome.storage.local.get(`following_${pubkey}`);
      if (savedFollowing[`following_${pubkey}`]) {
        setFollowing(new Set(savedFollowing[`following_${pubkey}`]));
      }
    }
  }

  function onUnlocked(pubkey: string) {
    setPublicKey(pubkey);
    setPage('dashboard');
    loadProfileAndFollows(pubkey);
  }

  function onCreated(pubkey: string) {
    setPublicKey(pubkey);
    setPage('dashboard');
  }

  const handleFollow = useCallback(async (pubkey: string) => {
    const newFollowing = new Set(following);
    newFollowing.add(pubkey);
    setFollowing(newFollowing);
    await publishFollowList(Array.from(newFollowing));
  }, [following, publicKey]);

  const handleUnfollow = useCallback(async (pubkey: string) => {
    const newFollowing = new Set(following);
    newFollowing.delete(pubkey);
    setFollowing(newFollowing);
    await publishFollowList(Array.from(newFollowing));
  }, [following, publicKey]);

  async function publishFollowList(pubkeys: string[]) {
    try {
      // Save locally immediately
      await chrome.storage.local.set({ [`following_${publicKey}`]: pubkeys });

      const unsigned = createFollowListEvent(pubkeys, publicKey);
      const response = await chrome.runtime.sendMessage({
        type: 'nip07:signEvent',
        payload: { event: unsigned },
        id: createMessageId(),
      });
      if (!response.error && response.result) {
        await publishEvent(response.result);
      }
    } catch (err) {
      console.error('Failed to publish follow list:', err);
    }
  }

  // ─── ROUTING ────────────────────────────────────────────────

  if (page === 'loading') {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="animate-pulse text-bitcoin text-lg">Loading...</div>
      </div>
    );
  }

  if (page === 'setup') return <Setup onCreated={onCreated} />;
  if (page === 'unlock') return <Unlock onUnlocked={onUnlocked} />;

  if (page === 'multisig') {
    return <MultiSig publicKey={publicKey} onBack={() => setPage('dashboard')} />;
  }

  if (page === 'multisig-vault') {
    return (
      <MultisigVault
        publicKey={publicKey}
        onCreateNew={() => setPage('multisig')}
        onRequestSignature={(w) => { setSelectedMultisigWallet(w); setPage('request-sig'); }}
        onBack={() => setPage('dashboard')}
      />
    );
  }

  if (page === 'request-sig' && selectedMultisigWallet) {
    return (
      <RequestSignature
        wallet={selectedMultisigWallet}
        publicKey={publicKey}
        onDone={() => setPage('multisig-vault')}
        onBack={() => setPage('multisig-vault')}
      />
    );
  }

  if (page === 'send') {
    return <SendTx publicKey={publicKey} onBack={() => setPage('dashboard')} />;
  }

  if (page === 'signing') {
    return <SigningRounds publicKey={publicKey} onBack={() => setPage('dashboard')} />;
  }

  if (page === 'discover') {
    return (
      <Discover
        publicKey={publicKey}
        following={following}
        onFollow={handleFollow}
        onUnfollow={handleUnfollow}
        onViewProfile={(user) => { setViewingUser(user); setPage('profile-view'); }}
        onBack={() => setPage('dashboard')}
      />
    );
  }

  if (page === 'profile-view' && viewingUser) {
    return (
      <ProfileView
        user={viewingUser}
        isFollowing={following.has(viewingUser.pubkey)}
        onFollow={() => handleFollow(viewingUser.pubkey)}
        onUnfollow={() => handleUnfollow(viewingUser.pubkey)}
        onBack={() => setPage('discover')}
      />
    );
  }

  if (page === 'relays') {
    return <RelaySettings onBack={() => setPage('dashboard')} />;
  }

  if (page === 'edit-profile') {
    return (
      <EditProfile
        publicKey={publicKey}
        profile={myProfile}
        onSaved={(p) => setMyProfile(p)}
        onBack={() => setPage('dashboard')}
      />
    );
  }

  if (page === 'wallet') {
    return <WalletView publicKey={publicKey} onBack={() => setPage('dashboard')} />;
  }

  return (
    <Dashboard
      publicKey={publicKey}
      profile={myProfile}
      followingCount={following.size}
      onNavigate={setPage}
    />
  );
}
