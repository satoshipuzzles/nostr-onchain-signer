/**
 * NIP-17 Gift Wrap implementation for private DMs.
 *
 * Flow (sending):
 *  1. Build a kind-14 rumor (unsigned DM content)
 *  2. Seal it (kind 13): sign with sender key, encrypt content to recipient via NIP-44
 *  3. Gift wrap (kind 1059): sign with random ephemeral key, encrypt seal to recipient via NIP-44
 *
 * Flow (receiving):
 *  1. Decrypt kind-1059 gift wrap content with our key (NIP-44, sender = gift wrap pubkey)
 *  2. Parse the seal (kind 13), verify signature
 *  3. Decrypt seal content with our key (NIP-44, sender = seal pubkey / real sender)
 *  4. Parse the rumor (kind 14) — this is the actual DM
 */

import { getPublicKey, finalizeEvent, verifyEvent } from 'nostr-tools/pure';
import * as nip44 from 'nostr-tools/nip44';
import { hexToBytes, bytesToHex, randomBytes } from '@noble/hashes/utils';

export interface Rumor {
  id?: string;
  kind: number;
  created_at: number;
  content: string;
  tags: string[][];
  pubkey: string;
}

export interface GiftWrapResult {
  giftWrap: ReturnType<typeof finalizeEvent>;
  recipientPubkey: string;
}

function randomTimestampWithin2Days(): number {
  const now = Math.floor(Date.now() / 1000);
  const twoDays = 2 * 24 * 60 * 60;
  return now - Math.floor(Math.random() * twoDays);
}

function nip44Encrypt(senderPrivHex: string, recipientPubHex: string, plaintext: string): string {
  const ck = nip44.getConversationKey(hexToBytes(senderPrivHex), recipientPubHex);
  return nip44.encrypt(plaintext, ck);
}

function nip44Decrypt(receiverPrivHex: string, senderPubHex: string, ciphertext: string): string {
  const ck = nip44.getConversationKey(hexToBytes(receiverPrivHex), senderPubHex);
  return nip44.decrypt(ciphertext, ck);
}

/**
 * Create and gift-wrap a DM for a recipient.
 * Returns the kind-1059 event ready to publish.
 */
export function createGiftWrap(
  senderPrivHex: string,
  recipientPubHex: string,
  plaintext: string,
): GiftWrapResult {
  const senderPubHex = getPublicKey(hexToBytes(senderPrivHex));

  // 1. Rumor (kind 14) — NOT signed, no id needed for sealing
  const rumor: Rumor = {
    kind: 14,
    created_at: randomTimestampWithin2Days(),
    content: plaintext,
    tags: [['p', recipientPubHex]],
    pubkey: senderPubHex,
  };

  // 2. Seal (kind 13) — signed by sender, content encrypted to recipient
  const sealContent = nip44Encrypt(senderPrivHex, recipientPubHex, JSON.stringify(rumor));
  const sealEvent = finalizeEvent({
    kind: 13,
    created_at: randomTimestampWithin2Days(),
    content: sealContent,
    tags: [],
  }, hexToBytes(senderPrivHex));

  // 3. Gift Wrap (kind 1059) — signed by ephemeral key, content encrypted to recipient
  const ephemeralPriv = randomBytes(32);
  const ephemeralPrivHex = bytesToHex(ephemeralPriv);
  const wrapContent = nip44Encrypt(ephemeralPrivHex, recipientPubHex, JSON.stringify(sealEvent));
  const giftWrap = finalizeEvent({
    kind: 1059,
    created_at: randomTimestampWithin2Days(),
    content: wrapContent,
    tags: [['p', recipientPubHex]],
  }, ephemeralPriv);

  return { giftWrap, recipientPubkey: recipientPubHex };
}

/**
 * Unwrap a received kind-1059 gift wrap event.
 * Returns the decrypted rumor (kind 14 DM) and verified sender pubkey, or null on failure.
 */
export function unwrapGiftWrap(
  receiverPrivHex: string,
  giftWrapEvent: { pubkey: string; content: string; kind: number; tags?: string[][] },
): { rumor: Rumor; senderPubkey: string } | null {
  if (giftWrapEvent.kind !== 1059) return null;

  try {
    // Decrypt outer layer (gift wrap → seal)
    const sealJson = nip44Decrypt(receiverPrivHex, giftWrapEvent.pubkey, giftWrapEvent.content);
    const seal = JSON.parse(sealJson);

    if (seal.kind !== 13) return null;
    if (!verifyEvent(seal)) return null;

    const senderPubkey = seal.pubkey;

    // Decrypt inner layer (seal → rumor)
    const rumorJson = nip44Decrypt(receiverPrivHex, senderPubkey, seal.content);
    const rumor: Rumor = JSON.parse(rumorJson);

    if (rumor.pubkey !== senderPubkey) return null;

    return { rumor, senderPubkey };
  } catch {
    return null;
  }
}
