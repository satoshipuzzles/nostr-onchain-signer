/**
 * Multi-account management.
 * Users can have multiple npub accounts and switch between them
 * like switching Gmail accounts.
 */

import { type VaultData, decryptVault, encryptVault, loadVault, saveVault } from '@/lib/crypto/vault';
import { keyPairFromPrivateKey, generateKeyPair, pubkeyToNpub } from '@/lib/nostr/keys';

export interface Account {
  publicKeyHex: string;
  npub: string;
  label: string;
  createdAt: number;
  picture?: string;
  displayName?: string;
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
    const pair = keyPairFromPrivateKey(data.privateKeyHex);
    return {
      publicKeyHex: pair.publicKeyHex,
      npub: pair.npub,
      label: data.label || `Account ${pair.npub.slice(5, 11)}`,
      createdAt: data.createdAt,
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
