/**
 * Multi-sig wallet storage and management.
 * Archives all created multi-sig wallets with full metadata,
 * key holder information, and signing history.
 */

import { type MultisigWallet, type MultisigConfig, createMultisigFromPubkeys } from './multisig';
import { type ProfileMetadata } from '@/lib/nostr/social';
import { type SyncableWalletConfig } from '@/lib/nostr/wallet-sync';

import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';

export interface KeyHolder {
  pubkey: string;
  profile?: ProfileMetadata;
  isOwnKey: boolean;
}

export interface ArchivedMultisig {
  id: string;
  ownerPubkey: string; // The pubkey that created this multi-sig
  wallet: MultisigWallet;
  name: string;
  description?: string;
  keyHolders: KeyHolder[];
  createdAt: number;
  lastActivityAt: number;
  totalReceived: number;  // sats
  totalSpent: number;     // sats
  currentBalance: number; // sats (cached)
  balanceUpdatedAt: number;
  signingRoundIds: string[]; // references to signing rounds
}

export interface PendingSignatureRequest {
  id: string;
  multisigId: string;
  roundId: string;
  direction: 'outbound' | 'inbound'; // did I send it or receive it?
  status: 'pending' | 'signed' | 'declined' | 'expired';
  psbtHex: string;
  recipientPubkey?: string;   // who I sent it to (outbound)
  senderPubkey?: string;      // who sent it to me (inbound)
  amount: number;             // sats being sent in this TX
  memo?: string;
  createdAt: number;
  respondedAt?: number;
  expiresAt: number;
}

// ─── Storage ────────────────────────────────────────────────────

const STORAGE_KEY_WALLETS = 'multisig_wallets';
const STORAGE_KEY_REQUESTS = 'pending_signatures';

export async function saveMultisigWallet(wallet: ArchivedMultisig): Promise<void> {
  const existing = await loadMultisigWallets();
  const idx = existing.findIndex((w) => w.id === wallet.id);
  if (idx >= 0) {
    existing[idx] = wallet;
  } else {
    existing.push(wallet);
  }
  await chrome.storage.local.set({ [STORAGE_KEY_WALLETS]: existing });
  syncWalletsToRelay().catch(() => {});
}

export async function loadMultisigWallets(): Promise<ArchivedMultisig[]> {
  const result = await chrome.storage.local.get(STORAGE_KEY_WALLETS);
  const raw = result[STORAGE_KEY_WALLETS];
  if (!Array.isArray(raw)) return [];
  return raw.filter((w: any) => w && w.id && w.wallet);
}

export async function loadMyMultisigWallets(ownerPubkey: string): Promise<ArchivedMultisig[]> {
  const all = await loadMultisigWallets();
  return all.filter((w) =>
    !w.ownerPubkey ||
    w.ownerPubkey === ownerPubkey ||
    w.wallet?.config?.pubkeys?.includes(ownerPubkey) ||
    w.keyHolders?.some((kh) => kh.pubkey === ownerPubkey)
  );
}

export async function loadAllMultisigWallets(): Promise<ArchivedMultisig[]> {
  return loadMultisigWallets();
}

/**
 * Migrate legacy wallets that have no ownerPubkey by stamping them with the
 * given pubkey.  Call once on app startup so old wallets get assigned to the
 * current (first) account and stop leaking into other accounts.
 */
export async function migrateUnownedWallets(ownerPubkey: string): Promise<void> {
  const all = await loadMultisigWallets();
  let changed = false;
  for (const w of all) {
    if (!w.ownerPubkey) {
      w.ownerPubkey = ownerPubkey;
      changed = true;
    }
  }
  if (changed) {
    await chrome.storage.local.set({ [STORAGE_KEY_WALLETS]: all });
  }
}

export async function getMultisigWallet(id: string): Promise<ArchivedMultisig | null> {
  const wallets = await loadMultisigWallets();
  return wallets.find((w) => w.id === id) ?? null;
}

export async function deleteMultisigWallet(id: string): Promise<void> {
  const wallets = await loadMultisigWallets();
  await chrome.storage.local.set({
    [STORAGE_KEY_WALLETS]: wallets.filter((w) => w.id !== id),
  });
  syncWalletsToRelay().catch(() => {});
}

export async function updateMultisigBalance(id: string, balance: number): Promise<void> {
  const wallets = await loadMultisigWallets();
  const wallet = wallets.find((w) => w.id === id);
  if (wallet) {
    wallet.currentBalance = balance;
    wallet.balanceUpdatedAt = Date.now();
    await chrome.storage.local.set({ [STORAGE_KEY_WALLETS]: wallets });
  }
}

// ─── Pending Signatures ──────────────────────────────────────────

export async function savePendingRequest(request: PendingSignatureRequest): Promise<void> {
  const existing = await loadPendingRequests();
  const idx = existing.findIndex((r) => r.id === request.id);
  if (idx >= 0) {
    existing[idx] = request;
  } else {
    existing.push(request);
  }
  await chrome.storage.local.set({ [STORAGE_KEY_REQUESTS]: existing });
}

export async function loadPendingRequests(): Promise<PendingSignatureRequest[]> {
  const result = await chrome.storage.local.get(STORAGE_KEY_REQUESTS);
  const raw = result[STORAGE_KEY_REQUESTS];
  if (!Array.isArray(raw)) return [];
  return raw;
}

export async function updateRequestStatus(
  id: string,
  status: PendingSignatureRequest['status'],
  psbtHex?: string
): Promise<void> {
  const requests = await loadPendingRequests();
  const request = requests.find((r) => r.id === id);
  if (request) {
    request.status = status;
    if (psbtHex) request.psbtHex = psbtHex;
    request.respondedAt = Date.now();
    await chrome.storage.local.set({ [STORAGE_KEY_REQUESTS]: requests });
  }
}

export async function getRequestsForWallet(multisigId: string): Promise<PendingSignatureRequest[]> {
  const requests = await loadPendingRequests();
  return requests.filter((r) => r.multisigId === multisigId);
}

export async function getPendingInbound(): Promise<PendingSignatureRequest[]> {
  const requests = await loadPendingRequests();
  return requests.filter((r) => r.direction === 'inbound' && r.status === 'pending');
}

export async function getPendingOutbound(): Promise<PendingSignatureRequest[]> {
  const requests = await loadPendingRequests();
  return requests.filter((r) => r.direction === 'outbound' && r.status === 'pending');
}

export async function renameMultisigWallet(id: string, name: string): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('Wallet name is required');
  const wallets = await loadMultisigWallets();
  const wallet = wallets.find((w) => w.id === id);
  if (!wallet) throw new Error('Wallet not found');
  wallet.name = trimmed;
  wallet.lastActivityAt = Date.now();
  await chrome.storage.local.set({ [STORAGE_KEY_WALLETS]: wallets });
  syncWalletsToRelay().catch(() => {});
}

/** Short display ID from address — not a Nostr npub. */
export function addressFingerprint(address: string): string {
  const hash = sha256(new TextEncoder().encode(address));
  return bytesToHex(hash).slice(0, 8);
}

const PERSONAL_LABEL_KEY = 'personal_wallet_labels';

export async function getPersonalWalletLabel(pubkey: string): Promise<string> {
  const result = await chrome.storage.local.get(PERSONAL_LABEL_KEY);
  const labels = (result[PERSONAL_LABEL_KEY] || {}) as Record<string, string>;
  return labels[pubkey] || 'Personal Wallet';
}

export async function setPersonalWalletLabel(pubkey: string, name: string): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('Wallet name is required');
  const result = await chrome.storage.local.get(PERSONAL_LABEL_KEY);
  const labels = (result[PERSONAL_LABEL_KEY] || {}) as Record<string, string>;
  labels[pubkey] = trimmed;
  await chrome.storage.local.set({ [PERSONAL_LABEL_KEY]: labels });
}

// ─── Helpers ────────────────────────────────────────────────────

export function createArchivedMultisig(
  wallet: MultisigWallet,
  keyHolders: KeyHolder[],
  name: string,
  description?: string,
  ownerPubkey?: string
): ArchivedMultisig {
  return {
    id: generateId(),
    ownerPubkey: ownerPubkey || '',
    wallet,
    name,
    description,
    keyHolders,
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    totalReceived: 0,
    totalSpent: 0,
    currentBalance: 0,
    balanceUpdatedAt: 0,
    signingRoundIds: [],
  };
}

function generateId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ─── Relay Sync ─────────────────────────────────────────────────

export function walletToSyncConfig(wallet: ArchivedMultisig): SyncableWalletConfig {
  return {
    id: wallet.id,
    name: wallet.name,
    description: wallet.description,
    threshold: wallet.wallet.config.threshold,
    pubkeys: wallet.wallet.config.pubkeys,
    createdAt: wallet.createdAt,
  };
}

export function syncConfigToWallet(
  config: SyncableWalletConfig,
  ownerPubkey: string,
): ArchivedMultisig {
  const wallet = createMultisigFromPubkeys(config.pubkeys, config.threshold);

  return {
    id: config.id,
    ownerPubkey,
    wallet,
    name: config.name,
    description: config.description,
    keyHolders: config.pubkeys.map((pk) => ({
      pubkey: pk,
      isOwnKey: pk === ownerPubkey,
    })),
    createdAt: config.createdAt,
    lastActivityAt: config.createdAt,
    totalReceived: 0,
    totalSpent: 0,
    currentBalance: 0,
    balanceUpdatedAt: 0,
    signingRoundIds: [],
  };
}

async function syncWalletsToRelay(): Promise<void> {
  const { publishWalletConfigs } = await import('@/lib/nostr/wallet-sync');
  const all = await loadMultisigWallets();
  const configs = all.map(walletToSyncConfig);
  const syncKey = sessionStorage.getItem('nostr_onchain_wallet_sync_key');
  if (!syncKey) return;
  await publishWalletConfigs(configs, syncKey);
}
