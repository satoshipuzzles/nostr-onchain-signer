import { npubToPubkey, isValidHexPubkey } from '@/lib/nostr/keys';
import { resolveNip05 } from '@/lib/nostr/nip05';
import type { ProfileMetadata } from '@/lib/nostr/social';

export interface MentionSearchResult {
  pubkey: string;
  displayName?: string;
  picture?: string;
  nip05?: string;
}

export async function searchMentions(
  query: string,
  publicKey: string,
): Promise<MentionSearchResult[]> {
  if (!query.trim()) return [];

  const results: MentionSearchResult[] = [];
  const seen = new Set<string>();

  try {
    if (query.startsWith('npub1')) {
      try {
        const pk = npubToPubkey(query);
        if (!seen.has(pk)) {
          seen.add(pk);
          results.push({ pubkey: pk });
        }
      } catch { /* invalid npub */ }
    } else if (isValidHexPubkey(query)) {
      const pk = query.toLowerCase();
      if (!seen.has(pk)) {
        seen.add(pk);
        results.push({ pubkey: pk });
      }
    }

    if (query.includes('@') || (query.includes('.') && !query.startsWith('npub'))) {
      const nip05Result = await resolveNip05(query.includes('@') ? query : `_@${query}`);
      if (nip05Result && !seen.has(nip05Result.pubkey)) {
        seen.add(nip05Result.pubkey);
        results.push({ pubkey: nip05Result.pubkey, nip05: query });
      }
    }

    const followingStored = await chrome.storage.local.get(`following_${publicKey}`);
    const followingList: string[] = followingStored[`following_${publicKey}`] ?? [];
    const profileKeys = followingList.map((pk) => `profile_${pk}`);
    const batchSize = 50;

    for (let i = 0; i < profileKeys.length; i += batchSize) {
      const batch = profileKeys.slice(i, i + batchSize);
      const cached = await chrome.storage.local.get(batch);

      for (const key of batch) {
        const profile = cached[key] as ProfileMetadata | undefined;
        if (!profile) continue;

        const pk = profile.pubkey;
        if (seen.has(pk)) continue;

        const lowerQuery = query.toLowerCase();
        const matchesName =
          profile.name?.toLowerCase().includes(lowerQuery) ||
          profile.displayName?.toLowerCase().includes(lowerQuery);
        const matchesNip05 = profile.nip05?.toLowerCase().includes(lowerQuery);
        const matchesPubkey = pk.startsWith(lowerQuery);

        if (matchesName || matchesNip05 || matchesPubkey) {
          seen.add(pk);
          results.push({
            pubkey: pk,
            displayName: profile.displayName || profile.name,
            picture: profile.picture,
            nip05: profile.nip05,
          });
        }
      }
    }

    const cacheResult = await chrome.storage.local.get('profile_cache_v2');
    const profileCache = cacheResult['profile_cache_v2'];
    if (profileCache?.profiles) {
      const lowerQuery = query.toLowerCase();
      for (const [pk, entry] of Object.entries(profileCache.profiles) as [string, { profile: ProfileMetadata }][]) {
        if (seen.has(pk)) continue;
        const p = entry.profile;
        const matchesName =
          p.name?.toLowerCase().includes(lowerQuery) ||
          p.displayName?.toLowerCase().includes(lowerQuery);
        const matchesNip05 = p.nip05?.toLowerCase().includes(lowerQuery);
        if (matchesName || matchesNip05) {
          seen.add(pk);
          results.push({
            pubkey: pk,
            displayName: p.displayName || p.name,
            picture: p.picture,
            nip05: p.nip05,
          });
        }
        if (results.length >= 8) break;
      }
    }
  } catch {
    // Search failed silently
  }

  return results.slice(0, 8);
}

export function mentionLabel(result: MentionSearchResult): string {
  return result.displayName || result.nip05 || `${result.pubkey.slice(0, 8)}…`;
}
