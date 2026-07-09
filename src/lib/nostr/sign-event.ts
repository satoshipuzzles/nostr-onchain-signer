import { createMessageId } from '@/shared/messages';
import { type UnsignedEvent, type SignedEvent } from './events';

/**
 * Sign a Nostr event via vault/background, falling back to window.nostr for
 * linked NIP-07 accounts (pubkey-only in vault).
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
    return response.result as SignedEvent;
  }

  const err = (response?.error as string) || 'Signing failed';
  const needsExternal =
    err.includes('External signer') ||
    err.includes('no key') ||
    err.includes('no private key');

  if (needsExternal) {
    const nostr = (window as { nostr?: { signEvent?: (e: UnsignedEvent) => Promise<SignedEvent> } }).nostr;
    if (typeof nostr?.signEvent === 'function') {
      try {
        return await nostr.signEvent({ ...event, pubkey });
      } catch (extErr) {
        const msg = extErr instanceof Error ? extErr.message : String(extErr);
        throw new Error(
          `NIP-07 signing failed: ${msg}. Unlock your signer extension (Alby/nos2x) or import nsec for this account.`,
        );
      }
    }
    throw new Error(
      'This account is linked via NIP-07 only. Install and unlock Alby or nos2x, or import nsec in Settings.',
    );
  }

  throw new Error(err);
}
