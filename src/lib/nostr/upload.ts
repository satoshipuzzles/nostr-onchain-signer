/**
 * NIP-98 HTTP Auth + nostr.build media upload.
 *
 * NIP-98 uses a signed Nostr event (kind 27235) as an HTTP Authorization
 * header to authenticate uploads. nostr.build accepts this for file uploads.
 *
 * Flow:
 * 1. User selects a file
 * 2. We create a kind 27235 event with the upload URL + method + SHA-256 of file
 * 3. Sign it
 * 4. Base64 encode the signed event
 * 5. Send as: Authorization: Nostr <base64_event>
 * 6. Get back the hosted URL
 */

import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';

const NOSTR_BUILD_UPLOAD_URL = 'https://nostr.build/api/v2/upload/files';

export interface UploadResult {
  url: string;
  thumbnail?: string;
  dimensions?: { width: number; height: number };
  mimeType: string;
  size: number;
  sha256: string;
}

export interface Nip98AuthEvent {
  kind: 27235;
  content: string;
  tags: string[][];
  created_at: number;
  pubkey: string;
}

/**
 * Create a NIP-98 auth event for a file upload.
 */
export function createNip98AuthEvent(
  url: string,
  method: string,
  fileHash: string,
  pubkey: string
): Nip98AuthEvent {
  return {
    kind: 27235,
    content: '',
    tags: [
      ['u', url],
      ['method', method.toUpperCase()],
      ['payload', fileHash],
    ],
    created_at: Math.floor(Date.now() / 1000),
    pubkey,
  };
}

/**
 * Compute SHA-256 hash of a file (as hex string).
 */
export async function hashFile(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const hash = sha256(new Uint8Array(buffer));
  return bytesToHex(hash);
}

/**
 * Upload a file to nostr.build using NIP-98 authentication.
 *
 * The caller must provide a signed event (since signing is handled
 * by the background service worker).
 */
export async function uploadToNostrBuild(
  file: File,
  signedAuthEvent: { id: string; pubkey: string; sig: string; kind: number; content: string; tags: string[][]; created_at: number }
): Promise<UploadResult> {
  // Base64 encode the signed event for the auth header
  const eventJson = JSON.stringify(signedAuthEvent);
  const base64Event = btoa(eventJson);

  const formData = new FormData();
  formData.append('file', file);

  const response = await fetch(NOSTR_BUILD_UPLOAD_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Nostr ${base64Event}`,
    },
    body: formData,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Upload failed (${response.status}): ${text}`);
  }

  const data = await response.json();

  if (!data.status || data.status !== 'success') {
    throw new Error(data.message || 'Upload failed');
  }

  const fileData = data.data?.[0];
  if (!fileData) {
    throw new Error('No file data in response');
  }

  return {
    url: fileData.url,
    thumbnail: fileData.thumbnail,
    dimensions: fileData.dimensions
      ? { width: fileData.dimensions.width, height: fileData.dimensions.height }
      : undefined,
    mimeType: fileData.mime || file.type,
    size: fileData.size || file.size,
    sha256: fileData.sha256 || '',
  };
}

/**
 * Helper: Upload a file with NIP-98 auth via the extension's background signer.
 * This is the main function popup UI should call.
 */
export async function uploadFile(
  file: File,
  publicKey: string
): Promise<UploadResult> {
  // 1. Hash the file
  const fileHash = await hashFile(file);

  // 2. Create NIP-98 auth event
  const authEvent = createNip98AuthEvent(
    NOSTR_BUILD_UPLOAD_URL,
    'POST',
    fileHash,
    publicKey
  );

  // 3. Sign via background
  const response = await chrome.runtime.sendMessage({
    type: 'nip07:signEvent',
    payload: { event: authEvent },
    id: `upload_${Date.now()}`,
  });

  if (response.error) {
    throw new Error(`Signing failed: ${response.error}`);
  }

  // 4. Upload with signed auth
  return uploadToNostrBuild(file, response.result);
}

/**
 * Validate file before upload.
 */
export function validateFile(file: File): { valid: boolean; error?: string } {
  const MAX_SIZE = 25 * 1024 * 1024; // 25MB
  const ALLOWED_TYPES = [
    'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml',
    'video/mp4', 'video/webm',
    'audio/mp3', 'audio/mpeg', 'audio/ogg',
  ];

  if (file.size > MAX_SIZE) {
    return { valid: false, error: `File too large (max ${MAX_SIZE / 1024 / 1024}MB)` };
  }

  if (!ALLOWED_TYPES.includes(file.type)) {
    return { valid: false, error: `Unsupported file type: ${file.type}` };
  }

  return { valid: true };
}
