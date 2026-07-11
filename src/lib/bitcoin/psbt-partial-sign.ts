/**
 * Unified PSBT partial-signing for multisig rounds.
 *
 * Order of strategies:
 * 1. App vault (web session or extension background) — tries EVERY vault key
 * 2. NIP-07 `signSchnorr` (Alby, Nostr Onchain extension, …) — the user's
 *    existing Nostr signer signs the Taproot sighash like a Nostr event;
 *    no nsec ever touches the app
 * 3. Injected `window.bitcoin.signPsbtPartial` provider
 */

import { createMessageId } from '@/shared/messages';

export interface PartialSignResult {
  psbtHex: string;
  source: 'vault' | 'nip07-schnorr' | 'bitcoin-api';
}

type SignerWindow = Window & {
  nostr?: {
    getPublicKey?: () => Promise<string>;
    signSchnorr?: (hash: string) => Promise<string>;
  };
  bitcoin?: {
    signPsbtPartial?: (h: string) => Promise<{ psbtHex?: string } | string>;
  };
};

export async function partialSignPsbt(
  psbtHex: string,
  signerPubkeyHex?: string,
): Promise<PartialSignResult> {
  const errors: string[] = [];

  // 1. App vault (any account with a stored key)
  if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
    try {
      const resp = await chrome.runtime.sendMessage({
        type: 'btc:signPsbtPartial',
        payload: { psbtHex },
        id: createMessageId(),
      });
      if (resp?.result?.psbtHex && resp.result.psbtHex !== psbtHex) {
        return { psbtHex: resp.result.psbtHex, source: 'vault' };
      }
      if (resp?.error) errors.push(resp.error);
    } catch (err) {
      errors.push(err instanceof Error ? err.message : 'Vault signing failed');
    }
  }

  // 2. NIP-07 signSchnorr — works with any Nostr signer that exposes it
  const w = window as SignerWindow;
  if (typeof w.nostr?.signSchnorr === 'function') {
    try {
      let pubkey = signerPubkeyHex;
      if (!pubkey && w.nostr.getPublicKey) {
        pubkey = await w.nostr.getPublicKey();
      }
      if (pubkey) {
        const { signMultisigPsbtViaSchnorr } = await import('./multisig-psbt');
        const result = await signMultisigPsbtViaSchnorr(
          psbtHex,
          pubkey,
          (hashHex) => w.nostr!.signSchnorr!(hashHex),
        );
        return { psbtHex: result.psbtHex, source: 'nip07-schnorr' };
      }
    } catch (err) {
      errors.push(err instanceof Error ? err.message : 'NIP-07 Schnorr signing failed');
    }
  }

  // 3. Injected window.bitcoin provider (our extension)
  if (typeof w.bitcoin?.signPsbtPartial === 'function') {
    try {
      const result = await w.bitcoin.signPsbtPartial(psbtHex);
      const candidate = typeof result === 'string' ? result : (result?.psbtHex || '');
      if (candidate && candidate !== psbtHex) {
        return { psbtHex: candidate, source: 'bitcoin-api' };
      }
    } catch (err) {
      errors.push(err instanceof Error ? err.message : 'Extension signing failed');
    }
  }

  throw new Error(
    errors[0] ||
    'No signer could sign this PSBT. Unlock the app with the co-signer account, ' +
    'or use a NIP-07 extension that supports signSchnorr (e.g. Alby).',
  );
}
