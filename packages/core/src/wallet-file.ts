/**
 * Wallet manifest: the app's native wallet file format. Plain JSON, no keys —
 * private keys never leave the encrypted vault. Exports/imports interoperate
 * with the descriptor + BIP-329 ecosystem (Sparrow, Core, Electrum).
 */

import type { Bip329Label } from './bip329';
import { trDescriptor } from './descriptors';
import { pubkeyToTaprootAddress } from './address';

export interface WalletAccount {
  id: string;
  label: string;
  type: 'taproot-nostr' | 'watch-only';
  /** x-only pubkey (nostr) — present for taproot-nostr accounts. */
  xOnlyPubkeyHex?: string;
  /** Output descriptor (canonical wallet definition). */
  descriptor: string;
  /** Primary receive address. */
  address: string;
  /** Published silent-payment address, if any. */
  silentPaymentAddress?: string;
  createdAt: number;
}

export interface WalletManifest {
  format: 'nostr-onchain-wallet';
  version: 1;
  name: string;
  network: 'mainnet' | 'testnet';
  accounts: WalletAccount[];
  labels: Bip329Label[];
  createdAt: number;
  updatedAt: number;
}

export function createManifest(name: string, network: 'mainnet' | 'testnet' = 'mainnet'): WalletManifest {
  const now = Date.now();
  return {
    format: 'nostr-onchain-wallet',
    version: 1,
    name,
    network,
    accounts: [],
    labels: [],
    createdAt: now,
    updatedAt: now,
  };
}

export function accountFromNostrPubkey(
  xOnlyPubkeyHex: string,
  label: string,
  network: 'mainnet' | 'testnet' = 'mainnet'
): WalletAccount {
  return {
    id: `acct_${xOnlyPubkeyHex.slice(0, 12)}`,
    label,
    type: 'taproot-nostr',
    xOnlyPubkeyHex: xOnlyPubkeyHex.toLowerCase(),
    descriptor: trDescriptor(xOnlyPubkeyHex),
    address: pubkeyToTaprootAddress(xOnlyPubkeyHex, network),
    createdAt: Date.now(),
  };
}

export function serializeManifest(manifest: WalletManifest): string {
  return JSON.stringify({ ...manifest, updatedAt: Date.now() }, null, 2);
}

export function parseManifest(json: string): WalletManifest {
  const obj = JSON.parse(json);
  if (obj?.format !== 'nostr-onchain-wallet' || obj?.version !== 1) {
    throw new Error('Not a nostr-onchain wallet file');
  }
  if (!Array.isArray(obj.accounts)) throw new Error('Malformed wallet file: missing accounts');
  return obj as WalletManifest;
}
