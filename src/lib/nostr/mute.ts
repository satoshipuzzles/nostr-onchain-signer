/**
 * NIP-51 mute list (kind 10000).
 * Muted pubkeys are hidden from the feed. "Block" also unfollows.
 */

import { publishEvent } from './publish';
import { signEventWithFallback } from './sign-event';

const MUTE_STORAGE_KEY = 'muted_pubkeys';

export async function loadMutedPubkeys(): Promise<Set<string>> {
  try {
    const result = await chrome.storage.local.get(MUTE_STORAGE_KEY);
    const raw = result[MUTE_STORAGE_KEY];
    return new Set(Array.isArray(raw) ? raw : []);
  } catch {
    return new Set();
  }
}

async function saveMutedPubkeys(muted: Set<string>): Promise<void> {
  await chrome.storage.local.set({ [MUTE_STORAGE_KEY]: Array.from(muted) });
}

async function publishMuteList(muted: Set<string>, myPubkey: string): Promise<void> {
  const event = {
    kind: 10000,
    content: '',
    tags: Array.from(muted).map((pk) => ['p', pk]),
    created_at: Math.floor(Date.now() / 1000),
  };
  const signed = await signEventWithFallback(event, myPubkey);
  await publishEvent(signed);
}

export async function mutePubkey(pubkey: string, myPubkey: string): Promise<Set<string>> {
  const muted = await loadMutedPubkeys();
  muted.add(pubkey);
  await saveMutedPubkeys(muted);
  // Publish in background — local mute applies immediately either way
  publishMuteList(muted, myPubkey).catch(() => {});
  return muted;
}

export async function unmutePubkey(pubkey: string, myPubkey: string): Promise<Set<string>> {
  const muted = await loadMutedPubkeys();
  muted.delete(pubkey);
  await saveMutedPubkeys(muted);
  publishMuteList(muted, myPubkey).catch(() => {});
  return muted;
}

export async function isMuted(pubkey: string): Promise<boolean> {
  const muted = await loadMutedPubkeys();
  return muted.has(pubkey);
}
