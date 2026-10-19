import { useEffect, useMemo, useState } from 'react';
import { Loader2, MessagesSquare } from 'lucide-react';
import { type FeedNote } from '@/lib/nostr/feed';
import { streamQuery, relaysForAuthors, type NEvent } from '@/lib/nostr/query';
import { rootOf } from '@/lib/nostr/thread';
import { primeEvent } from '@/lib/nostr/nostr-store';
import { NoteCard } from '@/popup/components/NoteCard';

/**
 * Conversations between the viewer and the profile they're looking at, borrowed from
 * Damus (ProfileModel.listenToConversations): their notes that tag the viewer plus the
 * viewer's notes that tag them, kinds 1 / 1111 / 30023 / 9802, up to 500 each. Grouped
 * here by thread root, newest activity first, each thread under the note it started from.
 */

const KINDS = [1, 1111, 30023, 9802];
const PAGE = 25;

interface Thread {
  root: string;
  notes: NEvent[];
  last: number;
}

function toNote(e: NEvent): FeedNote {
  return { id: e.id, pubkey: e.pubkey, content: e.content, created_at: e.created_at, tags: e.tags, kind: e.kind };
}

function when(ts: number): string {
  const d = new Date(ts * 1000);
  const days = (Date.now() / 1000 - ts) / 86400;
  if (days < 1) return 'today';
  if (days < 2) return 'yesterday';
  if (days < 7) return `${Math.floor(days)} days ago`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: days > 300 ? 'numeric' : undefined });
}

interface Props {
  me: string;
  them: string;
  onSelectNote: (note: FeedNote) => void;
  onViewProfile: (pubkey: string) => void;
}

export function ProfileConversations({ me, them, onSelectNote, onViewProfile }: Props) {
  const [events, setEvents] = useState<Map<string, NEvent>>(new Map());
  const [roots, setRoots] = useState<Map<string, NEvent>>(new Map());
  const [loading, setLoading] = useState(true);
  const [shown, setShown] = useState(PAGE);

  // both people's outbox and inbox relays, so either side's notes are found
  useEffect(() => {
    let stop: (() => void) | null = null;
    let live = true;
    setEvents(new Map());
    setRoots(new Map());
    setLoading(true);
    setShown(PAGE);
    relaysForAuthors([them, me]).then((relays) => {
      if (!live) return;
      const found = new Map<string, NEvent>();
      let timer: ReturnType<typeof setTimeout> | null = null;
      const flush = () => { timer = null; setEvents(new Map(found)); };
      stop = streamQuery({
        relays,
        filters: [
          { kinds: KINDS, authors: [them], '#p': [me], limit: 500 },
          { kinds: KINDS, authors: [me], '#p': [them], limit: 500 },
        ],
        timeoutMs: 10000,
        onEvent: (e) => {
          const ok = (e.pubkey === them && e.tags.some((t) => t[0] === 'p' && t[1] === me))
            || (e.pubkey === me && e.tags.some((t) => t[0] === 'p' && t[1] === them));
          if (!ok) return;
          primeEvent(e);
          found.set(e.id, e);
          if (!timer) timer = setTimeout(flush, 250);
        },
        onDone: () => { if (timer) clearTimeout(timer); flush(); setLoading(false); },
      });
    });
    return () => { live = false; stop?.(); };
  }, [me, them]);

  const threads = useMemo(() => {
    const by = new Map<string, Thread>();
    for (const e of events.values()) {
      const root = rootOf(e) ?? e.id;
      const t = by.get(root) ?? { root, notes: [], last: 0 };
      t.notes.push(e);
      t.last = Math.max(t.last, e.created_at);
      by.set(root, t);
    }
    for (const t of by.values()) t.notes.sort((a, b) => a.created_at - b.created_at);
    return [...by.values()].sort((a, b) => b.last - a.last);
  }, [events]);

  // the notes each thread started from, when neither of them wrote it or it wasn't tagged
  const visible = threads.slice(0, shown);
  const missing = useMemo(
    () => visible.map((t) => t.root).filter((id) => !events.has(id) && !roots.has(id)),
    [visible, events, roots],
  );
  useEffect(() => {
    if (!missing.length) return;
    let stop: (() => void) | null = null;
    let live = true;
    relaysForAuthors([them, me]).then((relays) => {
      if (!live) return;
      stop = streamQuery({
        relays,
        filters: [{ ids: missing.slice(0, 100) }],
        timeoutMs: 7000,
        onEvent: (e) => { primeEvent(e); setRoots((m) => new Map(m).set(e.id, e)); },
        onDone: () => {},
      });
    });
    return () => { live = false; stop?.(); };
  }, [missing.join(','), me, them]);

  if (loading && !threads.length) {
    return (
      <div className="flex flex-col items-center justify-center py-8">
        <Loader2 className="w-6 h-6 text-nostr animate-spin mb-2" />
        <p className="text-xs text-gray-400">Finding your conversations...</p>
      </div>
    );
  }
  if (!threads.length) {
    return (
      <div className="flex flex-col items-center py-10 text-center">
        <MessagesSquare className="w-8 h-8 text-gray-600 mb-2" />
        <p className="text-sm text-gray-400">No conversations yet</p>
        <p className="text-xs text-gray-600 mt-1">Replies and mentions between the two of you show up here.</p>
      </div>
    );
  }

  return (
    <div>
      <p className="text-[11px] text-gray-500 pb-2">
        {threads.length} conversation{threads.length === 1 ? '' : 's'} · {events.size} message{events.size === 1 ? '' : 's'}
        {loading && <Loader2 className="inline w-3 h-3 ml-1.5 animate-spin" />}
      </p>
      {visible.map((t) => {
        const root = events.get(t.root) ?? roots.get(t.root);
        const rest = t.notes.filter((n) => n.id !== t.root);
        return (
          <div key={t.root} className="mb-3 rounded-2xl border border-white/10 bg-white/[0.02] overflow-hidden">
            <div className="flex items-center justify-between px-3 pt-2 text-[11px] text-gray-500">
              <span>{t.notes.length} message{t.notes.length === 1 ? '' : 's'}</span>
              <span>{when(t.last)}</span>
            </div>
            {root ? (
              <div className={`px-3 py-2 ${rest.length ? 'opacity-80' : ''}`}>
                <NoteCard note={toNote(root)} onSelectNote={onSelectNote} onViewProfile={onViewProfile} compact={rest.length > 0} />
              </div>
            ) : (
              <p className="px-3 py-2 text-[11px] text-gray-600 italic">Reply in a thread whose first note isn't on these relays</p>
            )}
            {rest.length > 0 && (
              <div className="ml-4 border-l-2 border-purple-500/30">
                {rest.map((n) => (
                  <div key={n.id} className="pl-3 pr-3 py-2 border-t border-white/5">
                    <NoteCard note={toNote(n)} onSelectNote={onSelectNote} onViewProfile={onViewProfile} />
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
      {threads.length > shown && (
        <button onClick={() => setShown((s) => s + PAGE)} className="w-full py-3 text-xs text-purple-300 hover:text-purple-200">
          Show older conversations ({threads.length - shown} more)
        </button>
      )}
    </div>
  );
}
