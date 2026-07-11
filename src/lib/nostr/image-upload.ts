/**
 * Image upload to nostr.build with NIP-98 auth.
 *
 * nostr.build requires a NIP-98 token (signed kind 27235 event in the
 * Authorization header) for all uploads. The signature is obtained from
 * the vault / NIP-07 signer automatically — callers just pass the file.
 */

import { createNip98AuthEvent, hashFile } from './upload';
import { createMessageId } from '@/shared/messages';

const NOSTR_BUILD_UPLOAD_URL = 'https://nostr.build/api/v2/upload/files';

async function getSignedAuthHeader(file: File): Promise<string | null> {
  try {
    // Resolve our pubkey from the vault / signer
    const pkResp = await chrome.runtime.sendMessage({
      type: 'nip07:getPublicKey',
      id: createMessageId(),
    });
    const pubkey = pkResp?.result;
    if (!pubkey || typeof pubkey !== 'string') return null;

    const fileHash = await hashFile(file);
    const authEvent = createNip98AuthEvent(NOSTR_BUILD_UPLOAD_URL, 'POST', fileHash, pubkey);

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

export async function uploadImageToNostrBuild(file: File): Promise<string> {
  const formData = new FormData();
  formData.append('file', file);

  const authHeader = await getSignedAuthHeader(file);
  if (!authHeader) {
    throw new Error('Upload requires signing — unlock your vault and try again');
  }

  let res: Response;
  try {
    res = await fetch(NOSTR_BUILD_UPLOAD_URL, {
      method: 'POST',
      headers: { Authorization: authHeader },
      body: formData,
    });
  } catch (err) {
    throw new Error(
      `Network error: ${err instanceof Error ? err.message : 'could not connect to nostr.build'}`,
    );
  }

  if (!res.ok) {
    let detail = '';
    try {
      const text = await res.text();
      if (text) detail = `: ${text.slice(0, 200)}`;
    } catch { /* ignore */ }
    throw new Error(`Upload failed (HTTP ${res.status})${detail}`);
  }

  let data: Record<string, unknown>;
  try {
    data = await res.json();
  } catch {
    throw new Error('Invalid response from nostr.build');
  }

  const nested = data?.data as Array<{ url?: string }> | undefined;
  const url = nested?.[0]?.url || (data?.url as string | undefined);

  if (!url || typeof url !== 'string') {
    throw new Error('No image URL in upload response');
  }

  return url;
}
