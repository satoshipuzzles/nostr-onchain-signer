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
import { type Account, getAccountsFromVault, loadActiveAccountIndex, saveActiveAccountIndex, loadAccountMeta, updateAccountMeta, addAccountToVault } from '@/lib/accounts';
import { decryptVault, loadVault } from '@/lib/crypto/vault';
import { pubkeyToNpub, privkeyToNsec } from '@/lib/nostr/keys';

type Page = 'loading' | 'setup' | 'unlock' | 'dashboard' | 'multisig' | 'multisig-vault' | 'request-sig' | 'send' | 'signing' | 'discover' | 'profile-view' | 'relays' | 'edit-profile' | 'wallet';

export function App() {
  const [page, setPage] = useState<Page>('loading');
  const [publicKey, setPublicKey] = useState('');
  const [myProfile, setMyProfile] = useState<ProfileMetadata | null>(null);
  const [following, setFollowing] = useState<Set<string>>(new Set());
  const [viewingUser, setViewingUser] = useState<DiscoveredUser | null>(null);
  const [selectedMultisigWallet, setSelectedMultisigWallet] = useState<ArchivedMultisig | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [activeAccountIndex, setActiveAccountIndex] = useState(0);
  const [vaultPassword, setVaultPassword] = useState('');

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
        loadAccounts();
      }
    } catch {
      setPage('setup');
    }
  }

  async function loadAccounts() {
    try {
      const vault = await loadVault();
      if (!vault || !vaultPassword) {
        // Load from stored metadata
        const stored = await chrome.storage.local.get('cached_accounts');
        if (stored.cached_accounts) {
          setAccounts(stored.cached_accounts);
          const idx = await loadActiveAccountIndex();
          setActiveAccountIndex(idx);
        }
        return;
      }
      const vaultData = await decryptVault(vault, vaultPassword);
      const accts = getAccountsFromVault(vaultData);

      // Enrich with saved metadata
      for (const acct of accts) {
        const meta = await loadAccountMeta(acct.publicKeyHex);
        if (meta.picture) acct.picture = meta.picture;
        if (meta.displayName) acct.displayName = meta.displayName;
      }

      setAccounts(accts);
      await chrome.storage.local.set({ cached_accounts: accts });
      const idx = await loadActiveAccountIndex();
      setActiveAccountIndex(Math.min(idx, accts.length - 1));
    } catch {}
  }

  async function loadProfileAndFollows(pubkey: string) {
    if (!pubkey) return;

    // Load from local storage immediately (instant)
    const stored = await chrome.storage.local.get([`profile_${pubkey}`, `following_${pubkey}`]);
    if (stored[`profile_${pubkey}`]) {
      setMyProfile(stored[`profile_${pubkey}`]);
    }
    if (stored[`following_${pubkey}`]) {
      setFollowing(new Set(stored[`following_${pubkey}`]));
    }

    // Then fetch fresh from relays (background)
    const profile = await fetchMyProfile(pubkey);
    if (profile) {
      setMyProfile(profile);
      await chrome.storage.local.set({ [`profile_${pubkey}`]: profile });
      await updateAccountMeta(pubkey, { picture: profile.picture, displayName: profile.displayName || profile.name });
    }

    const contacts = await fetchFollowingList(pubkey);
    if (contacts.length > 0) {
      setFollowing(new Set(contacts.map((c) => c.pubkey)));
      await chrome.storage.local.set({ [`following_${pubkey}`]: contacts.map((c) => c.pubkey) });
    }
  }

  function onUnlocked(pubkey: string, password: string) {
    setPublicKey(pubkey);
    setVaultPassword(password);
    setPage('dashboard');
    loadProfileAndFollows(pubkey);
    // Load accounts with password available
    setTimeout(async () => {
      try {
        const vault = await loadVault();
        if (vault) {
          const vaultData = await decryptVault(vault, password);
          const accts = getAccountsFromVault(vaultData);
          for (const acct of accts) {
            const meta = await loadAccountMeta(acct.publicKeyHex);
            if (meta.picture) acct.picture = meta.picture;
            if (meta.displayName) acct.displayName = meta.displayName;
          }
          setAccounts(accts);
          await chrome.storage.local.set({ cached_accounts: accts });
          const idx = await loadActiveAccountIndex();
          setActiveAccountIndex(Math.min(idx, accts.length - 1));
        }
      } catch {}
    }, 100);
  }

  function onCreated(pubkey: string, password: string) {
    setPublicKey(pubkey);
    setVaultPassword(password);
    setPage('dashboard');
    setAccounts([{
      publicKeyHex: pubkey,
      npub: pubkeyToNpub(pubkey),
      label: 'Primary Key',
      createdAt: Date.now(),
    }]);
  }

  async function handleSwitchAccount(index: number) {
    if (index >= accounts.length) return;
    setActiveAccountIndex(index);
    await saveActiveAccountIndex(index);
    const acct = accounts[index];
    setPublicKey(acct.publicKeyHex);
    setMyProfile(null);
    setFollowing(new Set());

    // Tell background to switch active key
    await chrome.runtime.sendMessage({
      type: 'vault:switchAccount',
      payload: { index },
      id: createMessageId(),
    });

    loadProfileAndFollows(acct.publicKeyHex);
  }

  async function handleAddAccount() {
    if (!vaultPassword) return;
    try {
      const { accounts: newAccounts, newIndex } = await addAccountToVault(vaultPassword);
      setAccounts(newAccounts);
      await chrome.storage.local.set({ cached_accounts: newAccounts });
      handleSwitchAccount(newIndex);
    } catch (err) {
      console.error('Failed to add account:', err);
    }
  }

  async function handleBackupKeys() {
    if (!vaultPassword) {
      alert('Please lock and unlock again to enable backup');
      return;
    }
    try {
      const vault = await loadVault();
      if (!vault) return;
      const vaultData = await decryptVault(vault, vaultPassword);

      let backupContent = '# Nostr Onchain Signer - Key Backup\n';
      backupContent += `# Generated: ${new Date().toISOString()}\n`;
      backupContent += `# KEEP THIS FILE SAFE - Anyone with these keys can control your accounts\n\n`;

      for (let i = 0; i < vaultData.length; i++) {
        const data = vaultData[i];
        const npub = pubkeyToNpub(data.publicKeyHex);
        const nsec = privkeyToNsec(data.privateKeyHex);
        backupContent += `--- Account ${i + 1}: ${data.label || 'Unnamed'} ---\n`;
        backupContent += `npub: ${npub}\n`;
        backupContent += `nsec: ${nsec}\n`;
        backupContent += `hex pubkey: ${data.publicKeyHex}\n\n`;
      }

      // Download as file
      const blob = new Blob([backupContent], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `nostr-onchain-backup-${Date.now()}.txt`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Backup failed:', err);
    }
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
    return <MultiSig publicKey={publicKey} followingPubkeys={following} onBack={() => setPage('dashboard')} onCreated={() => setPage('multisig-vault')} />;
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
      accounts={accounts}
      activeAccountIndex={activeAccountIndex}
      onNavigate={setPage}
      onSwitchAccount={handleSwitchAccount}
      onAddAccount={handleAddAccount}
      onBackupKeys={handleBackupKeys}
    />
  );
}
