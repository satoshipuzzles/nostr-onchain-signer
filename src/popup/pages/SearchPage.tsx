import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Search, Loader2, Wallet, ArrowRightLeft, Zap, User, FileText, Hash, X, ChevronRight, BadgeCheck } from 'lucide-react';
import { useAuth } from '@/popup/context/AuthContext';
import { parseSearchQuery, noteFilters, searchRelaysFor, type SearchTarget } from '@/lib/nostr/search';
import { searchPeople, type PeopleHit } from '@/lib/nostr/people-search';
import { streamQuery, getViewerReadRelays, DEFAULT_RELAYS, INDEXER_RELAYS, type NEvent } from '@/lib/nostr/query';
import { decodeInvoice } from '@/lib/nostr/lightning-chain';
import { primeEvent } from '@/lib/nostr/nostr-store';
import { type FeedNote } from '@/lib/nostr/feed';
import { type ProfileMetadata } from '@/lib/nostr/social';
import { pubkeyToNpub } from '@/lib/nostr/keys';
import { NoteCard } from '@/popup/components/NoteCard';
import { NoteThread } from '@/popup/components/NoteThread';
import { ClickableAvatar } from '@/popup/components/ClickableAvatar';

/**
 * One search box for everything: npub / nprofile / note / nevent / naddr / hex keys and ids,
 * NIP-05 names and Lightning addresses, Bitcoin addresses and transaction ids on either chain,
 * Lightning invoices, #hashtags, and free text (people and notes across Nostr via NIP-50).
 */

type Hint =
  | { kind: 'address'; address: string }
  | { kind: 'txid'; txid: string }
  | { kind: 'invoice'; invoice: string; sats: number | null; memo: string; chain: string; expired: boolean }
  | { kind: 'lnaddress'; address: string }
  | { kind: 'lnurl'; lnurl: string };

const BECH32_ADDR = /^(bc|tb|bcrt)1[02-9ac-hj-np-z]{11,87}$/i;
const BASE58_ADDR = /^[13mn2][1-9A-HJ-NP-Za-km-z]{25,39}$/;

function clean(q: string): string {
  return q.trim().replace(/^(nostr:|lightning:)/i, '').replace(/^bitcoin:([^?]+).*$/i, '$1');
}

/** The non-Nostr things a query could be. */
function bitcoinHints(raw: string): Hint[] {
  const q = clean(raw);
  const out: Hint[] = [];
  if (BECH32_ADDR.test(q) || BASE58_ADDR.test(q)) out.push({ kind: 'address', address: q });
  if (/^[0-9a-f]{64}$/i.test(q)) out.push({ kind: 'txid', txid: q.toLowerCase() });
  if (/^ln(bc|tb|bcrt)[0-9a-z]{20,}$/i.test(q)) {
    const d = decodeInvoice(q);
    out.push({
      kind: 'invoice', invoice: q.toLowerCase(),
      sats: d?.amountMsats != null ? Math.floor(d.amountMsats / 1000) : null,
      memo: d?.description || '', chain: d?.chain === 'xbt' ? 'XBT' : 'BTC',
      expired: !!d && d.expiresAt * 1000 < Date.now(),
    });
  }
  if (/^lnurl1[02-9ac-hj-np-z]+$/i.test(q)) out.push({ kind: 'lnurl', lnurl: q });
  if (/^[a-z0-9._+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(q)) out.push({ kind: 'lnaddress', address: q.toLowerCase() });
  return out;
}

const toNote = (e: NEvent): FeedNote => ({ id: e.id, pubkey: e.pubkey, content: e.content, created_at: e.created_at, tags: e.tags, kind: e.kind });

const EXAMPLES = ['npub1…', 'name@domain.com', 'bc1p…', '#bitcoin', 'a txid or note id', 'lnbc… invoice', 'any words'];

export function SearchPage() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const { following } = useAuth();
  const [input, setInput] = useState(params.get('q') || '');
  const q = params.get('q') || '';
  const inputRef = useRef<HTMLInputElement>(null);

  const [people, setPeople] = useState<PeopleHit[]>([]);
  const [peopleDone, setPeopleDone] = useState(true);
  const [notes, setNotes] = useState<FeedNote[]>([]);
  const [notesDone, setNotesDone] = useState(true);
  const [thread, setThread] = useState<FeedNote | null>(null);

  const target: SearchTarget | null = useMemo(() => (q ? parseSearchQuery(clean(q)) : null), [q]);
  const hints = useMemo(() => (q ? bitcoinHints(q) : []), [q]);
  const isBitcoinOnly = hints.some((h) => h.kind === 'address' || h.kind === 'invoice' || h.kind === 'lnurl');

  useEffect(() => { if (!q) inputRef.current?.focus(); }, [q]);
  // an npub / nprofile link goes straight to the profile
  useEffect(() => { if (target?.type === 'profile') navigate(`/discover/${target.pubkey}`, { replace: true }); }, [target, navigate]);
  useEffect(() => { setInput(q); }, [q]);

  // people: keys, NIP-05 names, follows and NIP-50 search
  useEffect(() => {
    setPeople([]);
    if (!q || !target || isBitcoinOnly || target.type === 'event' || target.type === 'addr' || target.type === 'hashtag') { setPeopleDone(true); return; }
    setPeopleDone(false);
    const query = target.type === 'hex' ? target.hex : clean(q);
    return searchPeople(query, {
      following: following instanceof Set ? following : new Set(),
      onUpdate: (hits, done) => { setPeople(hits.slice(0, 12)); if (done) setPeopleDone(true); },
    });
  }, [q, target, isBitcoinOnly, following]);

  // notes: an event by id, an addressable event, a hashtag, or full-text
  useEffect(() => {
    setNotes([]);
    if (!q || !target || isBitcoinOnly || target.type === 'profile') { setNotesDone(true); return; }
    if (target.type === 'text' && clean(q).length < 3) { setNotesDone(true); return; }
    setNotesDone(false);
    let stop: (() => void) | null = null;
    let live = true;
    getViewerReadRelays().then((read) => {
      if (!live) return;
      const relays = target.type === 'hex' || target.type === 'event' || target.type === 'addr'
        ? [...new Set([...searchRelaysFor(target, read), ...DEFAULT_RELAYS, ...INDEXER_RELAYS])]
        : searchRelaysFor(target, read);
      const found = new Map<string, NEvent>();
      let timer: ReturnType<typeof setTimeout> | null = null;
      const flush = () => { timer = null; setNotes([...found.values()].sort((a, b) => b.created_at - a.created_at).map(toNote)); };
      stop = streamQuery({
        relays,
        filters: noteFilters(target, 40),
        timeoutMs: 9000,
        onEvent: (e) => { if (e.kind === 0 || e.kind === 3) return; primeEvent(e); found.set(e.id, e); if (!timer) timer = setTimeout(flush, 200); },
        onDone: () => { if (timer) clearTimeout(timer); flush(); setNotesDone(true); },
      });
    });
    return () => { live = false; stop?.(); };
  }, [q, target, isBitcoinOnly]);

  function submit(e?: React.FormEvent) {
    e?.preventDefault();
    const v = input.trim();
    if (!v) return;
    // a single, certain match goes straight there
    const t = parseSearchQuery(clean(v));
    if (t?.type === 'profile') { navigate(`/discover/${t.pubkey}`); return; }
    setParams({ q: v });
  }

  const profileMap = useMemo(() => new Map<string, ProfileMetadata>(people.map((p) => [p.profile.pubkey, p.profile])), [people]);
  const searching = !peopleDone || !notesDone;
  const nothing = q && !searching && !people.length && !notes.length && !hints.length && target?.type !== 'hashtag';

  const card = (key: string, icon: React.ReactNode, title: string, sub: string, onClick: () => void) => (
    <button key={key} onClick={onClick} className="w-full card flex items-center gap-3 text-left hover:border-purple-500/40 transition-colors mb-2">
      <span className="w-9 h-9 rounded-xl bg-white/5 flex items-center justify-center flex-shrink-0">{icon}</span>
      <span className="flex-1 min-w-0">
        <span className="block text-sm font-semibold text-white">{title}</span>
        <span className="block text-[11px] text-gray-400 truncate font-mono">{sub}</span>
      </span>
      <ChevronRight className="w-4 h-4 text-gray-500 flex-shrink-0" />
    </button>
  );
  const short = (s: string) => (s.length > 26 ? `${s.slice(0, 14)}…${s.slice(-8)}` : s);

  return (
    <div className="min-h-full flex flex-col p-4 md:p-6 max-w-3xl">
      <form onSubmit={submit} className="sticky top-0 z-10 -mx-4 px-4 md:mx-0 md:px-0 pt-1 pb-3 bg-surface-900/95 backdrop-blur">
        <div className="flex items-center gap-2 rounded-2xl border border-white/15 bg-white/[0.04] focus-within:border-purple-400/60 px-3">
          <Search className="w-5 h-5 text-gray-400 flex-shrink-0" />
          <input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Search Nostr and Bitcoin"
            enterKeyHint="search"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            className="flex-1 min-w-0 bg-transparent py-3 text-[15px] outline-none placeholder-gray-500"
          />
          {searching && <Loader2 className="w-4 h-4 text-gray-400 animate-spin" />}
          {input && <button type="button" onClick={() => { setInput(''); setParams({}); inputRef.current?.focus(); }} aria-label="Clear" className="p-1 text-gray-500 hover:text-white"><X className="w-4 h-4" /></button>}
        </div>
      </form>

      {!q && (
        <div className="text-sm text-gray-400 pt-2">
          <p className="mb-3">Search people, notes, keys, hashtags, Bitcoin addresses, transactions and Lightning invoices, on XBT and BTC.</p>
          <div className="flex flex-wrap gap-1.5">
            {EXAMPLES.map((x) => <span key={x} className="text-[11px] font-mono px-2.5 py-1 rounded-full bg-white/5 border border-white/10 text-gray-400">{x}</span>)}
          </div>
        </div>
      )}

      {/* Bitcoin and Lightning */}
      {hints.length > 0 && (
        <section className="mb-3">
          <p className="text-[10px] text-gray-500 uppercase tracking-wider px-1 mb-2">Bitcoin &amp; Lightning</p>
          {hints.map((h) => {
            if (h.kind === 'address') return [
              card('ax', <Wallet className="w-4 h-4 text-purple-300" />, 'Address on XBT', short(h.address), () => navigate(`/explorer?tab=address&chain=xbt&addr=${encodeURIComponent(h.address)}`)),
              card('ab', <Wallet className="w-4 h-4 text-bitcoin" />, 'Address on BTC', short(h.address), () => navigate(`/explorer?tab=address&chain=btc&addr=${encodeURIComponent(h.address)}`)),
            ];
            if (h.kind === 'txid') return [
              card('tx', <ArrowRightLeft className="w-4 h-4 text-purple-300" />, 'Transaction on XBT', short(h.txid), () => navigate(`/explorer?tab=transaction&chain=xbt&txid=${h.txid}`)),
              card('tb', <ArrowRightLeft className="w-4 h-4 text-bitcoin" />, 'Transaction on BTC', short(h.txid), () => navigate(`/explorer?tab=transaction&chain=btc&txid=${h.txid}`)),
            ];
            if (h.kind === 'invoice') return card('inv', <Zap className="w-4 h-4 text-amber-300" />,
              `${h.chain} Lightning invoice${h.sats != null ? ` · ${h.sats.toLocaleString()} sats` : ''}${h.expired ? ' · expired' : ''}`,
              h.memo || short(h.invoice), () => navigate(`/lightning?pay=${encodeURIComponent(h.invoice)}`));
            if (h.kind === 'lnurl') return card('lnurl', <Zap className="w-4 h-4 text-amber-300" />, 'LNURL', short(h.lnurl), () => navigate(`/lightning?pay=${encodeURIComponent(h.lnurl)}`));
            return card('lna', <Zap className="w-4 h-4 text-amber-300" />, 'Pay this Lightning address', h.address, () => navigate(`/lightning?pay=${encodeURIComponent(h.address)}`));
          })}
        </section>
      )}

      {target?.type === 'hashtag' && card('tag', <Hash className="w-4 h-4 text-purple-300" />, `Open #${target.tag} in the feed`, 'Live hashtag feed', () => navigate(`/feed?tag=${encodeURIComponent(target.tag)}`))}

      {/* People */}
      {people.length > 0 && (
        <section className="mb-3">
          <p className="text-[10px] text-gray-500 uppercase tracking-wider px-1 mb-2 flex items-center gap-1"><User className="w-3 h-3" /> People</p>
          <div className="card p-1">
            {people.map((h) => {
              const p = h.profile;
              const name = p.displayName || p.name || pubkeyToNpub(p.pubkey).slice(0, 14) + '…';
              return (
                <button key={p.pubkey} onClick={() => navigate(`/discover/${p.pubkey}`)} className="w-full flex items-center gap-3 px-2.5 py-2 rounded-xl hover:bg-white/5 text-left">
                  <ClickableAvatar pubkey={p.pubkey} picture={p.picture} name={name} size="md" />
                  <span className="flex-1 min-w-0">
                    <span className="flex items-center gap-1 text-sm font-medium text-white truncate">{name}{h.following && <BadgeCheck className="w-3.5 h-3.5 text-purple-300 flex-shrink-0" aria-label="You follow" />}</span>
                    <span className="block text-[11px] text-gray-500 truncate">{p.nip05 || (p.about || '').slice(0, 80)}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </section>
      )}

      {/* Notes */}
      {notes.length > 0 && (
        <section className="mb-3">
          <p className="text-[10px] text-gray-500 uppercase tracking-wider px-1 mb-2 flex items-center gap-1"><FileText className="w-3 h-3" /> {target?.type === 'text' ? 'Notes' : target?.type === 'hashtag' ? `#${target.tag}` : 'Event'}</p>
          {notes.map((n) => (
            <div key={n.id} className="py-2 border-b border-white/5">
              <NoteCard note={n} profile={profileMap.get(n.pubkey)} onSelectNote={setThread} onViewProfile={(pk) => navigate(`/discover/${pk}`)} />
            </div>
          ))}
        </section>
      )}

      {nothing && <p className="text-sm text-gray-500 text-center py-10">Nothing found. Try a full npub, a NIP-05 address, or different words.</p>}

      {thread && <NoteThread note={thread} profiles={profileMap} onClose={() => setThread(null)} onViewProfile={(pk) => { setThread(null); navigate(`/discover/${pk}`); }} />}
    </div>
  );
}
