/**
 * Encrypted key vault: scrypt (N=2^15, r=8, p=1) + AES-256-GCM via WebCrypto.
 * Keys never leave this module unencrypted except through explicit getters
 * used by signing flows. Watch-only accounts carry no private key.
 */

import { scrypt } from '@noble/hashes/scrypt';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { schnorr } from '@noble/curves/secp256k1';
import { pubkeyToTaprootAddress } from '@nostr-onchain/core';

const VAULT_KEY = 'bwm_vault_v1';

export interface VaultAccount {
  id: string;
  label: string;
  /** x-only pubkey (nostr-compatible). */
  publicKeyHex: string;
  /** Present only for signing accounts. */
  privateKeyHex?: string;
  watchOnly: boolean;
  /** For watch-only entries added by address instead of pubkey. */
  addressOverride?: string;
  createdAt: number;
}

interface VaultPayload {
  accounts: VaultAccount[];
}

interface VaultFile {
  v: 1;
  salt: string;
  iv: string;
  ct: string;
}

let session: VaultPayload | null = null;
let sessionPassword: string | null = null;
const listeners = new Set<() => void>();

export function onVaultChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function notify() {
  listeners.forEach((fn) => fn());
}

export function vaultExists(): boolean {
  return localStorage.getItem(VAULT_KEY) !== null;
}

export function isUnlocked(): boolean {
  return session !== null;
}

async function deriveAesKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const keyBytes = scrypt(new TextEncoder().encode(password), salt, { N: 2 ** 15, r: 8, p: 1, dkLen: 32 });
  return crypto.subtle.importKey('raw', keyBytes as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function persist(): Promise<void> {
  if (!session || !sessionPassword) throw new Error('Vault is locked');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveAesKey(sessionPassword, salt);
  const plaintext = new TextEncoder().encode(JSON.stringify(session));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, plaintext as BufferSource));
  const file: VaultFile = { v: 1, salt: bytesToHex(salt), iv: bytesToHex(iv), ct: bytesToHex(ct) };
  localStorage.setItem(VAULT_KEY, JSON.stringify(file));
  notify();
}

export async function createVault(password: string): Promise<void> {
  if (vaultExists()) throw new Error('Vault already exists');
  if (password.length < 8) throw new Error('Password must be at least 8 characters');
  session = { accounts: [] };
  sessionPassword = password;
  await persist();
}

export async function unlockVault(password: string): Promise<void> {
  const raw = localStorage.getItem(VAULT_KEY);
  if (!raw) throw new Error('No vault found');
  const file: VaultFile = JSON.parse(raw);
  const key = await deriveAesKey(password, hexToBytes(file.salt));
  try {
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: hexToBytes(file.iv) as BufferSource },
      key,
      hexToBytes(file.ct) as BufferSource
    );
    session = JSON.parse(new TextDecoder().decode(pt));
    sessionPassword = password;
    notify();
  } catch {
    throw new Error('Wrong password');
  }
}

export function lockVault(): void {
  session = null;
  sessionPassword = null;
  notify();
}

export function getAccounts(): VaultAccount[] {
  return session?.accounts ?? [];
}

export function getAccount(id: string): VaultAccount | undefined {
  return session?.accounts.find((a) => a.id === id);
}

export function accountAddress(account: VaultAccount, network: 'mainnet' | 'testnet' = 'mainnet'): string {
  return account.addressOverride ?? pubkeyToTaprootAddress(account.publicKeyHex, network);
}

export async function addSigningAccount(privateKeyHex: string, label: string): Promise<VaultAccount> {
  if (!session) throw new Error('Vault is locked');
  if (!/^[0-9a-f]{64}$/i.test(privateKeyHex)) throw new Error('Expected 32-byte private key hex');
  const publicKeyHex = bytesToHex(schnorr.getPublicKey(hexToBytes(privateKeyHex)));
  if (session.accounts.some((a) => a.publicKeyHex === publicKeyHex)) {
    throw new Error('Account already in vault');
  }
  const account: VaultAccount = {
    id: `acct_${publicKeyHex.slice(0, 12)}`,
    label,
    publicKeyHex,
    privateKeyHex: privateKeyHex.toLowerCase(),
    watchOnly: false,
    createdAt: Date.now(),
  };
  session.accounts.push(account);
  await persist();
  return account;
}

export async function generateAccount(label: string): Promise<VaultAccount> {
  const priv = crypto.getRandomValues(new Uint8Array(32));
  return addSigningAccount(bytesToHex(priv), label);
}

export async function addWatchOnlyAccount(params: { pubkeyHex?: string; address?: string; label: string }): Promise<VaultAccount> {
  if (!session) throw new Error('Vault is locked');
  const { pubkeyHex, address, label } = params;
  if (!pubkeyHex && !address) throw new Error('Provide a pubkey or an address');
  const publicKeyHex = pubkeyHex?.toLowerCase() ?? `watch_${address}`;
  if (session.accounts.some((a) => a.publicKeyHex === publicKeyHex)) {
    throw new Error('Account already in vault');
  }
  const account: VaultAccount = {
    id: `acct_${(pubkeyHex ?? address ?? '').slice(0, 12)}_${Date.now() % 10000}`,
    label,
    publicKeyHex,
    watchOnly: true,
    addressOverride: pubkeyHex ? undefined : address,
    createdAt: Date.now(),
  };
  session.accounts.push(account);
  await persist();
  return account;
}

export async function removeAccount(id: string): Promise<void> {
  if (!session) throw new Error('Vault is locked');
  session.accounts = session.accounts.filter((a) => a.id !== id);
  await persist();
}

export async function renameAccount(id: string, label: string): Promise<void> {
  if (!session) throw new Error('Vault is locked');
  const acct = session.accounts.find((a) => a.id === id);
  if (acct) {
    acct.label = label;
    await persist();
  }
}
