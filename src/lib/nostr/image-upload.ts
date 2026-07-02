/**
 * Simple image upload to nostr.build without NIP-98 auth.
 * For basic uploads that don't require authentication.
 */

const NOSTR_BUILD_UPLOAD_URL = 'https://nostr.build/api/v2/upload/files';

export async function uploadImageToNostrBuild(file: File): Promise<string> {
  const formData = new FormData();
  formData.append('file', file);

  let res: Response;
  try {
    res = await fetch(NOSTR_BUILD_UPLOAD_URL, {
      method: 'POST',
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
