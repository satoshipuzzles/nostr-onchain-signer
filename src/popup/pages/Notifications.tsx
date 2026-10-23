import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Bell, Heart, Repeat2, Zap, MessageCircle, AtSign, Highlighter, UserPlus, Loader2, CheckCheck } from 'lucide-react';
import { useAuth } from '@/popup/context/AuthContext';
import { useProfile, useNostrEvent } from '@/popup/hooks/useNostr';
import { ClickableAvatar } from '@/popup/components/ClickableAvatar';
import { NoteCard } from '@/popup/components/NoteCard';
import { NoteThread } from '@/popup/components/NoteThread';
import { streamNotifications, lastSeen, markSeen, type Notif, type NotifType } from '@/lib/nostr/notifications';
import type { FeedNote } from '@/lib/nostr/feed';
import type { NEvent } from '@/lib/nostr/query';

const PAGE = 40;

type Tab = 'all' | 'mentions' | 'zaps' | 'reactions' | 'follows';

const TABS: { id: Tab; label: string; types: NotifType[] }[] = [
  { id: 'all', label: 'All', types: [] },
  { id: 'mentions', label: 'Replies & mentions', types: ['reply', 'mention', 'highlight'] },
  { id: 'zaps', label: 'Zaps', types: ['zap'] },
  { id: 'reactions', label: 'Likes & reposts', types: ['reaction', 'repost'] },
  { id: 'follows', label: 'Follows', types: ['follow'] },
];

const ICON: Record<NotifType, { Icon: typeof Bell; cls: string }> = {
  reply: { Icon: MessageCircle, cls: 'text-sky-300' },
  mention: { Icon: AtSign, cls: 'text-sky-300' },
  repost: { Icon: Repeat2, cls: 'text-emerald-300' },
  reaction: { Icon: Heart, cls: 'text-pink-300' },
  zap: { Icon: Zap, cls: 'text-amber-300' },
  highlight: { Icon: Highlighter, cls: 'text-yellow-200' },
  follow: { Icon: UserPlus, cls: 'text-purple-300' },
};

const toNote = (e: NEvent): FeedNote => ({ id: e.id, pubkey: e.pubkey, content: e.content, created_at: e.created_at, tags: e.tags, kind: e.kind });

const ago = (ts: number) => {
  const m = (Date.now() / 1000 - ts) / 60;
  if (m < 60) return `${Math.max(1, Math.round(m))}m`;
  if (m < 1440) return `${Math.round(m / 60)}h`;
  if (m < 43200) return `${Math.round(m / 1440)}d`;
  return new Date(ts * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

function ActorName({ pubkey }: { pubkey: string }) {
  const p = useProfile(pubkey || null);
  if (!pubkey) return <b className="text-white">Someone anonymous</b>;
  return <b className="text-white">{p?.displayName || p?.name || `${pubkey.slice(0, 8)}…`}</b>;
}

function ActorAvatar({ pubkey }: { pubkey: string }) {
  const p = useProfile(pubkey || null);
  if (!pubkey) return <div className="w-7 h-7 rounded-full bg-white/10 flex items-center justify-center text-[11px] text-gray-400">?</div>;
  return <ClickableAvatar pubkey={pubkey} picture={p?.picture} name={p?.displayName || p?.name || ''} size="sm" />;
}

/** One line of your note that the activity is about. */
function TargetSnippet({ id, onOpen }: { id: string; onOpen: (n: FeedNote) => void }) {
  const e = useNostrEvent({ type: 'id', id });
  if (e === undefined) return <p className="text-[12px] text-gray-600 mt-1">…</p>;
  if (!e) return null;
  const text = e.content.replace(/\s+/g, ' ').trim();
  return (
    <button onClick={() => onOpen(toNote(e))} className="block text-left w-full text-[12px] text-gray-400 mt-1 break-words hover:text-gray-200">
      {text ? (text.length > 160 ? `${text.slice(0, 160)}…` : text) : '(media)'}
    </button>
  );
}

function verb(n: Notif): string {
  switch (n.type) {
    case 'reaction': {
      const emojis = [...new Set(n.actors.map((a) => a.emoji).filter(Boolean))].slice(0, 4).join(' ');
      return `reacted ${emojis} to your note`;
    }
    case 'repost': return 'reposted your note';
    case 'zap': return n.target ? 'zapped your note' : 'zapped you';
    case 'highlight': return 'highlighted your writing';
    case 'follow': return 'followed you';
    case 'reply': return 'replied';
    case 'mention': return 'mentioned you';
  }
}

function GroupRow({ n, unread, onOpen }: { n: Notif; unread: boolean; onOpen: (note: FeedNote) => void }) {
  const { Icon, cls } = ICON[n.type];
  const first = n.actors[0];
  const others = n.actors.length - 1;
  const comments = n.actors.filter((a) => a.comment).slice(0, 2);
  return (
    <div className={`flex gap-3 px-4 py-3 border-b border-white/5 ${unread ? 'bg-purple-500/[0.06]' : ''}`} data-testid="notif" data-type={n.type}>
      <Icon className={`w-5 h-5 mt-1 flex-shrink-0 ${cls}`} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1 flex-wrap">
          {n.actors.slice(0, 8).map((a, i) => <ActorAvatar key={`${a.pubkey}:${i}`} pubkey={a.pubkey} />)}
          <span className="text-[11px] text-gray-500 ml-auto">{ago(n.at)}</span>
        </div>
        <p className="text-[13px] text-gray-300 mt-1">
          <ActorName pubkey={first?.pubkey ?? ''} />
          {others > 0 && <> and {others} other{others === 1 ? '' : 's'}</>} {verb(n)}
          {n.type === 'zap' && n.totalSats > 0 && <b className="text-amber-200"> · {n.totalSats.toLocaleString()} sats</b>}
        </p>
        {comments.map((a, i) => <p key={i} className="text-[12px] text-gray-200 mt-0.5 break-words">“{a.comment}”</p>)}
        {n.target && <TargetSnippet id={n.target} onOpen={onOpen} />}
      </div>
    </div>
  );
}

function EventRow({ n, unread, onOpen }: { n: Notif; unread: boolean; onOpen: (note: FeedNote) => void }) {
  const { Icon, cls } = ICON[n.type];
  if (!n.event) return null;
  return (
    <div className={`px-4 py-3 border-b border-white/5 ${unread ? 'bg-purple-500/[0.06]' : ''}`} data-testid="notif" data-type={n.type}>
      <p className="text-[11px] text-gray-500 flex items-center gap-1.5 mb-1.5">
        <Icon className={`w-3.5 h-3.5 ${cls}`} /> <ActorName pubkey={n.event.pubkey} /> {verb(n)}
        {n.type === 'reply' && n.target && <span className="text-gray-600">to your note</span>}
      </p>
      <NoteCard note={toNote(n.event)} onSelectNote={onOpen} />
    </div>
  );
}

export function Notifications() {
  const navigate = useNavigate();
  const { publicKey } = useAuth();
  const [rows, setRows] = useState<Notif[]>([]);
  const [done, setDone] = useState(false);
  const [tab, setTab] = useState<Tab>('all');
  const [thread, setThread] = useState<FeedNote | null>(null);
  const [limit, setLimit] = useState(PAGE);
  const endRef = useRef<HTMLDivElement | null>(null);
  // what counted as read when the page opened, so new rows stay highlighted while you look
  const [seenAt] = useState(() => lastSeen(publicKey));

  useEffect(() => {
    if (!publicKey) return;
    setRows([]);
    setDone(false);
    return streamNotifications(publicKey, (s) => { setRows(s.rows); if (s.done) setDone(true); });
  }, [publicKey]);

  // opening the page reads everything up to now
  useEffect(() => {
    if (!publicKey) return;
    markSeen(publicKey);
    return () => markSeen(publicKey);
  }, [publicKey, rows.length]);

  const types = TABS.find((t) => t.id === tab)!.types;
  const shown = useMemo(() => (types.length ? rows.filter((r) => types.includes(r.type)) : rows), [rows, types]);
  useEffect(() => setLimit(PAGE), [tab]);
  useEffect(() => {
    const el = endRef.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) setLimit((n) => n + PAGE); }, { rootMargin: '600px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [shown.length > limit]);
  const counts = useMemo(() => Object.fromEntries(TABS.map((t) => [t.id, t.types.length ? rows.filter((r) => t.types.includes(r.type)).length : rows.length])), [rows]);

  if (!publicKey) {
    return (
      <div className="p-6 text-center text-sm text-gray-400">
        <Bell className="w-8 h-8 mx-auto mb-2 text-gray-600" />
        Sign in to see who replied, zapped, liked and followed you.
      </div>
    );
  }

  return (
    <div className="min-h-full flex flex-col max-w-2xl">
      <div className="flex items-center gap-3 px-4 pt-4 pb-2">
        <button onClick={() => navigate(-1)} className="p-2 -ml-2 rounded-lg hover:bg-white/10 md:hidden" aria-label="Back"><ArrowLeft className="w-5 h-5" /></button>
        <h1 className="text-lg font-bold flex items-center gap-2"><Bell className="w-5 h-5 text-purple-300" /> Notifications</h1>
        {!done && <Loader2 className="w-4 h-4 animate-spin text-gray-500" />}
        {done && <span className="ml-auto text-[11px] text-gray-500 flex items-center gap-1"><CheckCheck className="w-3.5 h-3.5" /> Live · last 30 days</span>}
      </div>

      <div className="flex gap-1.5 px-4 pb-2 overflow-x-auto border-b border-white/10">
        {TABS.map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)} className={`text-[12px] px-3 py-1.5 rounded-full border whitespace-nowrap ${tab === t.id ? 'border-purple-400 text-white bg-purple-500/20' : 'border-white/10 text-gray-400'}`}>
            {t.label} <span className="opacity-60">{counts[t.id]}</span>
          </button>
        ))}
      </div>

      {shown.slice(0, limit).map((n) => {
        const unread = n.at > seenAt;
        return n.event
          ? <EventRow key={n.key} n={n} unread={unread} onOpen={setThread} />
          : <GroupRow key={n.key} n={n} unread={unread} onOpen={setThread} />;
      })}
      {shown.length > limit && <div ref={endRef} className="h-10" />}
      {done && !shown.length && <p className="text-sm text-gray-500 text-center py-12">Nothing here in the last 30 days.</p>}
      {!done && !shown.length && <p className="text-sm text-gray-500 text-center py-12">Asking your relays…</p>}

      {thread && <NoteThread note={thread} profiles={new Map()} onClose={() => setThread(null)} />}
    </div>
  );
}
