/**
 * Note content tokenizer: URLs, NIP-27 `nostr:` references, bare npub /
 * nprofile / note / nevent / naddr strings, and NIP-08 `#[n]` legacy mentions.
 */

import { nip19 } from 'nostr-tools';
import type { EventPointer } from './nostr-store';

export type ContentToken =
  | { type: 'text'; text: string }
  | { type: 'url'; url: string }
  | { type: 'profile'; pubkey: string; relays: string[]; raw: string }
  | { type: 'event'; pointer: EventPointer; raw: string };

const BECH = '[02-9ac-hj-np-z]';
// One pass, leftmost match wins: a URL that contains an npub stays a URL.
const TOKEN_RE = new RegExp(
  [
    'https?:\\/\\/[^\\s<>"]+',
    `nostr:(?:npub|nprofile|note|nevent|naddr)1${BECH}+`,
    `\\b(?:npub|nprofile|note|nevent|naddr)1${BECH}{20,}`,
    '#\\[\\d+\\]',
  ].join('|'),
  'gi',
);

export const IMAGE_URL_RE = /https?:\/\/\S+\.(?:jpg|jpeg|png|gif|webp|avif)(?:\?\S*)?/gi;

/** Trim punctuation that ends a sentence rather than the URL. */
function splitUrl(raw: string): [string, string] {
  let url = raw;
  let tail = '';
  while (/[.,;:!?'"\]]$/.test(url) || (url.endsWith(')') && (url.match(/\(/g)?.length ?? 0) < (url.match(/\)/g)?.length ?? 0))) {
    tail = url.slice(-1) + tail;
    url = url.slice(0, -1);
  }
  return [url, tail];
}

/** Decode a bech32 nostr entity into a token, or null. */
export function decodeEntity(raw: string): ContentToken | null {
  const entity = raw.replace(/^nostr:/i, '').toLowerCase();
  try {
    const d = nip19.decode(entity);
    switch (d.type) {
      case 'npub': return { type: 'profile', pubkey: d.data, relays: [], raw };
      case 'nprofile': return { type: 'profile', pubkey: d.data.pubkey, relays: d.data.relays ?? [], raw };
      case 'note': return { type: 'event', pointer: { type: 'id', id: d.data }, raw };
      case 'nevent': return {
        type: 'event',
        pointer: { type: 'id', id: d.data.id, relays: d.data.relays ?? [], author: d.data.author },
        raw,
      };
      case 'naddr': return {
        type: 'event',
        pointer: { type: 'addr', kind: d.data.kind, pubkey: d.data.pubkey, identifier: d.data.identifier, relays: d.data.relays ?? [] },
        raw,
      };
      default: return null;
    }
  } catch {
    return null;
  }
}

/**
 * Split note content into tokens. `tags` resolves NIP-08 `#[n]` mentions.
 * Image URLs are removed when `stripImages` (they render below the text).
 */
export function tokenizeContent(content: string, tags: string[][] = [], stripImages = true): ContentToken[] {
  const text = stripImages ? content.replace(IMAGE_URL_RE, '') : content;
  const out: ContentToken[] = [];
  const pushText = (t: string) => {
    if (!t) return;
    const last = out[out.length - 1];
    if (last?.type === 'text') last.text += t;
    else out.push({ type: 'text', text: t });
  };

  let pos = 0;
  for (const m of text.matchAll(TOKEN_RE)) {
    const raw = m[0];
    const start = m.index ?? 0;
    pushText(text.slice(pos, start));
    pos = start + raw.length;

    if (/^https?:\/\//i.test(raw)) {
      const [url, tail] = splitUrl(raw);
      out.push({ type: 'url', url });
      pushText(tail);
      continue;
    }
    if (raw.startsWith('#[')) {
      const tag = tags[parseInt(raw.slice(2, -1), 10)];
      if (tag?.[0] === 'p' && /^[0-9a-f]{64}$/.test(tag[1] ?? '')) {
        out.push({ type: 'profile', pubkey: tag[1], relays: tag[2] ? [tag[2]] : [], raw });
      } else if (tag?.[0] === 'e' && /^[0-9a-f]{64}$/.test(tag[1] ?? '')) {
        out.push({ type: 'event', pointer: { type: 'id', id: tag[1], relays: tag[2] ? [tag[2]] : [] }, raw });
      } else {
        pushText(raw);
      }
      continue;
    }
    const tok = decodeEntity(raw);
    if (tok) out.push(tok);
    else pushText(raw);
  }
  pushText(text.slice(pos));

  // Tidy the edges left behind by removed image URLs
  if (out[0]?.type === 'text') out[0].text = out[0].text.replace(/^\s+/, '');
  const last = out[out.length - 1];
  if (last?.type === 'text') last.text = last.text.replace(/\s+$/, '');
  return out.filter((t) => t.type !== 'text' || t.text.length > 0);
}

/** Visible length of a token list (mentions count as a short name). */
export function tokensLength(tokens: ContentToken[]): number {
  return tokens.reduce((n, t) => n + (t.type === 'text' ? t.text.length : t.type === 'url' ? Math.min(t.url.length, 40) : t.type === 'profile' ? 12 : 0), 0);
}

/** Keep tokens up to `max` visible characters. */
export function truncateTokens(tokens: ContentToken[], max: number): ContentToken[] {
  const out: ContentToken[] = [];
  let n = 0;
  for (const t of tokens) {
    const len = tokensLength([t]);
    if (n + len <= max) {
      out.push(t);
      n += len;
      continue;
    }
    if (t.type === 'text') out.push({ type: 'text', text: t.text.slice(0, Math.max(0, max - n)) });
    break;
  }
  return out;
}

/** Pubkeys mentioned in content (for pre-fetching names). */
export function mentionedPubkeys(tokens: ContentToken[]): string[] {
  return tokens.filter((t): t is Extract<ContentToken, { type: 'profile' }> => t.type === 'profile').map((t) => t.pubkey);
}
