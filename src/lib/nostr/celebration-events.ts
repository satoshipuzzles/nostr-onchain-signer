/**
 * Shared celebrations on Nostr: an addressable event (kind 31616) that points at the
 * animation's file, so anyone can add it to their own celebrations from the store.
 *
 *   kind 31616, content: a short description
 *   ["d", <slug>]               which of the author's celebrations this is (re-publishing replaces it)
 *   ["title", <name>]
 *   ["url", <https file url>]   the image or video, uploaded through NIP-96 / nostr.build
 *   ["m", <mime type>]
 *   ["x", <sha-256 of the file>] so a copy can be checked against what was shared
 *   ["mode", rain|burst|pop|video]
 *   ["size", <bytes>]
 *   ["t", "celebration"], ["alt", "Celebration animation: <name>"]
 */
import { nip19 } from 'nostr-tools';
import { streamQuery, DEFAULT_RELAYS, type NEvent } from './query';
import { CUSTOM_LIMITS, type CustomFile, type CustomMode } from '@/lib/ui/celebrations';

export const CELEBRATION_KIND = 31616;
export const STORE_RELAYS = [...new Set([...DEFAULT_RELAYS, 'wss://relay.ditto.pub', 'wss://relay.nostronchain.com', 'wss://nos.lol', 'wss://relay.damus.io'])];

export interface SharedCelebration {
  id: string;
  naddr: string;
  pubkey: string;
  d: string;
  name: string;
  description: string;
  url: string;
  mime: string;
  sha256?: string;
  mode: CustomMode | 'video';
  size?: number;
  createdAt: number;
}

async function sha256Hex(b: Blob): Promise<string> {
  const h = await crypto.subtle.digest('SHA-256', await b.arrayBuffer());
  return [...new Uint8Array(h)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'celebration';

/** The unsigned event for sharing a custom celebration whose file is already uploaded to `url`. */
export async function celebrationTemplate(c: CustomFile, url: string, description = '') {
  const mode = c.kind === 'video' ? 'video' : c.mode;
  return {
    kind: CELEBRATION_KIND,
    created_at: Math.floor(Date.now() / 1000),
    content: description.slice(0, 280),
    tags: [
      ['d', `${slug(c.name)}-${c.id.slice(-4)}`],
      ['title', c.name],
      ['url', url],
      ['m', c.type],
      ['x', await sha256Hex(c.data)],
      ['mode', mode],
      ['size', String(c.data.size)],
      ['t', 'celebration'],
      ['alt', `Celebration animation: ${c.name}`],
    ],
  };
}

export function parseCelebration(e: NEvent): SharedCelebration | null {
  if (e.kind !== CELEBRATION_KIND) return null;
  const tag = (n: string) => e.tags.find((t) => t[0] === n)?.[1];
  const url = tag('url') || '';
  const mime = tag('m') || '';
  const d = tag('d') || '';
  if (!/^https:\/\//.test(url) || !d) return null;
  if (![...CUSTOM_LIMITS.imageTypes, ...CUSTOM_LIMITS.videoTypes].includes(mime)) return null;
  const mode = (tag('mode') as SharedCelebration['mode']) || (mime.startsWith('video/') ? 'video' : 'rain');
  return {
    id: e.id, pubkey: e.pubkey, d, url, mime, mode,
    naddr: nip19.naddrEncode({ kind: CELEBRATION_KIND, pubkey: e.pubkey, identifier: d }),
    name: (tag('title') || 'Celebration').slice(0, 40),
    description: e.content.slice(0, 280),
    sha256: tag('x'),
    size: Number(tag('size')) || undefined,
    createdAt: e.created_at,
  };
}

/** Everything shared, newest version of each, newest first. */
export function streamStore(onUpdate: (list: SharedCelebration[], done: boolean) => void, authors?: string[]): () => void {
  const byAddr = new Map<string, SharedCelebration>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const emit = (done: boolean) => onUpdate([...byAddr.values()].sort((a, b) => b.createdAt - a.createdAt), done);
  return streamQuery({
    relays: STORE_RELAYS,
    filters: [{ kinds: [CELEBRATION_KIND], limit: 300, ...(authors ? { authors } : {}) }],
    timeoutMs: 9000,
    onEvent: (e) => {
      const c = parseCelebration(e);
      if (!c) return;
      const k = `${c.pubkey}:${c.d}`;
      const prev = byAddr.get(k);
      if (prev && prev.createdAt >= c.createdAt) return;
      byAddr.set(k, c);
      if (!timer) timer = setTimeout(() => { timer = null; emit(false); }, 250);
    },
    onDone: () => { if (timer) clearTimeout(timer); emit(true); },
  });
}

/** Downloads a shared file and checks it is what was shared, and within the limits. */
export async function fetchShared(c: SharedCelebration): Promise<Blob> {
  const r = await fetch(c.url, { mode: 'cors' });
  if (!r.ok) throw new Error(`The file host answered ${r.status}`);
  const max = c.mime.startsWith('video/') ? CUSTOM_LIMITS.videoBytes : CUSTOM_LIMITS.imageBytes;
  const blob = await r.blob();
  if (blob.size > max) throw new Error('That file is over the size limit');
  if (c.sha256 && (await sha256Hex(blob)) !== c.sha256) throw new Error("The file doesn't match what was shared");
  return new Blob([blob], { type: c.mime });
}
