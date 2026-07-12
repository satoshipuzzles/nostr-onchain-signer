import { createMessageId } from '@/shared/messages';
import { type UnsignedEvent, type SignedEvent } from './events';

/**
 * Sign a Nostr event via vault/background, falling back to window.nostr for
 * linked NIP-07 accounts (pubkey-only in vault).
 * IMPORTANT: Verifies the signed event pubkey matches the expected pubkey.
 */
export async function signEventWithFallback(
  event: Omit<UnsignedEvent, 'pubkey'>,
  pubkey: string,
): Promise<SignedEvent> {
  const response = await chrome.runtime.sendMessage({
    type: 'nip07:signEvent',
    payload: { event },
    id: createMessageId(),
  });

  if (!response?.error && response?.result) {
    const signed = response.result as SignedEvent;
    // Verify pubkey matches — prevent signing with wrong keypair
    if (signed.pubkey && signed.pubkey !== pubkey) {
      throw new Error(
        `Signing mismatch: your vault signed with a different key (${signed.pubkey.slice(0, 8)}...) than expected (${pubkey.slice(0, 8)}...). Switch your signer extension to match, or import nsec for this account.`
      );
    }
    return signed;
  }

  const err = (response?.error as string) || 'Signing failed';
  // A locked vault is also recoverable via an external signer — the user's
  // NIP-07 extension can sign regardless of our vault/session state
  const errLower = err.toLowerCase();
  const needsExternal =
    errLower.includes('external signer') ||
    errLower.includes('no key') ||
    errLower.includes('no private key') ||
    errLower.includes('nip-07') ||
    errLower.includes('locked');

  if (needsExternal) {
    const nostr = (window as { nostr?: { signEvent?: (e: UnsignedEvent) => Promise<SignedEvent> } }).nostr;
    if (typeof nostr?.signEvent === 'function') {
      try {
        const signed = await nostr.signEvent({ ...event, pubkey });
        // Verify the external signer used the correct key
        if (signed.pubkey && signed.pubkey !== pubkey) {
          throw new Error(
            `Your signer extension is logged into a different account (${signed.pubkey.slice(0, 8)}...). Expected: ${pubkey.slice(0, 8)}.... Switch your extension to the correct account or import nsec in Settings.`
          );
        }
        return signed;
      } catch (extErr) {
        const msg = extErr instanceof Error ? extErr.message : String(extErr);
        if (msg.includes('mismatch') || msg.includes('different account')) {
          throw extErr;
        }
        throw new Error(
          `NIP-07 signing failed: ${msg}. Unlock your signer extension (Alby/nos2x) or import nsec for this account.`,
        );
      }
    }
    if (errLower.includes('locked')) {
      // No external signer to fall back to — surface the real problem
      throw new Error(err);
    }
    throw new Error(
      'This account is linked via NIP-07 only. Install and unlock Alby or nos2x, or import nsec in Settings.',
    );
  }

  throw new Error(err);
}
