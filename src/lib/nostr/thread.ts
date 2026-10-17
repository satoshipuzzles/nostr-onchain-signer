/**
 * Thread structure: NIP-10 (kind 1 replies) and NIP-22 (kind 1111 comments).
 */

interface Ev { id: string; kind: number; tags: string[][] }

function eTags(e: Ev): string[][] {
  return e.tags.filter((t) => t[0] === 'e' && /^[0-9a-f]{64}$/.test(t[1] ?? '') && t[3] !== 'mention');
}

/** The thread root this event belongs to, or null if it is a root itself. */
export function rootOf(e: Ev): string | null {
  if (e.kind === 1111) return e.tags.find((t) => t[0] === 'E' && t[1])?.[1] ?? null;
  const es = eTags(e);
  if (!es.length) return null;
  return (es.find((t) => t[3] === 'root') ?? es[0])[1];
}

/** The event this one replies to directly, or null. */
export function parentOf(e: Ev): string | null {
  if (e.kind === 1111) {
    const lower = e.tags.filter((t) => t[0] === 'e' && t[1]);
    if (lower.length) return lower[lower.length - 1][1];
    return e.tags.find((t) => t[0] === 'E' && t[1])?.[1] ?? null;
  }
  const es = eTags(e);
  if (!es.length) return null;
  const reply = es.find((t) => t[3] === 'reply');
  if (reply) return reply[1];
  const root = es.find((t) => t[3] === 'root');
  if (root) return root[1];
  // Deprecated positional form: last e tag is the one replied to
  return es[es.length - 1][1];
}

/** Relay hints carried in an event's e / E tags. */
export function eventRelayHints(e: Ev): string[] {
  return e.tags
    .filter((t) => (t[0] === 'e' || t[0] === 'E' || t[0] === 'p') && typeof t[2] === 'string' && t[2].startsWith('wss://'))
    .map((t) => t[2]);
}

/** Whether an event is a reply / comment (has a parent). */
export function isReply(e: Ev): boolean {
  return parentOf(e) !== null;
}
