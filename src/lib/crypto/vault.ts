/**
 * Encrypted key vault using AES-256-GCM with PBKDF2 key derivation.
 * Keys are stored in chrome.storage.local encrypted with the user's password.
 */

const PBKDF2_ITERATIONS = 600_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;

export interface VaultData {
  privateKeyHex: string;
  publicKeyHex: string;
  createdAt: number;
  label?: string;
}

export interface EncryptedVault {
  salt: string;
  iv: string;
  ciphertext: string;
  version: 1;
}

async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveKey']
  );

  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function fromHex(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

export async function encryptVault(
  data: VaultData[],
  password: string
): Promise<EncryptedVault> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await deriveKey(password, salt);

  const encoder = new TextEncoder();
  const plaintext = encoder.encode(JSON.stringify(data));

  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    plaintext
  );

  return {
    salt: toHex(salt),
    iv: toHex(iv),
    ciphertext: toHex(new Uint8Array(ciphertext)),
    version: 1,
  };
}

export async function decryptVault(
  vault: EncryptedVault,
  password: string
): Promise<VaultData[]> {
  const salt = fromHex(vault.salt);
  const iv = fromHex(vault.iv);
  const ciphertext = fromHex(vault.ciphertext);
  const key = await deriveKey(password, salt);

  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    ciphertext
  );

  const decoder = new TextDecoder();
  return JSON.parse(decoder.decode(plaintext));
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
