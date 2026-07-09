import * as nip04 from 'nostr-tools/nip04';
import * as nip44 from 'nostr-tools/nip44';
import { hexToBytes } from '@noble/hashes/utils';

export async function encryptNip04(
  privateKeyHex: string,
  recipientPubkey: string,
  plaintext: string,
): Promise<string> {
  return nip04.encrypt(privateKeyHex, recipientPubkey, plaintext);
}

export async function decryptNip04(
  privateKeyHex: string,
  senderPubkey: string,
  ciphertext: string,
): Promise<string> {
  return nip04.decrypt(privateKeyHex, senderPubkey, ciphertext);
}

export function encryptNip44(
  privateKeyHex: string,
  recipientPubkey: string,
  plaintext: string,
): string {
  const conversationKey = nip44.getConversationKey(hexToBytes(privateKeyHex), recipientPubkey);
  return nip44.encrypt(plaintext, conversationKey);
}

export function decryptNip44(
  privateKeyHex: string,
  senderPubkey: string,
  ciphertext: string,
): string {
  const conversationKey = nip44.getConversationKey(hexToBytes(privateKeyHex), senderPubkey);
  return nip44.decrypt(ciphertext, conversationKey);
}
