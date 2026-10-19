/**
 * NIP-51 mute list (kind 10000). Muted (blocked) people are hidden everywhere notes render.
 *
 * The list lives on Nostr so it follows the user across clients: on start the newest kind
 * 10000 from the user's relays is merged with the copy on this device, and every change
 * re-publishes the whole list built on top of the newest one seen, so mutes made in other
 * apps (and anything else on it: words, hashtags, threads, the private encrypted part)
 * are kept rather than overwritten.
 *
 * mutedNow() / onMutesChanged() give every component the current set without async work,
 * so a block takes effect on screen at once.
 */

import { publishEvent } from './publish';
import { signEventWithFallback } from './sign-event';
import { streamQuery, relaysForAuthor, DEFAULT_RELAYS, type NEvent } from './query';

const MUTE_STORAGE_KEY = 'muted_pubkeys';
const LIST_STORAGE_KEY = 'mute_list_event';

let current = new Set<string>();
let listEvent: { tags: string[][]; content: string; created_at: number } | null = null;
const listeners = new Set<(m: Set<string>) => void>();
let synced: Promise<void> | null = null;

function emit() { for (const l of listeners) l(current); }

/** The muted pubkeys right now (synchronous). */
export function mutedNow(): Set<string> { return current; }

export function onMutesChanged(fn: (m: Set<string>) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

async function saveLocal() {
  try {
    await chrome.storage.local.set({ [MUTE_STORAGE_KEY]: Array.from(current), [LIST_STORAGE_KEY]: listEvent });
  } catch { /* storage blocked */ }
}

async function loadLocal() {
  try {
    const r = await chrome.storage.local.get([MUTE_STORAGE_KEY, LIST_STORAGE_KEY]);
    const raw = r[MUTE_STORAGE_KEY];
    current = new Set(Array.isArray(raw) ? raw : []);
    const ev = r[LIST_STORAGE_KEY];
    if (ev && Array.isArray(ev.tags)) listEvent = ev;
  } catch { /* nothing stored */ }
}

/** Pull the newest mute list from the user's relays and merge it in (once per session). */
export function syncMuteList(myPubkey: string): Promise<void> {
  if (!myPubkey) return Promise.resolve();
  if (synced) return synced;
  synced = (async () => {
    await loadLocal();
    emit();
    const relays = await relaysForAuthor(myPubkey).catch(() => DEFAULT_RELAYS);
    const newest = await new Promise<NEvent | null>((resolve) => {
      let best: NEvent | null = null;
      streamQuery({
        relays: [...new Set([...relays, ...DEFAULT_RELAYS, 'wss://purplepag.es'])],
        filters: [{ kinds: [10000], authors: [myPubkey], limit: 4 }],
        timeoutMs: 7000,
        onEvent: (e) => { if (e.pubkey === myPubkey && (!best || e.created_at > best.created_at)) best = e; },
        onDone: () => resolve(best),
      });
    });
    if (newest && (!listEvent || newest.created_at > listEvent.created_at)) {
      listEvent = { tags: newest.tags, content: newest.content, created_at: newest.created_at };
      // the newest list wins for who is muted; local-only additions not yet published are kept
      const fromList = newest.tags.filter((t) => t[0] === 'p' && /^[0-9a-f]{64}$/.test(t[1] || '')).map((t) => t[1]);
      current = new Set(fromList);
      await saveLocal();
      emit();
    }
  })().catch(() => {});
  return synced;
}

export async function loadMutedPubkeys(): Promise<Set<string>> {
  if (!current.size) await loadLocal();
  return current;
}

async function publishMuteList(myPubkey: string): Promise<void> {
  // build on the newest list: keep every non-p tag (words, hashtags, threads) and the private part
  const others = (listEvent?.tags ?? []).filter((t) => t[0] !== 'p');
  const event = {
    kind: 10000,
    content: listEvent?.content ?? '',
    tags: [...Array.from(current).map((pk) => ['p', pk]), ...others],
    created_at: Math.max(Math.floor(Date.now() / 1000), (listEvent?.created_at ?? 0) + 1),
  };
  const signed = await signEventWithFallback(event, myPubkey);
  listEvent = { tags: signed.tags, content: signed.content, created_at: signed.created_at };
  await saveLocal();
  await publishEvent(signed);
}

async function change(myPubkey: string, fn: (s: Set<string>) => void): Promise<Set<string>> {
  // never publish over a list we haven't read yet
  await syncMuteList(myPubkey).catch(() => {});
  const next = new Set(current);
  fn(next);
  current = next;
  await saveLocal();
  emit();                                  // hide or show on screen right away
  publishMuteList(myPubkey).catch(() => {});
  return current;
}

export function mutePubkey(pubkey: string, myPubkey: string): Promise<Set<string>> {
  return change(myPubkey, (s) => s.add(pubkey));
}

export function unmutePubkey(pubkey: string, myPubkey: string): Promise<Set<string>> {
  return change(myPubkey, (s) => s.delete(pubkey));
}

export async function isMuted(pubkey: string): Promise<boolean> {
  return (await loadMutedPubkeys()).has(pubkey);
}
