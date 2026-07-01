/**
 * NIP-07 provider implementation.
 * This gets injected into web pages via the content script.
 *
 * Implements the window.nostr interface:
 * - getPublicKey(): Promise<string>
 * - signEvent(event): Promise<SignedEvent>
 * - getRelays(): Promise<RelayMap>
 * - nip04.encrypt(pubkey, plaintext): Promise<string>
 * - nip04.decrypt(pubkey, ciphertext): Promise<string>
 * - nip44.encrypt(pubkey, plaintext): Promise<string>
 * - nip44.decrypt(pubkey, ciphertext): Promise<string>
 */

export interface Nip07Event {
  kind: number;
  content: string;
  tags: string[][];
  created_at: number;
  pubkey?: string;
}

export interface SignedNip07Event extends Nip07Event {
  id: string;
  sig: string;
  pubkey: string;
}

export type RelayPolicy = { read: boolean; write: boolean };
export type RelayMap = Record<string, RelayPolicy>;

export interface Nip07Provider {
  getPublicKey(): Promise<string>;
  signEvent(event: Nip07Event): Promise<SignedNip07Event>;
  getRelays?(): Promise<RelayMap>;
  nip04?: {
    encrypt(pubkey: string, plaintext: string): Promise<string>;
    decrypt(pubkey: string, ciphertext: string): Promise<string>;
  };
  nip44?: {
    encrypt(pubkey: string, plaintext: string): Promise<string>;
    decrypt(pubkey: string, ciphertext: string): Promise<string>;
  };
}

/**
 * Message types for communication between content script and background.
 */
export const NIP07_MESSAGE_TYPES = {
  GET_PUBLIC_KEY: 'nip07:getPublicKey',
  SIGN_EVENT: 'nip07:signEvent',
  GET_RELAYS: 'nip07:getRelays',
  NIP04_ENCRYPT: 'nip07:nip04:encrypt',
  NIP04_DECRYPT: 'nip07:nip04:decrypt',
  NIP44_ENCRYPT: 'nip07:nip44:encrypt',
  NIP44_DECRYPT: 'nip07:nip44:decrypt',
} as const;
