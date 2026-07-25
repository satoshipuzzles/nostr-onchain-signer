/**
 * Nostr side of the explorer: fetch + verify anchored events, profiles,
 * threads, reactions, zaps; NIP-07 login; publish comments/reactions/follows.
 */

import { SimplePool, nip19, type Event, type EventTemplate } from 'nostr-tools';
import { verifyOpReturnContent } from '@nostr-onchain/core';

export const RELAYS = [
  'wss://relay.damus.io',
  'wss://relay.primal.net',
  'wss://nos.lol',
  'wss://relay.nostr.band',
];

export const pool = new SimplePool();

type Nip07 = {
  getPublicKey(): Promise<string>;
  signEvent(event: EventTemplate): Promise<Event>;
};

function nip07(): Nip07 | null {
  const w = window as Window & { nostr?: Nip07 };
  return w.nostr && typeof w.nostr.signEvent === 'function' ? w.nostr : null;
}

export function hasNip07(): boolean {
  return nip07() !== null;
}

// ─── Login ───────────────────────────────────────────────────────

const LOGIN_KEY = 'nbc_login_pubkey';

export function getLogin(): string | null {
  return localStorage.getItem(LOGIN_KEY);
}

export async function login(): Promise<string> {
  const signer = nip07();
  if (!signer) throw new Error('No NIP-07 extension found — install Nostr Onchain Signer, Alby, or nos2x');
  const pubkey = await signer.getPublicKey();
  localStorage.setItem(LOGIN_KEY, pubkey);
  return pubkey;
}

export function logout(): void {
  localStorage.removeItem(LOGIN_KEY);
}

// ─── Profiles (memory + localStorage cache) ─────────────────────

export interface Profile {
  pubkey: string;
  npub: string;
  name: string;
  picture?: string;
  about?: string;
  nip05?: string;
  lud16?: string;
}

const profileCache = new Map<string, Profile>();
const PROFILE_LS_KEY = 'nbc_profiles_v1';

try {
  const stored = JSON.parse(localStorage.getItem(PROFILE_LS_KEY) ?? '{}');
  for (const [k, v] of Object.entries(stored)) profileCache.set(k, v as Profile);
} catch {
  // corrupt cache — start fresh
}

function persistProfiles() {
  try {
    const entries = [...profileCache.entries()].slice(-300);
    localStorage.setItem(PROFILE_LS_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // quota — skip
  }
}

function parseProfile(ev: Event): Profile {
  let meta: Record<string, unknown> = {};
  try {
    meta = JSON.parse(ev.content);
  } catch {
    // malformed kind-0
  }
  return {
    pubkey: ev.pubkey,
    npub: nip19.npubEncode(ev.pubkey),
    name: (meta.display_name as string) || (meta.name as string) || nip19.npubEncode(ev.pubkey).slice(0, 12),
    picture: meta.picture as string | undefined,
    about: meta.about as string | undefined,
    nip05: meta.nip05 as string | undefined,
    lud16: (meta.lud16 as string | undefined) ?? (meta.lud06 as string | undefined),
  };
}

export function fallbackProfile(pubkey: string): Profile {
  return { pubkey, npub: nip19.npubEncode(pubkey), name: nip19.npubEncode(pubkey).slice(0, 12) };
}

export async function fetchProfiles(pubkeys: string[]): Promise<Map<string, Profile>> {
  const missing = [...new Set(pubkeys)].filter((p) => !profileCache.has(p));
  if (missing.length > 0) {
    const events = await pool.querySync(RELAYS, { kinds: [0], authors: missing });
    const newest = new Map<string, Event>();
    for (const ev of events) {
      const cur = newest.get(ev.pubkey);
      if (!cur || ev.created_at > cur.created_at) newest.set(ev.pubkey, ev);
    }
    for (const ev of newest.values()) profileCache.set(ev.pubkey, parseProfile(ev));
    persistProfiles();
  }
  const out = new Map<string, Profile>();
  for (const p of pubkeys) out.set(p, profileCache.get(p) ?? fallbackProfile(p));
  return out;
}

export async function fetchProfile(pubkey: string): Promise<Profile> {
  return (await fetchProfiles([pubkey])).get(pubkey)!;
}

// ─── Anchored events ─────────────────────────────────────────────

export type VerificationStatus = 'verified' | 'found' | 'mismatch' | 'missing';

export interface AnchoredEvent {
  event: Event | null;
  status: VerificationStatus;
}

const eventCache = new Map<string, Event | null>();

export async function fetchEventById(id: string): Promise<Event | null> {
  if (eventCache.has(id)) return eventCache.get(id)!;
  const ev = await pool.get(RELAYS, { ids: [id] });
  eventCache.set(id, ev);
  return ev;
}

/**
 * Fetch the Nostr event referenced by an NSTR anchor and verify it against
 * the on-chain content hash when one is present.
 */
export async function resolveAnchoredEvent(eventId: string, scriptHex: string): Promise<AnchoredEvent> {
  const event = await fetchEventById(eventId);
  if (!event) return { event: null, status: 'missing' };
  // 61-byte scripts carry a 20-byte truncated SHA-256 of the content
  const hasHash = scriptHex.length / 2 >= 61;
  if (!hasHash) return { event, status: 'found' };
  return { event, status: verifyOpReturnContent(scriptHex, event.content) ? 'verified' : 'mismatch' };
}

// ─── Threads, reactions, zaps ────────────────────────────────────

export interface Interactions {
  replies: Event[];
  reactions: Event[];
  zapReceipts: Event[];
  zapTotalSats: number;
}

/** Parse sats out of a BOLT11 invoice amount prefix (lnbc<amount><multiplier>). */
export function bolt11Sats(invoice: string): number {
  const m = invoice.toLowerCase().match(/^ln(?:bc|tb)(\d+)([munp])?/);
  if (!m) return 0;
  const amount = parseInt(m[1], 10);
  const mult = m[2];
  const btc =
    mult === 'm' ? amount / 1e3 : mult === 'u' ? amount / 1e6 : mult === 'n' ? amount / 1e9 : mult === 'p' ? amount / 1e12 : amount;
  return Math.round(btc * 1e8);
}

export async function fetchInteractions(eventId: string): Promise<Interactions> {
  const events = await pool.querySync(RELAYS, { kinds: [1, 7, 9735], '#e': [eventId], limit: 300 });
  const replies = events.filter((e) => e.kind === 1).sort((a, b) => a.created_at - b.created_at);
  const reactions = events.filter((e) => e.kind === 7);
  const zapReceipts = events.filter((e) => e.kind === 9735);
  const zapTotalSats = zapReceipts.reduce((sum, z) => {
    const bolt11 = z.tags.find((t) => t[0] === 'bolt11')?.[1];
    return sum + (bolt11 ? bolt11Sats(bolt11) : 0);
  }, 0);
  return { replies, reactions, zapReceipts, zapTotalSats };
}

// ─── Publishing (NIP-07) ─────────────────────────────────────────

async function signAndPublish(template: EventTemplate): Promise<Event> {
  const signer = nip07();
  if (!signer) throw new Error('Login with a NIP-07 extension first');
  const signed = await signer.signEvent(template);
  await Promise.any(pool.publish(RELAYS, signed));
  return signed;
}

export async function publishReply(parent: Event, content: string): Promise<Event> {
  return signAndPublish({
    kind: 1,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['e', parent.id, '', 'root'],
      ['p', parent.pubkey],
    ],
    content,
  });
}

export async function publishReaction(target: Event, content = '+'): Promise<Event> {
  return signAndPublish({
    kind: 7,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['e', target.id],
      ['p', target.pubkey],
    ],
    content,
  });
}

export async function isFollowing(me: string, them: string): Promise<boolean> {
  const contacts = await pool.get(RELAYS, { kinds: [3], authors: [me] });
  return contacts?.tags.some((t) => t[0] === 'p' && t[1] === them) ?? false;
}

export async function followUser(me: string, them: string): Promise<void> {
  const contacts = await pool.get(RELAYS, { kinds: [3], authors: [me] });
  const tags = contacts?.tags?.filter((t) => t[0] === 'p') ?? [];
  if (tags.some((t) => t[1] === them)) return;
  await signAndPublish({
    kind: 3,
    created_at: Math.floor(Date.now() / 1000),
    tags: [...tags, ['p', them]],
    content: contacts?.content ?? '',
  });
}

// ─── Zaps (NIP-57) ───────────────────────────────────────────────

export interface ZapInvoiceResult {
  invoice: string;
  amountSats: number;
}

export async function requestZapInvoice(target: Event, authorLud16: string, amountSats: number): Promise<ZapInvoiceResult> {
  const [name, domain] = authorLud16.split('@');
  if (!name || !domain) throw new Error('Author has no valid lightning address (lud16)');

  const lnurlRes = await fetch(`https://${domain}/.well-known/lnurlp/${name}`);
  if (!lnurlRes.ok) throw new Error('Lightning address endpoint unreachable');
  const lnurl = await lnurlRes.json();
  if (!lnurl.callback) throw new Error('Invalid LNURL-pay response');

  const amountMsats = amountSats * 1000;
  let nostrParam = '';
  if (lnurl.allowsNostr && nip07()) {
    const zapRequest = await nip07()!.signEvent({
      kind: 9734,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ['p', target.pubkey],
        ['e', target.id],
        ['amount', String(amountMsats)],
        ['relays', ...RELAYS],
      ],
      content: '',
    });
    nostrParam = `&nostr=${encodeURIComponent(JSON.stringify(zapRequest))}`;
  }

  const sep = lnurl.callback.includes('?') ? '&' : '?';
  const invoiceRes = await fetch(`${lnurl.callback}${sep}amount=${amountMsats}${nostrParam}`);
  if (!invoiceRes.ok) throw new Error('Failed to fetch invoice');
  const invoiceJson = await invoiceRes.json();
  if (!invoiceJson.pr) throw new Error(invoiceJson.reason || 'No invoice returned');
  return { invoice: invoiceJson.pr, amountSats };
}

export async function payWithWebLn(invoice: string): Promise<boolean> {
  const w = window as Window & { webln?: { enable(): Promise<void>; sendPayment(pr: string): Promise<unknown> } };
  if (!w.webln) return false;
  await w.webln.enable();
  await w.webln.sendPayment(invoice);
  return true;
}

// ─── Helpers ─────────────────────────────────────────────────────

export function parsePubkeyInput(input: string): string | null {
  const trimmed = input.trim();
  if (/^[0-9a-f]{64}$/i.test(trimmed)) return trimmed.toLowerCase();
  try {
    const decoded = nip19.decode(trimmed);
    if (decoded.type === 'npub') return decoded.data;
    if (decoded.type === 'nprofile') return decoded.data.pubkey;
  } catch {
    // not bech32
  }
  return null;
}

export function parseEventIdInput(input: string): string | null {
  const trimmed = input.trim();
  try {
    const decoded = nip19.decode(trimmed);
    if (decoded.type === 'note') return decoded.data;
    if (decoded.type === 'nevent') return decoded.data.id;
  } catch {
    // not bech32
  }
  return null;
}

export function timeAgo(unixSeconds: number): string {
  const diff = Math.floor(Date.now() / 1000) - unixSeconds;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  if (diff < 2592000) return `${Math.floor(diff / 86400)}d`;
  return new Date(unixSeconds * 1000).toLocaleDateString();
}
