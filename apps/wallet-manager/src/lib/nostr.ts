/**
 * Nostr integration: profile lookup, people search, and profile publishing
 * (used to advertise a silent payment address). Read paths work logged-out;
 * publishing signs with a vault key.
 */

import { SimplePool, nip19, finalizeEvent, type Event } from 'nostr-tools';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils';
import { pubkeyToTaprootAddress } from '@nostr-onchain/core';
import { loadSettings } from './storage';
import type { Contact } from './storage';

const pool = new SimplePool();
const SEARCH_RELAYS = ['wss://relay.nostr.band'];

export interface NostrProfile {
  pubkeyHex: string;
  npub: string;
  name: string;
  about?: string;
  picture?: string;
  nip05?: string;
  silentPaymentAddress?: string;
  lud16?: string;
}

function parseProfileEvent(ev: Event): NostrProfile {
  let meta: Record<string, unknown> = {};
  try {
    meta = JSON.parse(ev.content);
  } catch {
    // malformed profile content
  }
  const sp = (meta.silent_payment_address ?? meta.sp_address) as string | undefined;
  return {
    pubkeyHex: ev.pubkey,
    npub: nip19.npubEncode(ev.pubkey),
    name: (meta.display_name as string) || (meta.name as string) || nip19.npubEncode(ev.pubkey).slice(0, 12),
    about: meta.about as string | undefined,
    picture: meta.picture as string | undefined,
    nip05: meta.nip05 as string | undefined,
    silentPaymentAddress: typeof sp === 'string' && /^(sp|tsp)1/.test(sp) ? sp : undefined,
    lud16: meta.lud16 as string | undefined,
  };
}

/** Accepts npub / nprofile / hex and returns the hex pubkey, or null. */
export function parsePubkeyInput(input: string): string | null {
  const trimmed = input.trim();
  if (/^[0-9a-f]{64}$/i.test(trimmed)) return trimmed.toLowerCase();
  try {
    const decoded = nip19.decode(trimmed);
    if (decoded.type === 'npub') return decoded.data;
    if (decoded.type === 'nprofile') return decoded.data.pubkey;
  } catch {
    // not a bech32 nostr entity
  }
  return null;
}

export async function fetchProfile(pubkeyHex: string): Promise<NostrProfile | null> {
  const relays = loadSettings().relays;
  const ev = await pool.get(relays, { kinds: [0], authors: [pubkeyHex] });
  return ev ? parseProfileEvent(ev) : null;
}

/** NIP-50 search on relay.nostr.band, falling back to direct npub parsing. */
export async function searchPeople(query: string): Promise<NostrProfile[]> {
  const direct = parsePubkeyInput(query);
  if (direct) {
    const profile = await fetchProfile(direct);
    return profile
      ? [profile]
      : [{ pubkeyHex: direct, npub: nip19.npubEncode(direct), name: nip19.npubEncode(direct).slice(0, 16) }];
  }
  const events = await pool.querySync(SEARCH_RELAYS, {
    kinds: [0],
    search: query,
    limit: 12,
  } as Parameters<typeof pool.querySync>[1]);
  const seen = new Set<string>();
  const out: NostrProfile[] = [];
  for (const ev of events) {
    if (seen.has(ev.pubkey)) continue;
    seen.add(ev.pubkey);
    out.push(parseProfileEvent(ev));
  }
  return out;
}

export function profileToContact(p: NostrProfile, network: 'mainnet' | 'testnet' = 'mainnet'): Contact {
  return {
    pubkeyHex: p.pubkeyHex,
    npub: p.npub,
    name: p.name,
    picture: p.picture,
    nip05: p.nip05,
    silentPaymentAddress: p.silentPaymentAddress,
    taprootAddress: pubkeyToTaprootAddress(p.pubkeyHex, network),
    addedAt: Date.now(),
  };
}

/**
 * Publish (merge) fields into the user's kind-0 profile — used to advertise
 * the wallet's silent payment address.
 */
export async function publishProfileFields(
  privateKeyHex: string,
  fields: Record<string, string>
): Promise<void> {
  const relays = loadSettings().relays;
  const sk = hexToBytes(privateKeyHex);
  const { schnorr } = await import('@noble/curves/secp256k1');
  const pubkey = bytesToHex(schnorr.getPublicKey(sk));

  const existing = await pool.get(relays, { kinds: [0], authors: [pubkey] });
  let content: Record<string, unknown> = {};
  if (existing) {
    try {
      content = JSON.parse(existing.content);
    } catch {
      // start fresh if profile is malformed
    }
  }
  const merged = { ...content, ...fields };
  const event = finalizeEvent(
    {
      kind: 0,
      created_at: Math.floor(Date.now() / 1000),
      tags: [],
      content: JSON.stringify(merged),
    },
    sk
  );
  await Promise.any(pool.publish(relays, event));
}
