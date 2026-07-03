import { CUSTOM_KIND } from './kinds';

// ─── Types ──────────────────────────────────────────────────────

export type ContentType = 'text' | 'image' | 'link';

export interface SocialUnlockContent {
  title: string;
  description?: string;
  encrypted_content: string;
  content_type: ContentType;
  threshold: number;
  total_slots: number;
  allowed_pubkeys?: string[];
  created_at: number;
}

export interface SocialUnlockSignContent {
  unlock_event_id: string;
  message?: string;
}

export interface SocialUnlockRevealContent {
  unlock_event_id: string;
  decryption_key: string;
  revealed_at: number;
}

// ─── AES-256-GCM Encryption ────────────────────────────────────

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function encryptContent(
  plaintext: string,
  key?: string
): Promise<{ encrypted: string; key: string }> {
  let keyBytes: Uint8Array;
  if (key) {
    keyBytes = hexToBytes(key);
  } else {
    keyBytes = crypto.getRandomValues(new Uint8Array(32));
  }

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoder = new TextEncoder();
  const data = encoder.encode(plaintext);

  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'AES-GCM' },
    false,
    ['encrypt']
  );

  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    cryptoKey,
    data
  );

  // Format: iv (12 bytes) + ciphertext (includes 16-byte auth tag)
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), iv.length);

  return {
    encrypted: bytesToHex(combined),
    key: bytesToHex(keyBytes),
  };
}

export async function decryptContent(encrypted: string, key: string): Promise<string> {
  const combined = hexToBytes(encrypted);
  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);

  const keyBytes = hexToBytes(key);
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'AES-GCM' },
    false,
    ['decrypt']
  );

  const plainBuffer = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    cryptoKey,
    ciphertext
  );

  const decoder = new TextDecoder();
  return decoder.decode(plainBuffer);
}

// ─── Event Builders ─────────────────────────────────────────────

export interface CreateSocialUnlockParams {
  title: string;
  description?: string;
  plaintext: string;
  content_type: ContentType;
  threshold: number;
  total_slots: number;
  allowed_pubkeys?: string[];
  myPubkey: string;
}

export async function createSocialUnlockEvent(params: CreateSocialUnlockParams) {
  const { encrypted, key } = await encryptContent(params.plaintext);

  const content: SocialUnlockContent = {
    title: params.title,
    description: params.description,
    encrypted_content: encrypted,
    content_type: params.content_type,
    threshold: params.threshold,
    total_slots: params.total_slots,
    allowed_pubkeys: params.allowed_pubkeys,
    created_at: Math.floor(Date.now() / 1000),
  };

  const tags: string[][] = [
    ['t', 'social-unlock'],
    ['threshold', params.threshold.toString()],
    ['slots', params.total_slots.toString()],
  ];

  const event = {
    kind: CUSTOM_KIND.SOCIAL_UNLOCK,
    content: JSON.stringify(content),
    tags,
    created_at: Math.floor(Date.now() / 1000),
    pubkey: params.myPubkey,
  };

  return { event, decryptionKey: key };
}

export interface CreateUnlockSignParams {
  unlock_event_id: string;
  creator_pubkey: string;
  message?: string;
  myPubkey: string;
}

export function createUnlockSignEvent(params: CreateUnlockSignParams) {
  const content: SocialUnlockSignContent = {
    unlock_event_id: params.unlock_event_id,
    message: params.message,
  };

  return {
    kind: CUSTOM_KIND.SOCIAL_UNLOCK_SIGN,
    content: JSON.stringify(content),
    tags: [
      ['e', params.unlock_event_id],
      ['p', params.creator_pubkey],
    ],
    created_at: Math.floor(Date.now() / 1000),
    pubkey: params.myPubkey,
  };
}

export interface CreateRevealParams {
  unlock_event_id: string;
  decryption_key: string;
  myPubkey: string;
}

export function createRevealEvent(params: CreateRevealParams) {
  const content: SocialUnlockRevealContent = {
    unlock_event_id: params.unlock_event_id,
    decryption_key: params.decryption_key,
    revealed_at: Math.floor(Date.now() / 1000),
  };

  return {
    kind: CUSTOM_KIND.SOCIAL_UNLOCK_REVEAL,
    content: JSON.stringify(content),
    tags: [
      ['e', params.unlock_event_id],
      ['t', 'social-unlock-reveal'],
    ],
    created_at: Math.floor(Date.now() / 1000),
    pubkey: params.myPubkey,
  };
}

// ─── Helpers ────────────────────────────────────────────────────

export function parseSocialUnlockContent(content: string): SocialUnlockContent | null {
  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}

export function parseSocialUnlockSignContent(content: string): SocialUnlockSignContent | null {
  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}

export function parseSocialUnlockRevealContent(content: string): SocialUnlockRevealContent | null {
  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}
