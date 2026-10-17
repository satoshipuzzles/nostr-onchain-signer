/**
 * Read-only public pages that need no account:
 *   /p/:id      profile (npub, nprofile, hex or name@domain)
 *   /e/:id      a note and its thread (note, nevent or hex id)
 *   /search?q=  people search
 */
import { useEffect, useState, useRef, type ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { nip19 } from 'nostr-tools';
import { Search, Loader2, BadgeCheck, ArrowRight } from 'lucide-react';
import { ProfileView } from './ProfileView';
import { NoteThread } from '@/popup/components/NoteThread';
import { ClickableAvatar } from '@/popup/components/ClickableAvatar';
import { resolveNip05 } from '@/lib/nostr/nip05';
import { searchPeople, parseKeyQuery, type PeopleHit } from '@/lib/nostr/people-search';
import { useNostrEvent, useProfile } from '@/popup/hooks/useNostr';
import type { EventPointer } from '@/lib/nostr/nostr-store';
import type { FeedNote } from '@/lib/nostr/feed';

function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="h-full overflow-y-auto bg-surface-900 text-white">
      <header className="sticky top-0 z-40 bg-black/90 backdrop-blur border-b border-white/10">
        <div className="max-w-lg mx-auto flex items-center gap-3 px-4 h-12">
          <Link to="/search" className="flex items-center gap-2 min-w-0">
            <img src="/logo.png" alt="" className="w-7 h-7 rounded-lg" />
            <span className="text-sm font-bold truncate">Nostr Onchain</span>
          </Link>
          <Link to="/search" className="ml-auto p-2 rounded-lg text-gray-400 hover:text-white hover:bg-white/5" title="Search people">
            <Search className="w-4 h-4" />
          </Link>
          <Link to="/" className="text-xs px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/15 flex items-center gap-1">
            Open app <ArrowRight className="w-3 h-3" />
          </Link>
        </div>
      </header>
      <main className="max-w-lg mx-auto">{children}</main>
    </div>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return <div className="flex flex-col items-center justify-center py-16 px-4 text-center text-sm text-gray-400">{children}</div>;
}

export function PublicProfile() {
  const { id = '' } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [pubkey, setPubkey] = useState<string | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    setPubkey(null);
    setError('');
    const raw = decodeURIComponent(id).trim();
    const key = parseKeyQuery(raw);
    if (key) { setPubkey(key.pubkey); return; }
    if (raw.includes('@') || raw.includes('.')) {
      resolveNip05(raw.includes('@') ? raw : `_@${raw}`).then((r) => {
        if (r) setPubkey(r.pubkey);
        else setError(`Couldn't find ${raw}`);
      });
      return;
    }
    setError('That is not an npub, nprofile, hex key or name@domain.');
  }, [id]);

  const profile = useProfile(pubkey);

  return (
    <Shell>
      {error && <Centered>{error}</Centered>}
      {!error && !pubkey && <Centered><Loader2 className="w-5 h-5 animate-spin" /></Centered>}
      {pubkey && (
        <ProfileView
          key={pubkey}
          user={{ pubkey, profile, lastActive: 0 }}
          isFollowing={false}
          onFollow={() => {}}
          onUnfollow={() => {}}
          onBack={() => (window.history.length > 1 ? navigate(-1) : navigate('/search'))}
          guest
        />
      )}
    </Shell>
  );
}

function decodeNoteId(raw: string): EventPointer | null {
  const s = raw.trim().replace(/^nostr:/i, '').toLowerCase();
  if (/^[0-9a-f]{64}$/.test(s)) return { type: 'id', id: s };
  try {
    const d = nip19.decode(s);
    if (d.type === 'note') return { type: 'id', id: d.data };
    if (d.type === 'nevent') return { type: 'id', id: d.data.id, relays: d.data.relays, author: d.data.author };
    if (d.type === 'naddr') return { type: 'addr', kind: d.data.kind, pubkey: d.data.pubkey, identifier: d.data.identifier, relays: d.data.relays };
  } catch { /* fall through */ }
  return null;
}

export function PublicNote() {
  const { id = '' } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const pointer = decodeNoteId(decodeURIComponent(id));
  const event = useNostrEvent(pointer);

  let body: ReactNode;
  if (!pointer) body = <Centered>That is not a note, nevent or event id.</Centered>;
  else if (event === undefined) body = <Centered><Loader2 className="w-5 h-5 animate-spin mb-2" />Finding the note on relays…</Centered>;
  else if (event === null) body = <Centered>Couldn't find that note on the relays we checked.</Centered>;
  else {
    const note: FeedNote = { id: event.id, pubkey: event.pubkey, content: event.content, created_at: event.created_at, tags: event.tags, kind: event.kind };
    body = (
      <div className="p-4 pb-24">
        <NoteThread note={note} profiles={new Map()} onClose={() => navigate('/search')} inline />
      </div>
    );
  }
  return <Shell>{body}</Shell>;
}

function HitRow({ hit }: { hit: PeopleHit }) {
  const p = hit.profile;
  const fresh = useProfile(p.name || p.displayName ? null : p.pubkey);
  const prof = fresh ?? p;
  const name = prof.displayName || prof.name || nip19.npubEncode(p.pubkey).slice(0, 16) + '…';
  return (
    <Link
      to={`/p/${nip19.npubEncode(p.pubkey)}`}
      className="flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-white/5 transition-colors"
    >
      <ClickableAvatar pubkey={p.pubkey} picture={prof.picture} name={name} size="xl" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <p className="text-sm font-medium truncate">{name}</p>
          {prof.nip05 && <BadgeCheck className="w-3.5 h-3.5 text-nostr flex-shrink-0" />}
        </div>
        <p className="text-xs text-gray-500 truncate">{prof.nip05 || prof.about?.slice(0, 80) || ''}</p>
      </div>
    </Link>
  );
}

export function PublicSearch() {
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState(params.get('q') ?? '');
  const [hits, setHits] = useState<PeopleHit[]>([]);
  const [busy, setBusy] = useState(false);
  const cancelRef = useRef<(() => void) | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const navigate = useNavigate();

  function run(query: string) {
    cancelRef.current?.();
    if (!query.trim()) { setHits([]); setBusy(false); return; }
    setBusy(true);
    cancelRef.current = searchPeople(query, {
      following: new Set(),
      onUpdate: (h, done) => { setHits(h); if (done) setBusy(false); },
    });
    setTimeout(() => setBusy(false), 9000);
  }

  useEffect(() => {
    const initial = params.get('q');
    if (initial) run(initial);
    return () => cancelRef.current?.();
  }, []);

  function onChange(v: string) {
    setQ(v);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      setParams(v ? { q: v } : {}, { replace: true });
      run(v);
    }, 500);
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const v = q.trim();
    // A pasted note id goes straight to the note
    if (/^(nostr:)?(note|nevent|naddr)1/i.test(v)) { navigate(`/e/${v.replace(/^nostr:/i, '')}`); return; }
    if (timer.current) clearTimeout(timer.current);
    setParams(v ? { q: v } : {}, { replace: true });
    run(v);
  }

  return (
    <Shell>
      <div className="p-4 pb-24">
        <h1 className="text-lg font-bold mb-3">Find people on Nostr</h1>
        <form onSubmit={onSubmit} className="relative mb-3">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
          <input
            value={q}
            onChange={(e) => onChange(e.target.value)}
            placeholder="Name, name@domain, npub, nprofile or hex"
            className="input-field pl-9 pr-10 text-sm w-full"
            autoFocus
          />
          {busy && <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 animate-spin text-gray-500" />}
        </form>
        {!q.trim() && <p className="text-xs text-gray-500 px-1">Searches NIP-50 relays, NIP-05 addresses and pasted keys.</p>}
        {q.trim() && !busy && hits.length === 0 && <p className="text-xs text-gray-500 px-1">Nobody found.</p>}
        <div className="space-y-0.5">
          {hits.slice(0, 50).map((h) => <HitRow key={h.profile.pubkey} hit={h} />)}
        </div>
      </div>
    </Shell>
  );
}
