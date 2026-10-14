/**
 * Upgrade http:// image URLs to https:// to prevent mixed content errors
 * when the app is served over HTTPS (Vercel, etc).
 */
/**
 * A link target from untrusted data (profiles, notes, unlocked content).
 * Only http(s) — React does not block `javascript:` hrefs, and on the web app
 * a script running in our origin could reach the user's keys.
 */
export function safeHttpUrl(url: string | undefined | null): string | undefined {
  if (!url) return undefined;
  const trimmed = url.trim();
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : undefined;
  } catch {
    return undefined;
  }
}

export function safeImageUrl(url: string | undefined | null): string | undefined {
  if (!url) return undefined;
  if (url.startsWith('http://')) {
    return url.replace('http://', 'https://');
  }
  return url;
}
