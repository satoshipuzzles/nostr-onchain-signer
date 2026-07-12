import { createMessageId } from '@/shared/messages';
import { encryptNip04, decryptNip04, decryptNip44 } from '@/lib/nostr/dm-crypto';
import { createGiftWrapPair, unwrapGiftWrap, type Rumor } from '@/lib/nostr/gift-wrap';
import { fetchDmInboxRelays, publishToRelays, DEFAULT_DM_RELAYS } from '@/lib/nostr/dm-relays';
import { getPublishRelays } from '@/lib/nostr/publish';

let cachedPrivateKey: string | null = null;

async function getSessionPrivateKey(): Promise<string | null> {
  // Return cached key if available (avoids repeated lookups)
  if (cachedPrivateKey) return cachedPrivateKey;

  // Try sessionStorage directly (works in PWA mode / extension popup)
  try {
    const raw = sessionStorage.getItem('nostr_onchain_session_keys');
    if (raw) {
      const session = JSON.parse(raw);
      const idxRaw = sessionStorage.getItem('nostr_onchain_active_index');
      const activeIdx = idxRaw ? JSON.parse(idxRaw) : 0;
      const privateKey = session[activeIdx]?.privateKeyHex;
      if (privateKey && privateKey.length === 64) {
        cachedPrivateKey = privateKey;
        return privateKey;
      }
    }
  } catch {}

  // Try chrome.storage.session (used by chrome-mock in PWA)
  try {
    const sessionData = await chrome.storage?.session?.get?.(['session_keys', 'active_index']);
    if (sessionData?.session_keys) {
      const keys = sessionData.session_keys as any[];
      const idx = (sessionData.active_index as number) ?? 0;
      const pk = keys[idx]?.privateKeyHex;
      if (pk && pk.length === 64) {
        cachedPrivateKey = pk;
        return pk;
      }
    }
  } catch {}

  // Try getting key via background (extension context)
  try {
    const res = await chrome.runtime.sendMessage({
      type: 'vault:getPrivateKey',
      id: createMessageId(),
    });
    if (res?.result && typeof res.result === 'string' && res.result.length === 64) {
      cachedPrivateKey = res.result;
      return res.result;
    }
  } catch {}

  return null;
}

// Clear cached key on account switch
export function clearDMKeyCache() {
  cachedPrivateKey = null;
}

/**
 * All valid private keys in the session, active account first. DMs (and
 * especially gift wraps) may be addressed to a non-active vault account —
 * decryption should try every key we hold.
 */
async function getAllSessionPrivateKeys(): Promise<string[]> {
  const keys: string[] = [];
  const push = (k: unknown) => {
    if (typeof k === 'string' && k.length === 64 && !keys.includes(k)) keys.push(k);
  };

  try {
    const raw = sessionStorage.getItem('nostr_onchain_session_keys');
    if (raw) {
      const session = JSON.parse(raw) as Array<{ privateKeyHex?: string }>;
      const idxRaw = sessionStorage.getItem('nostr_onchain_active_index');
      const activeIdx = idxRaw ? JSON.parse(idxRaw) : 0;
      push(session[activeIdx]?.privateKeyHex);
      for (const entry of session) push(entry?.privateKeyHex);
    }
  } catch {}

  try {
    const sessionData = await chrome.storage?.session?.get?.(['session_keys', 'active_index']);
    if (sessionData?.session_keys) {
      const session = sessionData.session_keys as Array<{ privateKeyHex?: string }>;
      const idx = (sessionData.active_index as number) ?? 0;
      push(session[idx]?.privateKeyHex);
      for (const entry of session) push(entry?.privateKeyHex);
    }
  } catch {}

  if (keys.length === 0) {
    const active = await getSessionPrivateKey();
    push(active);
  }
  return keys;
}

export interface GiftWrapDMResult {
  giftWrapEvent: object;
  recipientPubkey: string;
}

/**
 * Encrypt a DM. Prefers NIP-17 gift wrap (kind 1059); falls back to
 * NIP-04 (kind 4). NEVER returns kind 14 — signed kind 14 events violate
 * NIP-17 and are ignored by Amethyst/0xchat/other clients.
 */
export async function encryptDM(
  recipientPubkey: string,
  plaintext: string,
): Promise<{ content: string; kind: number; giftWrap?: object; selfGiftWrap?: object }> {
  const privateKey = await getSessionPrivateKey();

  // Preferred: NIP-17 gift wrap (kind 1059) — pair includes self-copy
  if (privateKey) {
    try {
      const { recipientWrap, selfWrap } = createGiftWrapPair(privateKey, recipientPubkey, plaintext);
      return { content: '', kind: 1059, giftWrap: recipientWrap, selfGiftWrap: selfWrap };
    } catch (err) {
      console.warn('Gift wrap creation failed, falling back:', err);
    }
  }

  // NIP-04 fallback with local key
  if (privateKey) {
    try {
      return { content: await encryptNip04(privateKey, recipientPubkey, plaintext), kind: 4 };
    } catch {}
  }

  // Extension runtime fallback (NIP-04 only — kind 14 must never be signed)
  try {
    const nip04Res = await chrome.runtime.sendMessage({
      type: 'nip07:nip04:encrypt',
      payload: { pubkey: recipientPubkey, plaintext },
      id: createMessageId(),
    });
    if (nip04Res?.result) return { content: nip04Res.result, kind: 4 };
  } catch {}

  // window.nostr fallback
  const nostr = (window as any).nostr;
  if (typeof nostr?.nip04?.encrypt === 'function') {
    try {
      return { content: await nostr.nip04.encrypt(recipientPubkey, plaintext), kind: 4 };
    } catch {}
  }

  throw new Error('DM encryption failed — unlock your vault or install a Nostr signer');
}

export interface SendDMResult {
  ok: boolean;
  kind: number;
  eventId?: string;
  relays: string[];
}

/**
 * Send a DM end-to-end: encrypt, resolve the recipient's DM inbox relays
 * (kind 10050), and publish to the right places.
 *
 * NIP-17 path: recipient's wrap → their inbox relays (+ shared defaults);
 * self wrap → our relays (so our sent messages sync).
 * NIP-04 path: signed kind 4 → our write relays + their inbox relays.
 */
export async function sendDM(
  senderPubkey: string,
  recipientPubkey: string,
  plaintext: string,
): Promise<SendDMResult> {
  const encrypted = await encryptDM(recipientPubkey, plaintext);

  const [recipientRelays, ourRelays] = await Promise.all([
    fetchDmInboxRelays(recipientPubkey),
    getPublishRelays(),
  ]);

  if (encrypted.kind === 1059 && encrypted.giftWrap) {
    // Recipient copy → THEIR inbox relays. This is what makes Amethyst
    // users actually receive the message.
    const recipientTargets = [...new Set([...recipientRelays, ...DEFAULT_DM_RELAYS])];
    const recipientResult = await publishToRelays(encrypted.giftWrap as any, recipientTargets);

    // Self copy → our relays (fire and forget, don't block the UI)
    if (encrypted.selfGiftWrap) {
      const selfTargets = [...new Set([...ourRelays, ...DEFAULT_DM_RELAYS])];
      publishToRelays(encrypted.selfGiftWrap as any, selfTargets).catch(() => {});
    }

    if (recipientResult.success.length === 0) {
      throw new Error('Could not reach any relay. Message not delivered.');
    }
    return {
      ok: true,
      kind: 1059,
      eventId: (encrypted.giftWrap as any).id,
      relays: recipientResult.success,
    };
  }

  // NIP-04 path — sign a kind 4 event and publish broadly
  const event = {
    kind: encrypted.kind,
    content: encrypted.content,
    tags: [['p', recipientPubkey]],
    created_at: Math.floor(Date.now() / 1000),
  };
  const { signEventWithFallback } = await import('@/lib/nostr/sign-event');
  const signed = await signEventWithFallback(event, senderPubkey);
  const targets = [...new Set([...ourRelays, ...recipientRelays])];
  const result = await publishToRelays(signed, targets);

  if (result.success.length === 0) {
    throw new Error('Could not reach any relay. Message not delivered.');
  }
  return { ok: true, kind: encrypted.kind, eventId: signed.id, relays: result.success };
}

/**
 * Decrypt a DM event. Prioritizes local key (silent) over extension messaging.
 */
export async function decryptDM(
  senderPubkey: string,
  content: string,
  kind: number,
  fullEvent?: { pubkey: string; content: string; kind: number; tags?: string[][] },
): Promise<string> {
  if (kind === 1059 && fullEvent) {
    // Gift wraps can be addressed to any of our vault accounts — try them all
    for (const privateKey of await getAllSessionPrivateKeys()) {
      const result = unwrapGiftWrap(privateKey, fullEvent);
      if (result) return result.rumor.content;
    }
    return '(unable to decrypt gift wrap)';
  }

  // Try every local key first (silent, no prompts). Some clients also put
  // NIP-44 ciphertext in kind 4, so try both algorithms per key.
  for (const privateKey of await getAllSessionPrivateKeys()) {
    try {
      if (kind === 14) return decryptNip44(privateKey, senderPubkey, content);
      return await decryptNip04(privateKey, senderPubkey, content);
    } catch {}
    try {
      if (kind === 4) return decryptNip44(privateKey, senderPubkey, content);
    } catch {}
  }

  // Extension fallback
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
  } catch {}

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
 * Extract sender pubkey from a gift-wrapped event.
 */
export async function getGiftWrapSender(
  event: { pubkey: string; content: string; kind: number; tags?: string[][] },
): Promise<string | null> {
  for (const privateKey of await getAllSessionPrivateKeys()) {
    const result = unwrapGiftWrap(privateKey, event);
    if (result) return result.senderPubkey;
  }
  return null;
}

/**
 * Fully unwrap a gift wrap in one pass: content + sender + REAL timestamp
 * (the rumor's created_at — the wrap's own timestamp is randomized).
 */
export async function unwrapGiftWrapEvent(
  event: { pubkey: string; content: string; kind: number; tags?: string[][] },
): Promise<{ content: string; senderPubkey: string; createdAt: number; rumor: Rumor } | null> {
  for (const privateKey of await getAllSessionPrivateKeys()) {
    const result = unwrapGiftWrap(privateKey, event);
    if (result) {
      return {
        content: result.rumor.content,
        senderPubkey: result.senderPubkey,
        createdAt: result.rumor.created_at,
        rumor: result.rumor,
      };
    }
  }
  return null;
}
