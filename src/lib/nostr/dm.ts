import { createMessageId } from '@/shared/messages';
import { encryptNip04, decryptNip04, encryptNip44, decryptNip44 } from '@/lib/nostr/dm-crypto';
import { createGiftWrap, unwrapGiftWrap, type Rumor } from '@/lib/nostr/gift-wrap';

async function getSessionPrivateKey(): Promise<string | null> {
  // Try sessionStorage directly (works in both PWA and extension popup)
  try {
    const raw = sessionStorage.getItem('nostr_onchain_session_keys');
    if (raw) {
      const session = JSON.parse(raw);
      const idxRaw = sessionStorage.getItem('nostr_onchain_active_index');
      const activeIdx = idxRaw ? JSON.parse(idxRaw) : 0;
      const privateKey = session[activeIdx]?.privateKeyHex;
      if (privateKey && privateKey.length === 64) return privateKey;
    }
  } catch {}

  // Fallback: ask the runtime for the key (chrome-mock stores under prefixed key)
  try {
    const sessionData = await chrome.storage?.session?.get?.(['session_keys', 'active_index']);
    if (sessionData?.session_keys) {
      const keys = sessionData.session_keys as any[];
      const idx = (sessionData.active_index as number) ?? 0;
      const pk = keys[idx]?.privateKeyHex;
      if (pk && pk.length === 64) return pk;
    }
  } catch {}

  return null;
}

export interface GiftWrapDMResult {
  giftWrapEvent: object;
  recipientPubkey: string;
}

/**
 * Encrypt a DM using NIP-17 gift wrap (preferred) or fall back to NIP-44/NIP-04.
 * Returns either a gift wrap event to publish directly, or encrypted content + kind for legacy.
 */
export async function encryptDM(
  recipientPubkey: string,
  plaintext: string,
): Promise<{ content: string; kind: number; giftWrap?: object }> {
  const privateKey = await getSessionPrivateKey();

  // Preferred: NIP-17 gift wrap (kind 1059)
  if (privateKey) {
    try {
      const { giftWrap } = createGiftWrap(privateKey, recipientPubkey, plaintext);
      return { content: '', kind: 1059, giftWrap };
    } catch (err) {
      console.warn('Gift wrap creation failed, falling back:', err);
    }
  }

  // Fallback: NIP-44 (kind 14) via extension
  try {
    const nip44Res = await chrome.runtime.sendMessage({
      type: 'nip07:nip44:encrypt',
      payload: { pubkey: recipientPubkey, plaintext },
      id: createMessageId(),
    });
    if (nip44Res?.result) return { content: nip44Res.result, kind: 14 };
  } catch (err) {
    console.warn('NIP-44 encrypt via runtime failed:', err);
  }

  // Fallback: NIP-04 (kind 4)
  try {
    const nip04Res = await chrome.runtime.sendMessage({
      type: 'nip07:nip04:encrypt',
      payload: { pubkey: recipientPubkey, plaintext },
      id: createMessageId(),
    });
    if (nip04Res?.result) return { content: nip04Res.result, kind: 4 };
  } catch (err) {
    console.warn('NIP-04 encrypt via runtime failed:', err);
  }

  // window.nostr fallbacks
  const nostr = (window as any).nostr;
  if (typeof nostr?.nip44?.encrypt === 'function') {
    try {
      const encrypted = await nostr.nip44.encrypt(recipientPubkey, plaintext);
      return { content: encrypted, kind: 14 };
    } catch {}
  }
  if (typeof nostr?.nip04?.encrypt === 'function') {
    try {
      const encrypted = await nostr.nip04.encrypt(recipientPubkey, plaintext);
      return { content: encrypted, kind: 4 };
    } catch {}
  }

  // Local key fallback
  if (privateKey) {
    try {
      return { content: encryptNip44(privateKey, recipientPubkey, plaintext), kind: 14 };
    } catch {
      try {
        return { content: await encryptNip04(privateKey, recipientPubkey, plaintext), kind: 4 };
      } catch {}
    }
  }

  throw new Error('DM encryption failed — unlock your vault or install a Nostr signer');
}

/**
 * Decrypt a DM event. Handles NIP-17 gift wrap (1059), NIP-44 (kind 14), and NIP-04 (kind 4).
 * Prioritizes local key decryption (silent) over extension messaging (prompts user).
 */
export async function decryptDM(
  senderPubkey: string,
  content: string,
  kind: number,
  fullEvent?: { pubkey: string; content: string; kind: number; tags?: string[][] },
): Promise<string> {
  // NIP-17 gift wrap — unwrap the layers
  if (kind === 1059 && fullEvent) {
    const privateKey = await getSessionPrivateKey();
    if (privateKey) {
      const result = unwrapGiftWrap(privateKey, fullEvent);
      if (result) return result.rumor.content;
    }
    return '(unable to decrypt gift wrap)';
  }

  // Try local key first — this decrypts silently without prompting the user
  const privateKey = await getSessionPrivateKey();
  if (privateKey) {
    try {
      if (kind === 14) return decryptNip44(privateKey, senderPubkey, content);
      return await decryptNip04(privateKey, senderPubkey, content);
    } catch {
      // Local key failed — fall through to extension
    }
  }

  // Extension fallback (may prompt user) — only used when local key unavailable
  try {
    if (kind === 14) {
      const nip44Res = await chrome.runtime.sendMessage({
        type: 'nip07:nip44:decrypt',
        payload: { pubkey: senderPubkey, ciphertext: content },
        id: createMessageId(),
      });
      if (nip44Res?.result) return nip44Res.result;
    }

    const nip04Res = await chrome.runtime.sendMessage({
      type: 'nip07:nip04:decrypt',
      payload: { pubkey: senderPubkey, ciphertext: content },
      id: createMessageId(),
    });
    if (nip04Res?.result) return nip04Res.result;
  } catch (err) {
    console.warn('DM decrypt via runtime failed:', err);
  }

  // window.nostr fallbacks
  const nostr = (window as any).nostr;
  try {
    if (kind === 14 && typeof nostr?.nip44?.decrypt === 'function') {
      return await nostr.nip44.decrypt(senderPubkey, content);
    }
    if (typeof nostr?.nip04?.decrypt === 'function') {
      return await nostr.nip04.decrypt(senderPubkey, content);
    }
  } catch {}

  if (content.length < 500 && /\s/.test(content) && !content.includes('?iv=')) {
    return content;
  }

  return '(unable to decrypt)';
}

/**
 * Extract sender pubkey from a gift-wrapped event using our private key.
 */
export async function getGiftWrapSender(
  event: { pubkey: string; content: string; kind: number; tags?: string[][] },
): Promise<string | null> {
  const privateKey = await getSessionPrivateKey();
  if (!privateKey) return null;
  const result = unwrapGiftWrap(privateKey, event);
  return result?.senderPubkey ?? null;
}
