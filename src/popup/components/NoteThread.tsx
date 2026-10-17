import { useState, useEffect, useRef, useMemo } from 'react';
import type { FeedNote } from '@/lib/nostr/feed';
import { type ProfileMetadata } from '@/lib/nostr/social';
import { streamQuery, relaysForAuthor, cleanRelays, type NEvent } from '@/lib/nostr/query';
import { primeEvent, primeProfiles } from '@/lib/nostr/nostr-store';
import { rootOf, parentOf, eventRelayHints } from '@/lib/nostr/thread';
import { useEngagement } from '@/popup/hooks/useNostr';
import { NoteCard } from './NoteCard';
import { X, Loader2, ArrowUp } from 'lucide-react';

interface Props {
  note: FeedNote;
  profiles: Map<string, ProfileMetadata>;
  onClose: () => void;
  onViewProfile?: (pubkey: string) => void;
  /** Render inline (a page) instead of as a full-screen overlay. */
  inline?: boolean;
}

function toNote(e: NEvent): FeedNote {
  return { id: e.id, pubkey: e.pubkey, content: e.content, created_at: e.created_at, tags: e.tags, kind: e.kind };
}

/**
 * A note with its ancestors and every reply / NIP-22 comment under it.
 * Streams from the author's outbox + inbox relays, the viewer's relays,
 * the defaults and the cloud fallback.
 */
export function NoteThread({ note: initial, profiles, onClose, onViewProfile, inline }: Props) {
  const [focus, setFocus] = useState<FeedNote>(initial);
  const [events, setEvents] = useState<Map<string, FeedNote>>(() => new Map([[initial.id, initial]]));
  const [loading, setLoading] = useState(true);
  const [relays, setRelays] = useState<string[] | null>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const topRef = useRef<HTMLDivElement>(null);

  useEffect(() => { setFocus(initial); }, [initial.id]);
  useEffect(() => { primeProfiles(profiles.values()); }, [profiles]);

  const rootId = rootOf(focus) ?? focus.id;
  const parentId = parentOf(focus);

  useEffect(() => {
    let cancelled = false;
    let cancel: (() => void) | null = null;
    setLoading(true);
    const found = new Map<string, FeedNote>();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      timer = null;
      if (!cancelled) setEvents((prev) => new Map([...prev, ...found]));
    };

    const rootAuthor = focus.tags.find((t) => t[0] === 'P')?.[1]
      ?? focus.tags.find((t) => t[0] === 'e' && t[1] === rootId)?.[4];
    Promise.all([
      relaysForAuthor(focus.pubkey, { inbox: true, hints: eventRelayHints(focus) }),
      rootAuthor && rootAuthor !== focus.pubkey ? relaysForAuthor(rootAuthor, { inbox: true }) : Promise.resolve([] as string[]),
    ]).then(([a, b]) => {
      if (cancelled) return;
      const rs = cleanRelays([...a.slice(0, 8), ...b.slice(0, 4), ...a.slice(8)], 14);
      setRelays(rs);
      const ids = [...new Set([rootId, parentId, focus.id].filter((x): x is string => !!x))];
      const tagged = [...new Set([rootId, focus.id])];
      cancel = streamQuery({
        relays: rs,
        filters: [
          { ids, limit: ids.length },
          { kinds: [1, 1111], '#e': tagged, limit: 500 },
          { kinds: [1111], '#E': [rootId], limit: 300 },
        ],
        // The cloud only takes filters with kinds
        cloudRelays: rs,
        timeoutMs: 9000,
        onEvent: (e) => {
          if (e.kind !== 1 && e.kind !== 1111 && e.kind !== 30023 && !ids.includes(e.id)) return;
          primeEvent(e);
          found.set(e.id, toNote(e));
          if (!timer) timer = setTimeout(flush, 200);
        },
        onDone: () => {
          if (timer) clearTimeout(timer);
          flush();
          if (!cancelled) setLoading(false);
        },
      });
      // Ancestor ids by themselves for the cloud (it needs kinds on every filter)
      streamQuery({
        relays: [],
        cloudRelays: rs,
        filters: [{ ids, kinds: [1, 1111], limit: ids.length }],
        timeoutMs: 8000,
        onEvent: (e) => { primeEvent(e); found.set(e.id, toNote(e)); if (!timer) timer = setTimeout(flush, 200); },
      });
    });

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      cancel?.();
    };
  }, [focus.id, rootId]);

  // Ancestors: walk up from the focused note through what we have
  const ancestors = useMemo(() => {
    const chain: FeedNote[] = [];
    let cur: FeedNote | undefined = focus;
    const guard = new Set<string>();
    while (cur) {
      const pid = parentOf(cur);
      if (!pid || guard.has(pid)) break;
      guard.add(pid);
      const p = events.get(pid);
      if (!p) break;
      chain.unshift(p);
      cur = p;
    }
    // Root known but not connected through the chain: show it on top with a gap
    const root = events.get(rootId);
    const gap = !!root && root.id !== focus.id && !chain.some((n) => n.id === root.id);
    return { chain, root: gap ? root : null };
  }, [events, focus, rootId]);

  // Descendants of the focused note, depth-first, oldest first per level
  const replies = useMemo(() => {
    const children = new Map<string, FeedNote[]>();
    for (const e of events.values()) {
      if (e.id === focus.id) continue;
      const pid = parentOf(e);
      if (!pid) continue;
      const list = children.get(pid) ?? [];
      list.push(e);
      children.set(pid, list);
    }
    const out: { note: FeedNote; depth: number }[] = [];
    const walk = (id: string, depth: number) => {
      const kids = (children.get(id) ?? []).sort((a, b) => a.created_at - b.created_at);
      for (const k of kids) {
        if (out.some((o) => o.note.id === k.id)) continue;
        out.push({ note: k, depth });
        walk(k.id, depth + 1);
      }
    };
    walk(focus.id, 0);
    return out;
  }, [events, focus.id]);

  const engagementIds = useMemo(() => replies.map((r) => r.note.id).slice(0, 200), [replies]);
  const engagement = useEngagement(loading ? [] : engagementIds, relays);

  function select(n: FeedNote) {
    if (n.id === focus.id) return;
    setFocus(n);
    setEvents((prev) => new Map([...prev, [n.id, n]]));
    topRef.current?.scrollIntoView({ block: 'start' });
  }

  function handleOverlayClick(e: React.MouseEvent) {
    if (e.target === overlayRef.current) onClose();
  }

  const body = (
    <div ref={topRef} className={`max-w-lg mx-auto ${inline ? 'p-0' : 'p-4 pt-8 pb-24 min-h-full'}`}>
      {!inline && (
        <button
          onClick={onClose}
          className="fixed top-4 right-4 z-[71] p-2 rounded-full bg-surface-800 text-gray-400 hover:text-white hover:bg-surface-700 transition-colors"
        >
          <X className="w-5 h-5" />
        </button>
      )}

      {ancestors.root && (
        <>
          <NoteCard note={ancestors.root} profile={profiles.get(ancestors.root.pubkey)} onViewProfile={onViewProfile} onSelectNote={select} compact />
          <div className="flex items-center gap-1 pl-5 py-1 text-[10px] text-gray-600"><ArrowUp className="w-3 h-3" /> earlier replies</div>
        </>
      )}
      {ancestors.chain.map((n) => (
        <div key={n.id} className="relative">
          <NoteCard note={n} profile={profiles.get(n.pubkey)} onViewProfile={onViewProfile} onSelectNote={select} compact />
          <div className="flex justify-start pl-6 -my-0.5"><div className="w-0.5 h-4 bg-surface-200/20" /></div>
        </div>
      ))}
      {parentOf(focus) && ancestors.chain.length === 0 && loading && (
        <div className="flex items-center gap-2 px-2 py-2 text-[11px] text-gray-500">
          <Loader2 className="w-3 h-3 animate-spin" /> Loading the note this replies to…
        </div>
      )}

      <NoteCard
        note={focus}
        profile={profiles.get(focus.pubkey)}
        onViewProfile={onViewProfile}
        onSelectNote={select}
        highlighted
      />

      <div className="mt-1">
        {replies.length > 0 && (
          <p className="text-xs text-gray-500 mb-2 px-1">
            {replies.length} {replies.length === 1 ? 'reply' : 'replies'}
          </p>
        )}
        {replies.map(({ note: reply, depth }) => (
          <div
            key={reply.id}
            className="relative"
            style={{ marginLeft: Math.min(depth, 3) * 14 }}
          >
            {depth > 0 && <div className="absolute -left-2 top-0 bottom-0 w-px bg-surface-200/10" />}
            <NoteCard
              note={reply}
              profile={profiles.get(reply.pubkey)}
              engagement={engagement.get(reply.id)}
              onViewProfile={onViewProfile}
              onSelectNote={select}
              compact
            />
          </div>
        ))}

        {loading && (
          <div className="flex items-center justify-center py-4">
            <Loader2 className="w-5 h-5 text-nostr animate-spin" />
            <span className="text-xs text-gray-500 ml-2">Loading replies...</span>
          </div>
        )}
        {!loading && replies.length === 0 && (
          <p className="text-xs text-gray-600 text-center py-4">No replies yet</p>
        )}
      </div>
    </div>
  );

  if (inline) return body;

  return (
    <div
      ref={overlayRef}
      onClick={handleOverlayClick}
      className="fixed inset-0 z-[70] bg-black/80 backdrop-blur-sm overflow-y-auto"
    >
      {body}
    </div>
  );
}
