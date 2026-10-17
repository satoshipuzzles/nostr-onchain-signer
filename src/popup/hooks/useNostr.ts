import { useEffect, useReducer, useState, useRef } from 'react';
import type { ProfileMetadata } from '@/lib/nostr/social';
import {
  getProfileSync, onProfile, requestProfiles,
  getEventSync, onEvent, requestEvent, pointerKey, type EventPointer,
} from '@/lib/nostr/nostr-store';
import { streamQuery, type NEvent } from '@/lib/nostr/query';
import { tallyEngagement, EMPTY_ENGAGEMENT, type Engagement, type NostrEvent } from '@/lib/nostr/feed';

/** A profile from the shared store; fetched (batched) on first use. */
export function useProfile(pubkey: string | undefined | null, hints?: string[]): ProfileMetadata | undefined {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (!pubkey) return;
    const off = onProfile(pubkey, bump);
    if (!getProfileSync(pubkey)?.name && !getProfileSync(pubkey)?.displayName) requestProfiles([pubkey], hints);
    return off;
  }, [pubkey]);
  return pubkey ? getProfileSync(pubkey) : undefined;
}

/** One event by id or naddr; undefined while loading, null if not found. */
export function useNostrEvent(pointer: EventPointer | null): NEvent | null | undefined {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const key = pointer ? pointerKey(pointer) : '';
  useEffect(() => {
    if (!pointer) return;
    const off = onEvent(key, bump);
    requestEvent(pointer);
    return off;
  }, [key]);
  return key ? getEventSync(key) : undefined;
}

/**
 * Reply / repost / reaction / zap tallies for a list of notes, streamed from
 * `relays` plus the cloud fallback. Pass relays = null to wait.
 */
export function useEngagement(ids: string[], relays: string[] | null): Map<string, Engagement> {
  const [map, setMap] = useState<Map<string, Engagement>>(new Map());
  const key = [...ids].sort().join(',');
  const relayKey = relays?.join(',') ?? '';
  const seen = useRef(new Set<string>());

  useEffect(() => {
    if (!relays || ids.length === 0) return;
    const tally = new Map<string, Engagement>();
    for (const id of ids) tally.set(id, { ...EMPTY_ENGAGEMENT });
    seen.current = new Set();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => { timer = null; setMap(new Map([...tally].map(([k, v]) => [k, { ...v }]))); };
    const cancels: (() => void)[] = [];
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100);
      cancels.push(streamQuery({
        relays,
        filters: [{ kinds: [1, 6, 7, 1111, 9735], '#e': chunk, limit: 500 }],
        timeoutMs: 8000,
        onEvent: (e) => {
          if (seen.current.has(e.id)) return;
          seen.current.add(e.id);
          if (tallyEngagement(e as NostrEvent, tally) && !timer) timer = setTimeout(flush, 300);
        },
        onDone: () => { if (timer) clearTimeout(timer); flush(); },
      }));
    }
    return () => {
      if (timer) clearTimeout(timer);
      cancels.forEach((c) => c());
    };
  }, [key, relayKey]);

  return map;
}
