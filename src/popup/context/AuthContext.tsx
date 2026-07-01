import { createContext, useContext, useState, useEffect, useCallback, useRef, type ReactNode } from 'react';
import { fetchMyProfile, createFollowListEvent, publishEvent, type DiscoveredUser } from '@/lib/nostr/discovery';
import { fetchFollowingList, type ProfileMetadata } from '@/lib/nostr/social';
import { type ArchivedMultisig } from '@/lib/bitcoin/wallet-store';
import {
  type Account, getAccountsFromVault, loadActiveAccountIndex,
  saveActiveAccountIndex, loadAccountMeta, updateAccountMeta, addAccountToVault,
} from '@/lib/accounts';
import { decryptVault, loadVault } from '@/lib/crypto/vault';
import { pubkeyToNpub, privkeyToNsec } from '@/lib/nostr/keys';
import { createMessageId } from '@/shared/messages';

interface AuthState {
  publicKey: string;
  myProfile: ProfileMetadata | null;
  following: Set<string>;
  accounts: Account[];
  activeAccountIndex: number;
  vaultPassword: string;
  selectedMultisigWallet: ArchivedMultisig | null;
  viewingUser: DiscoveredUser | null;
}

interface AuthActions {
  handleFollow: (pubkey: string) => Promise<void>;
  handleUnfollow: (pubkey: string) => Promise<void>;
  handleSwitchAccount: (index: number) => Promise<void>;
  handleAddAccount: () => Promise<void>;
  handleBackupKeys: () => Promise<void>;
  setSelectedMultisigWallet: (w: ArchivedMultisig | null) => void;
  setViewingUser: (u: DiscoveredUser | null) => void;
  setMyProfile: (p: ProfileMetadata | null) => void;
}

type AuthContextType = AuthState & AuthActions;

const AuthContext = createContext<AuthContextType | null>(null);

export function useAuth(): AuthContextType {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}

interface AuthProviderProps {
  children: ReactNode;
  initialPublicKey: string;
  initialPassword: string;
}

export function AuthProvider({ children, initialPublicKey, initialPassword }: AuthProviderProps) {
  const [publicKey, setPublicKey] = useState(initialPublicKey);
  const [myProfile, setMyProfile] = useState<ProfileMetadata | null>(null);
  const [following, setFollowing] = useState<Set<string>>(new Set());
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [activeAccountIndex, setActiveAccountIndex] = useState(0);
  const [vaultPassword, setVaultPassword] = useState(initialPassword);
  const [selectedMultisigWallet, setSelectedMultisigWallet] = useState<ArchivedMultisig | null>(null);
  const [viewingUser, setViewingUser] = useState<DiscoveredUser | null>(null);
  const followingRef = useRef(following);
  followingRef.current = following;

  useEffect(() => {
    loadProfileAndFollows(initialPublicKey);
    loadAccountsOnMount(initialPassword);
  }, []);

  async function loadAccountsOnMount(password: string) {
    try {
      if (password) {
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
          return;
        }
      }

      const stored = await chrome.storage.local.get('cached_accounts');
      if (stored.cached_accounts) {
        setAccounts(stored.cached_accounts);
        const idx = await loadActiveAccountIndex();
        setActiveAccountIndex(idx);
      } else {
        setAccounts([{
          publicKeyHex: initialPublicKey,
          npub: pubkeyToNpub(initialPublicKey),
          label: 'Primary Key',
          createdAt: Date.now(),
        }]);
      }
    } catch {
      setAccounts([{
        publicKeyHex: initialPublicKey,
        npub: pubkeyToNpub(initialPublicKey),
        label: 'Primary Key',
        createdAt: Date.now(),
      }]);
    }
  }

  async function loadProfileAndFollows(pubkey: string) {
    if (!pubkey) return;

    const stored = await chrome.storage.local.get([`profile_${pubkey}`, `following_${pubkey}`]);
    if (stored[`profile_${pubkey}`]) {
      setMyProfile(stored[`profile_${pubkey}`]);
    }
    if (stored[`following_${pubkey}`]) {
      setFollowing(new Set(stored[`following_${pubkey}`]));
    }

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

  const handleFollow = useCallback(async (pubkey: string) => {
    const newFollowing = new Set(followingRef.current);
    newFollowing.add(pubkey);
    setFollowing(newFollowing);
    await publishFollowList(Array.from(newFollowing));
  }, [publicKey]);

  const handleUnfollow = useCallback(async (pubkey: string) => {
    const newFollowing = new Set(followingRef.current);
    newFollowing.delete(pubkey);
    setFollowing(newFollowing);
    await publishFollowList(Array.from(newFollowing));
  }, [publicKey]);

  async function handleSwitchAccount(index: number) {
    if (index >= accounts.length) return;
    setActiveAccountIndex(index);
    await saveActiveAccountIndex(index);
    const acct = accounts[index];
    setPublicKey(acct.publicKeyHex);
    setMyProfile(null);
    setFollowing(new Set());

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

  return (
    <AuthContext.Provider value={{
      publicKey,
      myProfile,
      following,
      accounts,
      activeAccountIndex,
      vaultPassword,
      selectedMultisigWallet,
      viewingUser,
      handleFollow,
      handleUnfollow,
      handleSwitchAccount,
      handleAddAccount,
      handleBackupKeys,
      setSelectedMultisigWallet,
      setViewingUser,
      setMyProfile,
    }}>
      {children}
    </AuthContext.Provider>
  );
}
