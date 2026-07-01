/**
 * Nostr event creation and signing.
 */

import { sha256 } from '@noble/hashes/sha256';
import { schnorr } from '@noble/curves/secp256k1';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';

export const KIND = {
  METADATA: 0,
  TEXT_NOTE: 1,
  CONTACTS: 3,
  DM: 4,
  REPOST: 6,
  REACTION: 7,
  ZAP_REQUEST: 9734,
  ZAP_RECEIPT: 9735,
} as const;

export interface UnsignedEvent {
  kind: number;
  content: string;
  tags: string[][];
  created_at: number;
  pubkey: string;
}

export interface SignedEvent extends UnsignedEvent {
  id: string;
  sig: string;
}

/**
 * Compute the event ID (NIP-01).
 * id = sha256(serialized_event)
 * serialized = [0, pubkey, created_at, kind, tags, content]
 */
export function computeEventId(event: UnsignedEvent): string {
  const serialized = JSON.stringify([
    0,
    event.pubkey,
    event.created_at,
    event.kind,
    event.tags,
    event.content,
  ]);
  const hash = sha256(new TextEncoder().encode(serialized));
  return bytesToHex(hash);
}

/**
 * Sign a Nostr event with a private key (Schnorr/BIP340).
 */
export function signEvent(
  event: UnsignedEvent,
  privateKeyHex: string
): SignedEvent {
  const id = computeEventId(event);
  const sig = schnorr.sign(hexToBytes(id), hexToBytes(privateKeyHex));

  return {
    ...event,
    id,
    sig: bytesToHex(sig),
  };
}

/**
 * Verify a signed Nostr event.
 */
export function verifyEvent(event: SignedEvent): boolean {
  try {
    const expectedId = computeEventId(event);
    if (expectedId !== event.id) return false;
    return schnorr.verify(
      hexToBytes(event.sig),
      hexToBytes(event.id),
      hexToBytes(event.pubkey)
    );
  } catch {
    return false;
  }
}

export function createTextNote(content: string, pubkey: string): UnsignedEvent {
  return {
    kind: KIND.TEXT_NOTE,
    content,
    tags: [],
    created_at: Math.floor(Date.now() / 1000),
    pubkey,
  };
}
