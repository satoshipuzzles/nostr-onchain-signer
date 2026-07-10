import { createContext, useContext, useState, useEffect, useCallback, useRef, type ReactNode } from 'react';
import { fetchMyProfile, createFollowListEvent, publishEvent, type DiscoveredUser } from '@/lib/nostr/discovery';
import { fetchFollowingList, type ProfileMetadata } from '@/lib/nostr/social';
import { type ArchivedMultisig, migrateUnownedWallets } from '@/lib/bitcoin/wallet-store';
import {
  type Account, getAccountsFromVault, loadActiveAccountIndex,
  saveActiveAccountIndex, loadAccountMeta, updateAccountMeta, addAccountToVault,
  addNip07AccountToVault, addNsecAccountToVault,
  upgradeAccountWithNsec,
} from '@/lib/accounts';
import { decryptVault, loadVault } from '@/lib/crypto/vault';
import { pubkeyToNpub, privkeyToNsec } from '@/lib/nostr/keys';
import { createMessageId } from '@/shared/messages';
import { type UnsignedEvent, type SignedEvent } from '@/lib/nostr/events';
import { signEventWithFallback } from '@/lib/nostr/sign-event';
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
  handleAddAccount: (mode?: 'generated' | 'nip07' | 'nsec') => Promise<void>;
  handleBackupKeys: () => Promise<void>;
  confirmAndSign: (event: Omit<UnsignedEvent, 'pubkey'>) => Promise<SignedEvent>;
  signingRequest: SigningRequest | null;
  setSelectedMultisigWallet: (w: ArchivedMultisig | null) => void;
  setViewingUser: (u: DiscoveredUser | null) => void;
  setMyProfile: (p: ProfileMetadata | null) => void;
  setVaultPassword: (pw: string) => void;
  canSignOnchain: boolean;
  handleUpgradeWithNsec: (nsec: string) => Promise<void>;
}

type AuthContextType = AuthState & AuthActions;

export const AuthContext = createContext<AuthContextType | null>(null);

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
  const activePubkeyRef = useRef(initialPublicKey);
  const profileLoadGenRef = useRef(0);

  function accountToProfile(acct: Account): ProfileMetadata {
    return {
      pubkey: acct.publicKeyHex,
      name: acct.displayName || acct.label,
      displayName: acct.displayName || acct.label,
      picture: acct.picture,
    };
  }

  function mergeAccountMeta(
    list: Account[],
    pubkey: string,
    meta: { picture?: string; displayName?: string }
  ): Account[] {
    return list.map((a) =>
      a.publicKeyHex === pubkey
        ? {
            ...a,
            picture: meta.picture ?? a.picture,
            displayName: meta.displayName ?? a.displayName,
          }
        : a
    );
  }

  function isActivePubkey(pubkey: string): boolean {
    return activePubkeyRef.current === pubkey;
  }

  useEffect(() => {
    loadAccountsOnMount(initialPassword);
    preloadAppData();
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
    let accts: Account[] = [];
    let vaultData: any[] | null = null;
    try {
      if (password) {
        const vault = await loadVault();
        if (vault) {
          vaultData = await decryptVault(vault, password);
          accts = getAccountsFromVault(vaultData);
          // Persist decrypted keys to sessionStorage for DM crypto access
          try {
            sessionStorage.setItem('nostr_onchain_session_keys', JSON.stringify(vaultData));
          } catch {}
        }
      }

      if (accts.length === 0) {
        const stored = await chrome.storage.local.get('cached_accounts');
        if (Array.isArray(stored.cached_accounts) && stored.cached_accounts.length > 0) {
          accts = stored.cached_accounts as Account[];
        }
      }

      if (accts.length === 0) {
        accts = [{
          publicKeyHex: initialPublicKey,
          npub: pubkeyToNpub(initialPublicKey),
          label: 'Primary Key',
          createdAt: Date.now(),
          canSignOnchain: true,
        }];
      }

      for (const acct of accts) {
        const meta = await loadAccountMeta(acct.publicKeyHex);
        if (meta.picture) acct.picture = meta.picture;
        if (meta.displayName) acct.displayName = meta.displayName;
      }

      const idx = await loadActiveAccountIndex();
      const safeIdx = Math.min(Math.max(0, idx), accts.length - 1);
      await activateAccount(safeIdx, accts, { password, forceUnlock: !!password });
    } catch {
      const fallback: Account[] = [{
        publicKeyHex: initialPublicKey,
        npub: pubkeyToNpub(initialPublicKey),
        label: 'Primary Key',
        createdAt: Date.now(),
        canSignOnchain: true,
      }];
      await activateAccount(0, fallback, { forceUnlock: false });
    }
  }

  async function applyCachedProfileForAccount(acct: Account) {
    const cached = await chrome.storage.local.get([
      `profile_${acct.publicKeyHex}`,
      `following_${acct.publicKeyHex}`,
    ]);
    const cachedProfile = cached[`profile_${acct.publicKeyHex}`] as ProfileMetadata | undefined;
    const cachedFollowing = cached[`following_${acct.publicKeyHex}`];

    if (!isActivePubkey(acct.publicKeyHex)) return;

    if (cachedProfile && typeof cachedProfile === 'object' && Object.keys(cachedProfile).length > 0) {
      setMyProfile(cachedProfile);
    } else if (acct.picture || acct.displayName) {
      setMyProfile(accountToProfile(acct));
    } else {
      setMyProfile(null);
    }

    setFollowing(Array.isArray(cachedFollowing) ? new Set(cachedFollowing) : new Set());
  }

  async function activateAccount(
    index: number,
    accountsList: Account[],
    options?: { password?: string; forceUnlock?: boolean }
  ): Promise<boolean> {
    if (index < 0 || index >= accountsList.length) return false;
    const acct = accountsList[index];
    const password = options?.password || vaultPassword;

    if (options?.forceUnlock !== false) {
      let switchResponse = await chrome.runtime.sendMessage({
        type: 'vault:switchAccount',
        payload: { index },
        id: createMessageId(),
      });

      if (switchResponse.error && password) {
        await chrome.runtime.sendMessage({
          type: 'vault:unlock',
          payload: { password },
          id: createMessageId(),
        });
        switchResponse = await chrome.runtime.sendMessage({
          type: 'vault:switchAccount',
          payload: { index },
          id: createMessageId(),
        });
      }

      if (switchResponse.error) {
        if (password) {
          throw new Error(`Could not switch vault account: ${switchResponse.error}`);
        }
        console.warn('Vault account switch:', switchResponse.error);
      }
    }

    activePubkeyRef.current = acct.publicKeyHex;
    await saveActiveAccountIndex(index);
    setActiveAccountIndex(index);
    setPublicKey(acct.publicKeyHex);
    setAccounts(accountsList);
    await chrome.storage.local.set({ cached_accounts: accountsList });
    // Keep sessionStorage in sync so DM crypto can find the active key
    try {
      sessionStorage.setItem('nostr_onchain_active_index', JSON.stringify(index));
    } catch {}

    await applyCachedProfileForAccount(acct);

    if (password) {
      const syncKey = bytesToHex(
        sha256(new TextEncoder().encode(`wallet-sync-${password}-${acct.publicKeyHex}`)),
      );
      sessionStorage.setItem('nostr_onchain_wallet_sync_key', syncKey);
      restoreWalletsFromRelay(acct.publicKeyHex, syncKey).catch(() => {});
    }

    migrateUnownedWallets(acct.publicKeyHex).catch(() => {});
    loadProfileAndFollows(acct.publicKeyHex);
    return true;
  }

  async function loadProfileAndFollows(pubkey: string) {
    if (!pubkey) return;
    const gen = ++profileLoadGenRef.current;

    const stored = await chrome.storage.local.get([`profile_${pubkey}`, `following_${pubkey}`]);
    if (!isActivePubkey(pubkey)) return;

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
    if (!isActivePubkey(pubkey) || gen !== profileLoadGenRef.current) return;

    if (profile) {
      setMyProfile(profile);
      await chrome.storage.local.set({ [`profile_${pubkey}`]: profile });
      const displayName = profile.displayName || profile.name;
      await updateAccountMeta(pubkey, { picture: profile.picture, displayName });
      setAccounts((prev) => {
        const updated = mergeAccountMeta(prev, pubkey, {
          picture: profile.picture,
          displayName,
        });
        chrome.storage.local.set({ cached_accounts: updated });
        return updated;
      });
    }

    const contacts = await fetchFollowingList(pubkey);
    if (!isActivePubkey(pubkey) || gen !== profileLoadGenRef.current) return;

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
    try {
      // Clear DM key cache so it picks up the new account's key
      const { clearDMKeyCache } = await import('@/lib/nostr/dm');
      clearDMKeyCache();
      await activateAccount(index, accounts);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Account switch failed';
      alert(msg);
    }
  }

  async function handleAddAccount(mode: 'generated' | 'nip07' | 'nsec' = 'generated') {
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
      let newAccounts: Account[];
      let newIndex: number;

      if (mode === 'nip07') {
        const hint = 'Switch to the account you want in your NIP-07 extension, then click OK.';
        if (!confirm(hint)) return;
        ({ accounts: newAccounts, newIndex } = await addNip07AccountToVault(pw));
      } else if (mode === 'nsec') {
        const nsec = prompt('Paste nsec for the new account');
        if (!nsec?.trim()) return;
        ({ accounts: newAccounts, newIndex } = await addNsecAccountToVault(pw, nsec.trim()));
      } else {
        ({ accounts: newAccounts, newIndex } = await addAccountToVault(pw));
      }

      setAccounts(newAccounts);
      await chrome.storage.local.set({ cached_accounts: newAccounts });

      await chrome.runtime.sendMessage({
        type: 'vault:unlock',
        payload: { password: pw },
        id: createMessageId(),
      });

      await activateAccount(newIndex, newAccounts, { password: pw, forceUnlock: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to add account';
      alert(msg);
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
          signEventWithFallback(event, publicKey)
            .then(resolve)
            .catch(reject);
        },
        onCancel: () => {
          setSigningRequest(null);
          reject(new Error('Signing cancelled by user'));
        },
      });
    });
  }

  async function handleUpgradeWithNsec(nsec: string) {
    if (!vaultPassword) throw new Error('Unlock your vault first');
    const updated = await upgradeAccountWithNsec(vaultPassword, publicKey, nsec);
    setAccounts(updated);
    await chrome.storage.local.set({ cached_accounts: updated });
    await chrome.runtime.sendMessage({
      type: 'vault:unlock',
      payload: { password: vaultPassword },
      id: createMessageId(),
    });
    await activateAccount(activeAccountIndex, updated, { password: vaultPassword, forceUnlock: true });
  }

  const canSignOnchain = accounts[activeAccountIndex]?.canSignOnchain ?? false;

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
      canSignOnchain,
      handleUpgradeWithNsec,
    }}>
      {children}
    </AuthContext.Provider>
  );
}
