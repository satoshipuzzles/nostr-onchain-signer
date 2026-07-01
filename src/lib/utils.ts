/**
 * Upgrade http:// image URLs to https:// to prevent mixed content errors
 * when the app is served over HTTPS (Vercel, etc).
 */
export function safeImageUrl(url: string | undefined | null): string | undefined {
  if (!url) return undefined;
  if (url.startsWith('http://')) {
    return url.replace('http://', 'https://');
  }
  return url;
}
