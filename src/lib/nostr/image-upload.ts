/**
 * Image upload with NIP-98 auth and multi-server fallback.
 *
 * Order: nostr.build → nostrcheck.me (NIP-96) → nostr.download (NIP-96).
 * Each server gets its own NIP-98 token (the signed event is bound to the
 * exact upload URL), so a failure on one server falls through to the next.
 */

import { createNip98AuthEvent, hashFile } from './upload';
import { createMessageId } from '@/shared/messages';

const UPLOAD_SERVERS: Array<{ name: string; url: string; kind: 'nostrbuild' | 'nip96' }> = [
  { name: 'nostr.build', url: 'https://nostr.build/api/v2/upload/files', kind: 'nostrbuild' },
  { name: 'nostrcheck.me', url: 'https://nostrcheck.me/api/v2/media', kind: 'nip96' },
  { name: 'nostr.download', url: 'https://nostr.download/api/v2/media', kind: 'nip96' },
];

async function signAuthHeader(uploadUrl: string, fileHash: string): Promise<string | null> {
  try {
    const pkResp = await chrome.runtime.sendMessage({
      type: 'nip07:getPublicKey',
      id: createMessageId(),
    });
    const pubkey = pkResp?.result;
    if (!pubkey || typeof pubkey !== 'string') return null;

    const authEvent = createNip98AuthEvent(uploadUrl, 'POST', fileHash, pubkey);
    const signResp = await chrome.runtime.sendMessage({
      type: 'nip07:signEvent',
      payload: { event: authEvent },
      id: createMessageId(),
    });
    if (signResp?.error || !signResp?.result) return null;

    return `Nostr ${btoa(JSON.stringify(signResp.result))}`;
  } catch {
    return null;
  }
}

function extractUrl(data: Record<string, unknown>): string | null {
  // nostr.build v2 format: { data: [{ url }] }
  const nested = data?.data as Array<{ url?: string }> | undefined;
  if (nested?.[0]?.url) return nested[0].url;
  // Flat url
  if (typeof data?.url === 'string') return data.url;
  // NIP-96 format: { nip94_event: { tags: [["url", "..."]] } }
  const nip94 = data?.nip94_event as { tags?: string[][] } | undefined;
  const urlTag = nip94?.tags?.find((t) => t[0] === 'url');
  if (urlTag?.[1]) return urlTag[1];
  return null;
}

async function uploadToServer(
  server: { name: string; url: string; kind: string },
  file: File,
  fileHash: string,
): Promise<string> {
  const authHeader = await signAuthHeader(server.url, fileHash);
  if (!authHeader) {
    throw new Error('Upload requires signing — unlock your vault and try again');
  }

  const formData = new FormData();
  formData.append('file', file);

  const res = await fetch(server.url, {
    method: 'POST',
    headers: { Authorization: authHeader },
    body: formData,
  });

  if (!res.ok) {
    let detail = '';
    try {
      const text = await res.text();
      if (text) detail = `: ${text.slice(0, 200)}`;
    } catch { /* ignore */ }
    throw new Error(`${server.name} upload failed (HTTP ${res.status})${detail}`);
  }

  let data: Record<string, unknown>;
  try {
    data = await res.json();
  } catch {
    throw new Error(`Invalid response from ${server.name}`);
  }

  const url = extractUrl(data);
  if (!url) throw new Error(`No image URL in ${server.name} response`);
  return url;
}

/**
 * Upload an image, trying each server in order until one succeeds.
 */
export async function uploadImageToNostrBuild(file: File): Promise<string> {
  const fileHash = await hashFile(file);
  let lastError: Error | null = null;

  for (const server of UPLOAD_SERVERS) {
    try {
      return await uploadToServer(server, file, fileHash);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      // Signing failures won't fix themselves on another server
      if (lastError.message.includes('unlock your vault')) throw lastError;
      console.warn(`Upload to ${server.name} failed, trying next:`, lastError.message);
    }
  }

  throw lastError ?? new Error('All upload servers failed');
}
