/**
 * Multi-sig wallet storage and management.
 * Archives all created multi-sig wallets with full metadata,
 * key holder information, and signing history.
 */

import { type MultisigWallet, type MultisigConfig } from './multisig';
import { type ProfileMetadata } from '@/lib/nostr/social';

export interface KeyHolder {
  pubkey: string;
  profile?: ProfileMetadata;
  isOwnKey: boolean;
}

export interface ArchivedMultisig {
  id: string;
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
}

export async function loadMultisigWallets(): Promise<ArchivedMultisig[]> {
  const result = await chrome.storage.local.get(STORAGE_KEY_WALLETS);
  return result[STORAGE_KEY_WALLETS] ?? [];
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
  return result[STORAGE_KEY_REQUESTS] ?? [];
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

// ─── Helpers ────────────────────────────────────────────────────

export function createArchivedMultisig(
  wallet: MultisigWallet,
  keyHolders: KeyHolder[],
  name: string,
  description?: string
): ArchivedMultisig {
  return {
    id: generateId(),
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
