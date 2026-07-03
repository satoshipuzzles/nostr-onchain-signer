import { createContext, useContext, useState, useEffect, useCallback, useRef, type ReactNode } from 'react';
import { fetchMyProfile, createFollowListEvent, publishEvent, type DiscoveredUser } from '@/lib/nostr/discovery';
import { fetchFollowingList, type ProfileMetadata } from '@/lib/nostr/social';
import { type ArchivedMultisig, migrateUnownedWallets } from '@/lib/bitcoin/wallet-store';
import {
  type Account, getAccountsFromVault, loadActiveAccountIndex,
  saveActiveAccountIndex, loadAccountMeta, updateAccountMeta, addAccountToVault,
} from '@/lib/accounts';
import { decryptVault, loadVault } from '@/lib/crypto/vault';
import { pubkeyToNpub, privkeyToNsec } from '@/lib/nostr/keys';
import { createMessageId } from '@/shared/messages';
import { type UnsignedEvent, type SignedEvent } from '@/lib/nostr/events';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';

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

export interface SigningRequest {
  event: { kind: number; content: string; pubkey: string; tags: string[][] };
  onConfirm: () => void;
  onCancel: () => void;
}

interface AuthActions {
  handleFollow: (pubkey: string) => Promise<void>;
  handleUnfollow: (pubkey: string) => Promise<void>;
  handleSwitchAccount: (index: number) => Promise<void>;
  handleAddAccount: () => Promise<void>;
  handleBackupKeys: () => Promise<void>;
  confirmAndSign: (event: Omit<UnsignedEvent, 'pubkey'>) => Promise<SignedEvent>;
  signingRequest: SigningRequest | null;
  setSelectedMultisigWallet: (w: ArchivedMultisig | null) => void;
  setViewingUser: (u: DiscoveredUser | null) => void;
  setMyProfile: (p: ProfileMetadata | null) => void;
  setVaultPassword: (pw: string) => void;
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
  const [myProfile, setMyProfileRaw] = useState<ProfileMetadata | null>(null);
  const [following, setFollowingRaw] = useState<Set<string>>(new Set());
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [activeAccountIndex, setActiveAccountIndex] = useState(0);
  const [vaultPassword, setVaultPassword] = useState(initialPassword);

  function setMyProfile(value: unknown) {
    if (!value || typeof value !== 'object') {
      setMyProfileRaw(value as ProfileMetadata | null);
      return;
    }
    if (Object.keys(value).length === 0) {
      setMyProfileRaw(null);
      return;
    }
    setMyProfileRaw(value as ProfileMetadata);
  }

  function setFollowing(value: unknown) {
    if (value instanceof Set) {
      setFollowingRaw(value);
    } else if (Array.isArray(value)) {
      setFollowingRaw(new Set(value));
    } else {
      setFollowingRaw(new Set());
    }
  }
  const [selectedMultisigWallet, setSelectedMultisigWallet] = useState<ArchivedMultisig | null>(null);
  const [viewingUser, setViewingUser] = useState<DiscoveredUser | null>(null);
  const [signingRequest, setSigningRequest] = useState<SigningRequest | null>(null);
  const followingRef = useRef(following);
  followingRef.current = following;

  useEffect(() => {
    loadProfileAndFollows(initialPublicKey);
    loadAccountsOnMount(initialPassword);
    migrateUnownedWallets(initialPublicKey).catch(() => {});
    preloadAppData();

    // Derive and store wallet sync key, then restore wallets from relays
    if (initialPassword && initialPublicKey) {
      const syncKey = bytesToHex(
        sha256(new TextEncoder().encode(`wallet-sync-${initialPassword}-${initialPublicKey}`)),
      );
      sessionStorage.setItem('nostr_onchain_wallet_sync_key', syncKey);
      restoreWalletsFromRelay(initialPublicKey, syncKey).catch(() => {});
    }
  }, []);

  async function preloadAppData() {
    import('@/lib/nostr/cache').then(({ fullDiscoverySync }) => {
      fullDiscoverySync('7d', { maxUsers: 2000 }).catch(() => {});
    });
  }

  async function restoreWalletsFromRelay(pubkey: string, syncKey: string) {
    try {
      const { fetchWalletConfigs } = await import('@/lib/nostr/wallet-sync');
      const configs = await fetchWalletConfigs(pubkey, syncKey);
      if (configs.length === 0) return;

      const { syncConfigToWallet, loadMultisigWallets, saveMultisigWallet } =
        await import('@/lib/bitcoin/wallet-store');
      const existing = await loadMultisigWallets();
      const existingIds = new Set(existing.map((w) => w.id));

      for (const config of configs) {
        if (!existingIds.has(config.id)) {
          const wallet = syncConfigToWallet(config, pubkey);
          await saveMultisigWallet(wallet);
        }
      }
    } catch (err) {
      console.warn('Failed to restore wallets from relay:', err);
    }
  }

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
      if (Array.isArray(stored.cached_accounts) && stored.cached_accounts.length > 0) {
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
      const rawFollowing = stored[`following_${pubkey}`];
      if (Array.isArray(rawFollowing)) {
        setFollowing(new Set(rawFollowing));
      }
    }

    const profile = await fetchMyProfile(pubkey);
    if (profile) {
      setMyProfile(profile);
      await chrome.storage.local.set({ [`profile_${pubkey}`]: profile });
      await updateAccountMeta(pubkey, { picture: profile.picture, displayName: profile.displayName || profile.name });
    }

    const contacts = await fetchFollowingList(pubkey);
    if (Array.isArray(contacts) && contacts.length > 0) {
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
    if (index < 0 || index >= accounts.length) return;
    const acct = accounts[index];

    const response = await chrome.runtime.sendMessage({
      type: 'vault:switchAccount',
      payload: { index },
      id: createMessageId(),
    });

    if (response.error) {
      console.error('Failed to switch account in vault:', response.error);
      return;
    }

    await saveActiveAccountIndex(index);
    setActiveAccountIndex(index);
    setPublicKey(acct.publicKeyHex);

    // Immediately load the new account's cached data instead of clearing to
    // null — this prevents a flash of empty state and ensures data keyed by
    // the old pubkey is never wiped.
    const cached = await chrome.storage.local.get([
      `profile_${acct.publicKeyHex}`,
      `following_${acct.publicKeyHex}`,
    ]);
    const cachedProfile = cached[`profile_${acct.publicKeyHex}`];
    const cachedFollowing = cached[`following_${acct.publicKeyHex}`];

    setMyProfile(cachedProfile ?? null);
    setFollowing(Array.isArray(cachedFollowing) ? new Set(cachedFollowing) : new Set());

    // Then refresh from relays in the background
    loadProfileAndFollows(acct.publicKeyHex);
  }

  async function handleAddAccount() {
    let pw = vaultPassword;
    if (!pw) {
      const entered = prompt('Enter your vault password to add an account');
      if (!entered) return;
      try {
        const vault = await loadVault();
        if (vault) await decryptVault(vault, entered);
        pw = entered;
        setVaultPassword(entered);
      } catch {
        alert('Incorrect password');
        return;
      }
    }
    try {
      const { accounts: newAccounts, newIndex } = await addAccountToVault(pw);
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

  async function confirmAndSign(event: Omit<UnsignedEvent, 'pubkey'>): Promise<SignedEvent> {
    return new Promise((resolve, reject) => {
      setSigningRequest({
        event: { ...event, pubkey: publicKey },
        onConfirm: () => {
          setSigningRequest(null);
          chrome.runtime.sendMessage({
            type: 'nip07:signEvent',
            payload: { event },
            id: createMessageId(),
          }).then((response: { result?: SignedEvent; error?: string }) => {
            if (response.error) {
              reject(new Error(response.error));
            } else {
              resolve(response.result!);
            }
          }).catch(reject);
        },
        onCancel: () => {
          setSigningRequest(null);
          reject(new Error('Signing cancelled by user'));
        },
      });
    });
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
      signingRequest,
      handleFollow,
      handleUnfollow,
      handleSwitchAccount,
      handleAddAccount,
      handleBackupKeys,
      confirmAndSign,
      setSelectedMultisigWallet,
      setViewingUser,
      setMyProfile,
      setVaultPassword,
    }}>
      {children}
    </AuthContext.Provider>
  );
}
