/**
 * Simple image upload to nostr.build without NIP-98 auth.
 * For basic uploads that don't require authentication.
 */

const NOSTR_BUILD_UPLOAD_URL = 'https://nostr.build/api/v2/upload/files';

export async function uploadImageToNostrBuild(file: File): Promise<string> {
  const formData = new FormData();
  formData.append('file', file);

  const res = await fetch(NOSTR_BUILD_UPLOAD_URL, {
    method: 'POST',
    body: formData,
  });

  if (!res.ok) throw new Error('Upload failed');

  const data = await res.json();
  return data.data?.[0]?.url || data.url;
}
