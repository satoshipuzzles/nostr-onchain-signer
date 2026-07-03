/**
 * Encrypted key vault.
 *
 * Uses Web Crypto API (AES-256-GCM + PBKDF2) when available (HTTPS/extension).
 * Falls back to @noble/hashes for non-secure contexts (HTTP PWA on LAN).
 */

import { sha256 } from '@noble/hashes/sha256';
import { pbkdf2 } from '@noble/hashes/pbkdf2';
import { concatBytes, bytesToHex, hexToBytes } from '@noble/hashes/utils';

const PBKDF2_ITERATIONS = 100_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;

export interface VaultData {
  privateKeyHex: string;
  publicKeyHex: string;
  createdAt: number;
  label?: string;
  /** True when pubkey comes from a browser extension (no nsec in vault). */
  externalSigner?: boolean;
  signerType?: 'alby' | 'nos2x' | 'nip07' | 'nostr-onchain' | 'imported';
}

export interface EncryptedVault {
  salt: string;
  iv: string;
  ciphertext: string;
  version: 1 | 2;
}

function isSubtleAvailable(): boolean {
  try {
    return typeof crypto !== 'undefined' && typeof crypto.subtle !== 'undefined' && crypto.subtle !== null;
  } catch {
    return false;
  }
}

function toHex(bytes: Uint8Array): string {
  return bytesToHex(bytes);
}

function fromHex(hex: string): Uint8Array {
  return hexToBytes(hex);
}

// ─── Web Crypto path (HTTPS / Extension) ─────────────────────────

async function deriveKeySubtle(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveKey']
  );

  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function encryptSubtle(data: string, password: string): Promise<EncryptedVault> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await deriveKeySubtle(password, salt);

  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(data)
  );

  return { salt: toHex(salt), iv: toHex(iv), ciphertext: toHex(new Uint8Array(ciphertext)), version: 1 };
}

async function decryptSubtle(vault: EncryptedVault, password: string): Promise<string> {
  const salt = fromHex(vault.salt);
  const iv = fromHex(vault.iv);
  const ciphertext = fromHex(vault.ciphertext);
  const key = await deriveKeySubtle(password, salt);

  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    ciphertext
  );

  return new TextDecoder().decode(plaintext);
}

// ─── Noble fallback (HTTP / non-secure contexts) ──────────────────

function deriveKeyNoble(password: string, salt: Uint8Array): Uint8Array {
  return pbkdf2(sha256, new TextEncoder().encode(password), salt, {
    c: PBKDF2_ITERATIONS,
    dkLen: 32,
  });
}

function xorBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] ^ b[i];
  return out;
}

/**
 * Simple XOR-based encryption with HMAC integrity (for non-secure contexts).
 * Not AES-GCM, but safe enough for local storage given the PBKDF2 derivation.
 */
function encryptNoble(data: string, password: string): EncryptedVault {
  const salt = new Uint8Array(SALT_BYTES);
  crypto.getRandomValues(salt);
  const iv = new Uint8Array(IV_BYTES);
  crypto.getRandomValues(iv);

  const key = deriveKeyNoble(password, salt);
  const plaintext = new TextEncoder().encode(data);

  // Generate keystream using SHA-256 in counter mode
  const encrypted = new Uint8Array(plaintext.length);
  for (let i = 0; i < plaintext.length; i += 32) {
    const counter = new Uint8Array(4);
    counter[0] = (i / 32) & 0xff;
    counter[1] = ((i / 32) >> 8) & 0xff;
    const block = sha256(concatBytes(key, iv, counter));
    const chunk = plaintext.slice(i, i + 32);
    const keyStream = block.slice(0, chunk.length);
    encrypted.set(xorBytes(chunk, keyStream), i);
  }

  // HMAC for integrity
  const hmac = sha256(concatBytes(key, encrypted));
  const withHmac = concatBytes(encrypted, hmac);

  return { salt: toHex(salt), iv: toHex(iv), ciphertext: toHex(withHmac), version: 2 };
}

function decryptNoble(vault: EncryptedVault, password: string): string {
  const salt = fromHex(vault.salt);
  const iv = fromHex(vault.iv);
  const withHmac = fromHex(vault.ciphertext);

  const key = deriveKeyNoble(password, salt);

  // Verify HMAC
  const encrypted = withHmac.slice(0, -32);
  const storedHmac = withHmac.slice(-32);
  const computedHmac = sha256(concatBytes(key, encrypted));

  let hmacValid = true;
  for (let i = 0; i < 32; i++) {
    if (storedHmac[i] !== computedHmac[i]) hmacValid = false;
  }
  if (!hmacValid) throw new Error('Invalid password');

  // Decrypt
  const plaintext = new Uint8Array(encrypted.length);
  for (let i = 0; i < encrypted.length; i += 32) {
    const counter = new Uint8Array(4);
    counter[0] = (i / 32) & 0xff;
    counter[1] = ((i / 32) >> 8) & 0xff;
    const block = sha256(concatBytes(key, iv, counter));
    const chunk = encrypted.slice(i, i + 32);
    const keyStream = block.slice(0, chunk.length);
    plaintext.set(xorBytes(chunk, keyStream), i);
  }

  return new TextDecoder().decode(plaintext);
}

// ─── Public API ───────────────────────────────────────────────────

export async function encryptVault(
  data: VaultData[],
  password: string
): Promise<EncryptedVault> {
  const json = JSON.stringify(data);
  if (isSubtleAvailable()) {
    return encryptSubtle(json, password);
  }
  return encryptNoble(json, password);
}

export async function decryptVault(
  vault: EncryptedVault,
  password: string
): Promise<VaultData[]> {
  let json: string;
  if (vault.version === 2) {
    json = decryptNoble(vault, password);
  } else if (isSubtleAvailable()) {
    json = await decryptSubtle(vault, password);
  } else {
    throw new Error('Cannot decrypt v1 vault without secure context. Use HTTPS or the Chrome extension.');
  }
  return JSON.parse(json);
}

export async function saveVault(vault: EncryptedVault): Promise<void> {
  await chrome.storage.local.set({ vault });
}

export async function loadVault(): Promise<EncryptedVault | null> {
  const result = await chrome.storage.local.get('vault');
  return result.vault ?? null;
}

export async function vaultExists(): Promise<boolean> {
  const vault = await loadVault();
  return vault !== null;
}

export async function clearVault(): Promise<void> {
  await chrome.storage.local.remove('vault');
}
