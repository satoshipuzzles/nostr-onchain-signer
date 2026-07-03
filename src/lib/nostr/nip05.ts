/**
 * NIP-05 identifier resolution.
 * Resolves user@domain.com to a hex pubkey via .well-known/nostr.json.
 */

export interface Nip05Result {
  pubkey: string;
  relays?: string[];
}

export async function resolveNip05(identifier: string): Promise<Nip05Result | null> {
  const [name, domain] = identifier.split('@');
  if (!name || !domain) return null;

  try {
    const res = await fetch(
      `https://${domain}/.well-known/nostr.json?name=${encodeURIComponent(name)}`
    );
    if (!res.ok) return null;
    const json = await res.json();
    const pubkey = json.names?.[name];
    if (!pubkey || typeof pubkey !== 'string') return null;
    const relays = json.relays?.[pubkey];
    return { pubkey, relays };
  } catch {
    return null;
  }
}
