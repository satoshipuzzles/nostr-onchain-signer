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

  // 2. NIP-07 signSchnorr — works with any Nostr signer that exposes it.
  //    The signer's OWN pubkey matters (it decides which tapleaf sighash we
  //    compute), so prefer what the signer reports over the app account —
  //    they can differ when the user switched accounts in their extension.
  const w = window as SignerWindow;
  if (typeof w.nostr?.signSchnorr === 'function') {
    const candidates: string[] = [];
    try {
      if (w.nostr.getPublicKey) {
        const reported = await w.nostr.getPublicKey();
        if (reported) candidates.push(reported.toLowerCase());
      }
    } catch { /* signer may be locked — still try the app account below */ }
    if (signerPubkeyHex && !candidates.includes(signerPubkeyHex.toLowerCase())) {
      candidates.push(signerPubkeyHex.toLowerCase());
    }

    if (candidates.length > 0) {
      const { signMultisigPsbtViaSchnorr } = await import('./multisig-psbt');
      for (const pubkey of candidates) {
        try {
          const result = await signMultisigPsbtViaSchnorr(
            psbtHex,
            pubkey,
            (hashHex) => w.nostr!.signSchnorr!(hashHex),
          );
          return { psbtHex: result.psbtHex, source: 'nip07-schnorr' };
        } catch (err) {
          errors.push(err instanceof Error ? err.message : 'NIP-07 Schnorr signing failed');
        }
      }
    } else {
      errors.push('NIP-07 signer found but it did not report a public key');
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

  // Surface the most actionable error: a locked vault is expected when the
  // user signs with an external NIP-07 signer, so prefer any other failure
  const meaningful = errors.find((e) => !e.toLowerCase().includes('locked'));
  throw new Error(
    meaningful ||
    errors[0] ||
    'No signer could sign this PSBT. Unlock the app with the co-signer account, ' +
    'or use a NIP-07 extension that supports signSchnorr (e.g. Alby).',
  );
}
