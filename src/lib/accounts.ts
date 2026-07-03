/**
 * Multi-account management.
 * Users can have multiple npub accounts and switch between them
 * like switching Gmail accounts.
 */

import { type VaultData, decryptVault, encryptVault, loadVault, saveVault } from '@/lib/crypto/vault';
import { keyPairFromPrivateKey, generateKeyPair, pubkeyToNpub, nsecToPrivkey, isValidNsec } from '@/lib/nostr/keys';
import { detectNostrSignerType, nip07SignerLabel } from '@/lib/bitcoin/psbt-external-sign';

export interface Account {
  publicKeyHex: string;
  npub: string;
  label: string;
  createdAt: number;
  picture?: string;
  displayName?: string;
  /** True when vault holds the private key (can sign Bitcoin PSBTs). */
  canSignOnchain: boolean;
  /** True when pubkey is linked via browser extension only. */
  externalSigner?: boolean;
  signerType?: VaultData['signerType'];
}

export interface AccountStore {
  accounts: Account[];
  activeIndex: number;
}

/**
 * Get all accounts from the vault (requires decrypted vault data).
 */
export function getAccountsFromVault(vaultData: VaultData[]): Account[] {
  return vaultData.map((data) => {
    if (!data.privateKeyHex) {
      return {
        publicKeyHex: data.publicKeyHex,
        npub: pubkeyToNpub(data.publicKeyHex),
        label: data.label || 'NIP-07 Account',
        createdAt: data.createdAt,
        canSignOnchain: false,
        externalSigner: data.externalSigner ?? true,
        signerType: data.signerType,
      };
    }
    const pair = keyPairFromPrivateKey(data.privateKeyHex);
    return {
      publicKeyHex: pair.publicKeyHex,
      npub: pair.npub,
      label: data.label || `Account ${pair.npub.slice(5, 11)}`,
      createdAt: data.createdAt,
      canSignOnchain: true,
      externalSigner: false,
      signerType: data.signerType ?? 'imported',
    };
  });
}

/**
 * Add a new account to the vault.
 */
export async function addAccountToVault(
  password: string,
  privateKeyHex?: string,
  label?: string
): Promise<{ accounts: Account[]; newIndex: number }> {
  const vault = await loadVault();
  if (!vault) throw new Error('No vault exists');

  const existingData = await decryptVault(vault, password);

  let newKeyData: VaultData;
  if (privateKeyHex) {
    const pair = keyPairFromPrivateKey(privateKeyHex);
    newKeyData = {
      privateKeyHex: pair.privateKeyHex,
      publicKeyHex: pair.publicKeyHex,
      createdAt: Date.now(),
      label: label || `Account ${pair.npub.slice(5, 11)}`,
    };
  } else {
    const pair = generateKeyPair();
    newKeyData = {
      privateKeyHex: pair.privateKeyHex,
      publicKeyHex: pair.publicKeyHex,
      createdAt: Date.now(),
      label: label || `Account ${pair.npub.slice(5, 11)}`,
    };
  }

  // Check for duplicates
  if (existingData.some((d) => d.publicKeyHex === newKeyData.publicKeyHex)) {
    throw new Error('Account already exists in vault');
  }

  const updatedData = [...existingData, newKeyData];
  const encrypted = await encryptVault(updatedData, password);
  await saveVault(encrypted);

  const accounts = getAccountsFromVault(updatedData);
  return { accounts, newIndex: updatedData.length - 1 };
}

/**
 * Add an account from a NIP-07 browser extension.
 * User should switch to the desired account in their extension first.
 */
export async function addNip07AccountToVault(
  password: string
): Promise<{ accounts: Account[]; newIndex: number }> {
  const w = window as { nostr?: { getPublicKey?: () => Promise<string> } };
  if (!w.nostr?.getPublicKey) {
    throw new Error('No NIP-07 extension found. Install Alby, nos2x, or another Nostr signer.');
  }

  const pubkey = await w.nostr.getPublicKey();
  if (!pubkey || pubkey.length !== 64) {
    throw new Error('Extension returned an invalid public key');
  }

  const signerType = detectNostrSignerType();
  const label = `${nip07SignerLabel(signerType)} (Extension)`;

  const vault = await loadVault();
  if (!vault) throw new Error('No vault exists');

  const existingData = await decryptVault(vault, password);
  if (existingData.some((d) => d.publicKeyHex === pubkey)) {
    const idx = existingData.findIndex((d) => d.publicKeyHex === pubkey);
    return { accounts: getAccountsFromVault(existingData), newIndex: idx };
  }

  const newKeyData: VaultData = {
    privateKeyHex: '',
    publicKeyHex: pubkey,
    createdAt: Date.now(),
    label,
    externalSigner: true,
    signerType,
  };

  const updatedData = [...existingData, newKeyData];
  const encrypted = await encryptVault(updatedData, password);
  await saveVault(encrypted);

  return { accounts: getAccountsFromVault(updatedData), newIndex: updatedData.length - 1 };
}

/**
 * Add an account by importing nsec.
 */
export async function addNsecAccountToVault(
  password: string,
  nsec: string,
  label?: string
): Promise<{ accounts: Account[]; newIndex: number }> {
  if (!isValidNsec(nsec)) throw new Error('Invalid nsec');
  const privHex = nsecToPrivkey(nsec);
  const pair = keyPairFromPrivateKey(privHex);
  return addAccountToVault(password, pair.privateKeyHex, label || `Imported ${pair.npub.slice(5, 11)}`);
}

/**
 * Remove an account from the vault.
 */
export async function removeAccountFromVault(
  password: string,
  publicKeyHex: string
): Promise<Account[]> {
  const vault = await loadVault();
  if (!vault) throw new Error('No vault exists');

  const existingData = await decryptVault(vault, password);
  const filtered = existingData.filter((d) => d.publicKeyHex !== publicKeyHex);

  if (filtered.length === 0) {
    throw new Error('Cannot remove the last account');
  }

  const encrypted = await encryptVault(filtered, password);
  await saveVault(encrypted);

  return getAccountsFromVault(filtered);
}

/**
 * Save the active account index.
 */
export async function saveActiveAccountIndex(index: number): Promise<void> {
  await chrome.storage.local.set({ activeAccountIndex: index });
}

/**
 * Load the active account index.
 */
export async function loadActiveAccountIndex(): Promise<number> {
  const result = await chrome.storage.local.get('activeAccountIndex');
  return result.activeAccountIndex ?? 0;
}

/**
 * Update account metadata (picture, displayName) from profile fetches.
 */
export async function updateAccountMeta(
  publicKeyHex: string,
  meta: { picture?: string; displayName?: string }
): Promise<void> {
  const key = `account_meta_${publicKeyHex}`;
  await chrome.storage.local.set({ [key]: meta });
}

export async function loadAccountMeta(
  publicKeyHex: string
): Promise<{ picture?: string; displayName?: string }> {
  const key = `account_meta_${publicKeyHex}`;
  const result = await chrome.storage.local.get(key);
  return result[key] ?? {};
}

/**
 * Upgrade a NIP-07-only vault entry by binding the matching nsec.
 * Same pubkey — enables in-app Bitcoin PSBT signing.
 */
export async function upgradeAccountWithNsec(
  password: string,
  publicKeyHex: string,
  nsec: string
): Promise<Account[]> {
  if (!isValidNsec(nsec)) throw new Error('Invalid nsec');
  const privHex = nsecToPrivkey(nsec);
  const pair = keyPairFromPrivateKey(privHex);
  if (pair.publicKeyHex !== publicKeyHex) {
    throw new Error('This nsec does not match your active account');
  }

  const vault = await loadVault();
  if (!vault) throw new Error('No vault found');
  const data = await decryptVault(vault, password);
  const idx = data.findIndex((d) => d.publicKeyHex === publicKeyHex);
  if (idx === -1) throw new Error('Account not found in vault');

  data[idx] = {
    ...data[idx],
    privateKeyHex: pair.privateKeyHex,
    label: data[idx].label?.includes('NIP-07') ? 'Full Key Account' : (data[idx].label || 'Full Key Account'),
  };

  const encrypted = await encryptVault(data, password);
  await saveVault(encrypted);
  return getAccountsFromVault(data);
}
