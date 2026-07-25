import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, MessageCircle, Heart, Zap, ExternalLink, Copy, Check } from 'lucide-react';
import { nip19, type Event } from 'nostr-tools';
import { anchorsForTxid, type AnchorRecord } from '../lib/scanner';
import {
  resolveAnchoredEvent,
  fetchProfile,
  fetchProfiles,
  fetchInteractions,
  publishReply,
  publishReaction,
  requestZapInvoice,
  payWithWebLn,
  getLogin,
  timeAgo,
  type Profile,
  type VerificationStatus,
  type Interactions,
} from '../lib/nostr';
import { AnchorCard, ProfileChip, VerifiedBadge, ChainFooter } from '../components/AnchorCard';
import { NoteContent } from '../components/NoteContent';

export function TxPage() {
  const { txid } = useParams();
  const [anchors, setAnchors] = useState<AnchorRecord[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!txid) return;
    anchorsForTxid(txid)
      .then(setAnchors)
      .catch((err) => setError(err instanceof Error ? err.message : 'Transaction not found'));
  }, [txid]);

  return (
    <div className="space-y-4">
      <Link to="/" className="btn-ghost text-xs -ml-2">
        <ArrowLeft size={14} /> Feed
      </Link>

      {error && <p className="text-red-400 text-sm">{error}</p>}
      {!anchors && !error && <div className="card h-40 animate-pulse" />}

      {anchors && anchors.length === 0 && (
        <div className="card p-6 text-sm text-zinc-400">
          This transaction has no Nostr-onchain OP_RETURN data.{' '}
          <a className="text-bitcoin underline" href={`https://mempool.space/tx/${txid}`} target="_blank" rel="noreferrer">
            View raw on mempool.space
          </a>
        </div>
      )}

      {anchors?.map((anchor) =>
        anchor.protocol === 'NSTR' && anchor.nostrEventId ? (
          <NstrDetail key={anchor.id} anchor={anchor} />
        ) : (
          <AnchorCard key={anchor.id} anchor={anchor} />
        )
      )}

      {txid && (
        <a
          className="btn-ghost text-xs"
          href={`https://mempool.space/tx/${txid}`}
          target="_blank"
          rel="noreferrer"
        >
          <ExternalLink size={13} /> Raw transaction on mempool.space
        </a>
      )}
    </div>
  );
}

function NstrDetail({ anchor }: { anchor: AnchorRecord }) {
  const [event, setEvent] = useState<Event | null>(null);
  const [status, setStatus] = useState<VerificationStatus | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [interactions, setInteractions] = useState<Interactions | null>(null);
  const [replyProfiles, setReplyProfiles] = useState<Map<string, Profile>>(new Map());
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [zapInvoice, setZapInvoice] = useState('');
  const [copied, setCopied] = useState(false);
  const loggedIn = !!getLogin();

  async function loadInteractions(eventId: string) {
    const ix = await fetchInteractions(eventId);
    setInteractions(ix);
    const pubkeys = ix.replies.map((r) => r.pubkey);
    if (pubkeys.length) setReplyProfiles(await fetchProfiles(pubkeys));
  }

  useEffect(() => {
    let alive = true;
    (async () => {
      const resolved = await resolveAnchoredEvent(anchor.nostrEventId!, anchor.scriptHex);
      if (!alive) return;
      setEvent(resolved.event);
      setStatus(resolved.status);
      if (resolved.event) {
        fetchProfile(resolved.event.pubkey).then((p) => alive && setProfile(p));
        loadInteractions(resolved.event.id);
      }
    })();
    return () => {
      alive = false;
    };
  }, [anchor]);

  async function handleReply(e: React.FormEvent) {
    e.preventDefault();
    if (!event || !reply.trim()) return;
    setBusy(true);
    setNotice('');
    try {
      await publishReply(event, reply.trim());
      setReply('');
      setNotice('Comment published');
      await loadInteractions(event.id);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Failed to publish');
    } finally {
      setBusy(false);
    }
  }

  async function handleReact() {
    if (!event) return;
    setBusy(true);
    setNotice('');
    try {
      await publishReaction(event);
      setNotice('Reaction published');
      await loadInteractions(event.id);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Failed to react');
    } finally {
      setBusy(false);
    }
  }

  async function handleZap(amountSats: number) {
    if (!event || !profile?.lud16) {
      setNotice('Author has no lightning address in their profile');
      return;
    }
    setBusy(true);
    setNotice('');
    try {
      const { invoice } = await requestZapInvoice(event, profile.lud16, amountSats);
      const paid = await payWithWebLn(invoice);
      if (paid) {
        setNotice(`Zapped ${amountSats} sats ⚡`);
        setTimeout(() => event && loadInteractions(event.id), 3000);
      } else {
        setZapInvoice(invoice);
      }
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Zap failed');
    } finally {
      setBusy(false);
    }
  }

  const noteId = event ? nip19.noteEncode(event.id) : null;

  return (
    <div className="space-y-4">
      <div className="card p-5 space-y-4">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-semibold text-nostr">Nostr note · kind {anchor.nostrKind}</span>
          {status && <VerifiedBadge status={status} />}
        </div>

        {event ? (
          <>
            <ProfileChip profile={profile} time={event.created_at} />
            <NoteContent content={event.content} />
            {noteId && (
              <button
                className="text-[11px] text-zinc-500 font-mono hover:text-nostr flex items-center gap-1"
                onClick={() => {
                  navigator.clipboard.writeText(noteId);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                }}
              >
                {noteId.slice(0, 28)}… {copied ? <Check size={11} className="text-green-400" /> : <Copy size={11} />}
              </button>
            )}
          </>
        ) : status === 'missing' ? (
          <p className="text-sm text-zinc-500">
            Anchored event <span className="font-mono">{anchor.nostrEventId?.slice(0, 20)}…</span> was not found on the
            relays we queried. The proof lives on-chain regardless.
          </p>
        ) : (
          <div className="h-20 rounded-xl bg-ink-overlay animate-pulse" />
        )}

        <ChainFooter anchor={anchor} />

        {/* Action bar */}
        {event && (
          <div className="flex items-center gap-4 border-t border-zinc-800 pt-3 text-sm text-zinc-400">
            <span className="inline-flex items-center gap-1.5">
              <MessageCircle size={16} /> {interactions?.replies.length ?? '–'}
            </span>
            <button className="inline-flex items-center gap-1.5 hover:text-red-400 disabled:opacity-40" onClick={handleReact} disabled={!loggedIn || busy} title={loggedIn ? 'React' : 'Login to react'}>
              <Heart size={16} /> {interactions?.reactions.length ?? '–'}
            </button>
            <div className="inline-flex items-center gap-1.5 text-amber-300">
              <Zap size={16} /> {interactions ? `${interactions.zapTotalSats.toLocaleString()} sats` : '–'}
            </div>
            <div className="flex-1" />
            {[21, 210, 2100].map((amt) => (
              <button key={amt} className="btn-ghost text-xs px-2 text-amber-300 disabled:opacity-40" onClick={() => handleZap(amt)} disabled={busy || !profile?.lud16} title={profile?.lud16 ? `Zap ${amt} sats` : 'Author has no lightning address'}>
                ⚡{amt}
              </button>
            ))}
          </div>
        )}
        {notice && <p className="text-xs text-zinc-300">{notice}</p>}
        {zapInvoice && (
          <div className="card p-3 space-y-2 border-amber-500/40">
            <p className="text-xs text-zinc-400">Pay this invoice with any lightning wallet:</p>
            <div className="font-mono text-[10px] break-all text-amber-200">{zapInvoice}</div>
            <div className="flex gap-2">
              <a className="btn-bitcoin text-xs" href={`lightning:${zapInvoice}`}>Open wallet</a>
              <button className="btn-ghost text-xs" onClick={() => navigator.clipboard.writeText(zapInvoice)}>Copy</button>
              <button className="btn-ghost text-xs" onClick={() => setZapInvoice('')}>Close</button>
            </div>
          </div>
        )}
      </div>

      {/* Comments */}
      {event && (
        <div className="space-y-3">
          <h2 className="text-sm font-semibold text-zinc-300">Comments</h2>
          {loggedIn ? (
            <form onSubmit={handleReply} className="flex gap-2">
              <input className="input flex-1" placeholder="Add a comment…" value={reply} onChange={(e) => setReply(e.target.value)} />
              <button type="submit" className="btn-nostr text-xs" disabled={busy || !reply.trim()}>
                Post
              </button>
            </form>
          ) : (
            <p className="text-xs text-zinc-500">Login with a NIP-07 extension to comment, react, and zap.</p>
          )}
          {interactions?.replies.map((r) => (
            <div key={r.id} className="card p-3.5 space-y-2">
              <ProfileChip profile={replyProfiles.get(r.pubkey) ?? null} time={r.created_at} />
              <NoteContent content={r.content} />
            </div>
          ))}
          {interactions && interactions.replies.length === 0 && (
            <p className="text-xs text-zinc-600">No comments yet — be first. {timeAgo(event.created_at)} old and immortal.</p>
          )}
        </div>
      )}
    </div>
  );
}
