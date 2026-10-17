import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { X, Copy, Check, BadgeCheck, Zap, Globe, Loader2, ExternalLink, MessageCircle, Bitcoin, VolumeX, Volume2, Ban } from 'lucide-react';
import { toast } from 'sonner';
import { pubkeyToNpub } from '@/lib/nostr/keys';
import { type ProfileMetadata } from '@/lib/nostr/social';
import { getCachedProfile } from '@/lib/nostr/cache';
import { type FeedNote } from '@/lib/nostr/feed';
import { streamQuery, relaysForAuthor } from '@/lib/nostr/query';
import { parentOf } from '@/lib/nostr/thread';
import { primeEvent, requestProfiles, getProfileSync, onProfile } from '@/lib/nostr/nostr-store';
import { parseZapReceipt } from '@/lib/nostr/zap';
import { ZapDialog } from './ZapDialog';
import { NoteContent, SelectNoteContext } from './NoteContent';
import { isMuted, mutePubkey, unmutePubkey } from '@/lib/nostr/mute';
import { pubkeyToTaprootAddress } from '@/lib/bitcoin/address';
import { safeImageUrl, safeHttpUrl } from '@/lib/utils';
import { AuthContext } from '@/popup/context/AuthContext';
import { useContext } from 'react';
import { NoteCard } from './NoteCard';
import { NoteThread } from './NoteThread';

// In-memory cache so reopening a profile shows notes instantly
const notesCache = new Map<string, FeedNote[]>();

interface Props {
  pubkey: string;
  onClose: () => void;
}

function formatTimeAgo(timestamp: number): string {
  const now = Math.floor(Date.now() / 1000);
  const diff = now - timestamp;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d`;
  return new Date(timestamp * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function ProfilePopup({ pubkey, onClose }: Props) {
  const auth = useContext(AuthContext);
  const navigate = useNavigate();
  const [profile, setProfile] = useState<ProfileMetadata | null>(null);
  const [notes, setNotes] = useState<FeedNote[]>([]);
  const [loadingProfile, setLoadingProfile] = useState(true);
  const [loadingNotes, setLoadingNotes] = useState(true);
  const [copied, setCopied] = useState('');
  const [muted, setMuted] = useState(false);
  const [followBusy, setFollowBusy] = useState(false);
  const [threadNote, setThreadNote] = useState<FeedNote | null>(null);
  const [showZap, setShowZap] = useState(false);
  const [zapTotal, setZapTotal] = useState(0);
  const cleanupRef = useRef<(() => void) | null>(null);

  const npub = pubkeyToNpub(pubkey);
  const isFollowing = auth?.following.has(pubkey) ?? false;
  const isSelf = auth?.publicKey === pubkey;

  // Onchain address derived from their Nostr key (same derivation the app
  // uses for its own wallets) — always available
  let derivedAddress: string | null = null;
  try { derivedAddress = pubkeyToTaprootAddress(pubkey); } catch { /* invalid pubkey */ }

  const displayName = profile?.displayName || profile?.name || pubkey.slice(0, 8) + '...';

  useEffect(() => {
    isMuted(pubkey).then(setMuted).catch(() => {});
  }, [pubkey]);

  async function copy(text: string, label: string) {
    await navigator.clipboard.writeText(text);
    setCopied(label);
    setTimeout(() => setCopied(''), 2000);
  }

  function openMessages() {
    onClose();
    navigate(`/messages?to=${pubkey}`);
  }

  function openSendBitcoin() {
    onClose();
    try {
      const address = pubkeyToTaprootAddress(pubkey);
      navigate(`/send?to=${address}`);
    } catch {
      navigate('/send');
    }
  }

  function openZap() {
    setShowZap(true);
  }

  async function toggleMute() {
    if (!auth) return;
    try {
      if (muted) {
        await unmutePubkey(pubkey, auth.publicKey);
        setMuted(false);
        toast.success(`Unmuted ${displayName}`);
      } else {
        await mutePubkey(pubkey, auth.publicKey);
        setMuted(true);
        toast.success(`Muted ${displayName} — their notes are hidden from your feed`);
      }
    } catch {
      toast.error('Failed to update mute list');
    }
  }

  async function handleBlock() {
    if (!auth) return;
    if (!confirm(`Block ${displayName}? This mutes them and unfollows them.`)) return;
    try {
      await mutePubkey(pubkey, auth.publicKey);
      setMuted(true);
      if (isFollowing) await auth.handleUnfollow(pubkey);
      toast.success(`Blocked ${displayName}`);
      onClose();
    } catch {
      toast.error('Failed to block');
    }
  }

  useEffect(() => {
    let cancelled = false;
    setLoadingProfile(true);
    setProfile(getProfileSync(pubkey) ?? null);

    getCachedProfile(pubkey).then((cached) => {
      if (cached && !cancelled && !getProfileSync(pubkey)) {
        setProfile(cached);
        setLoadingProfile(false);
      }
    }).catch(() => {});

    // Shared batched store: kind 0 from indexers, defaults and the cloud fallback
    const off = onProfile(pubkey, () => {
      const p = getProfileSync(pubkey);
      if (p && !cancelled) { setProfile(p); setLoadingProfile(false); }
    });
    requestProfiles([pubkey]);
    const t = setTimeout(() => { if (!cancelled) setLoadingProfile(false); }, 7000);
    return () => { cancelled = true; off(); clearTimeout(t); };
  }, [pubkey]);

  // Zap total from receipts
  useEffect(() => {
    setZapTotal(0);
    let cancel: (() => void) | null = null;
    let live = true;
    relaysForAuthor(pubkey, { inbox: true }).then((relays) => {
      if (!live) return;
      const seen = new Set<string>();
      let total = 0;
      cancel = streamQuery({
        relays,
        filters: [{ kinds: [9735], '#p': [pubkey], limit: 300 }],
        timeoutMs: 9000,
        onEvent: (e) => {
          const z = parseZapReceipt(e);
          if (!z || z.recipient !== pubkey || seen.has(z.id)) return;
          seen.add(z.id);
          total += z.amountSats;
          if (live) setZapTotal(total);
        },
      });
    });
    return () => { live = false; cancel?.(); };
  }, [pubkey]);

  useEffect(() => {
    cleanupRef.current?.();
    cleanupRef.current = null;

    // Show cached notes instantly while fresh ones stream in
    const cached = notesCache.get(pubkey);
    setNotes(cached ?? []);
    setLoadingNotes(!cached);

    async function loadNotes() {
      // Outbox model: the author's write relays, then the viewer's and defaults
      const relayUrls = await relaysForAuthor(pubkey);
      const collected = new Map<string, FeedNote>();
      let flushTimer: ReturnType<typeof setTimeout> | null = null;

      // Stream notes in as they arrive instead of waiting for EOSE
      function flush() {
        const sorted = Array.from(collected.values()).sort((a, b) => b.created_at - a.created_at);
        notesCache.set(pubkey, sorted);
        setNotes(sorted);
        if (sorted.length) setLoadingNotes(false);
      }

      const cleanup = streamQuery({
        relays: relayUrls,
        filters: [{ kinds: [1], authors: [pubkey], limit: 40 }],
        timeoutMs: 9000,
        onEvent: (event) => {
          if (event.pubkey !== pubkey || parentOf(event) || collected.has(event.id)) return;
          primeEvent(event);
          collected.set(event.id, {
            id: event.id,
            pubkey: event.pubkey,
            content: event.content,
            created_at: event.created_at,
            tags: event.tags,
            kind: event.kind,
          });
          if (!flushTimer) flushTimer = setTimeout(() => { flushTimer = null; flush(); }, 250);
        },
        onDone: () => {
          if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
          flush();
          setLoadingNotes(false);
        },
      });
      cleanupRef.current = () => {
        if (flushTimer) clearTimeout(flushTimer);
        cleanup();
      };
    }

    loadNotes();
    return () => {
      cleanupRef.current?.();
      cleanupRef.current = null;
    };
  }, [pubkey]);

  return (
    <div
      className="fixed inset-0 bg-black/70 flex items-end sm:items-center justify-center z-[60] p-0 sm:p-4"
      onClick={onClose}
    >
      <div
        className="bg-surface-900 rounded-t-2xl sm:rounded-2xl border border-surface-200/10 w-full max-w-md max-h-[90vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header bar */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-surface-200/10 flex-shrink-0">
          <h3 className="text-sm font-semibold text-white">Profile</h3>
          <button
            onClick={onClose}
            className="text-gray-500 hover:text-white transition-colors p-1"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="overflow-y-auto flex-1">
          {/* Profile info */}
          <div className="px-4 pt-4 pb-3">
            {loadingProfile && !profile ? (
              <div className="flex items-center gap-3 mb-4">
                <div className="w-14 h-14 rounded-full bg-surface-700 animate-pulse" />
                <div className="flex-1 space-y-2">
                  <div className="h-4 w-32 bg-surface-700 rounded animate-pulse" />
                  <div className="h-3 w-24 bg-surface-700 rounded animate-pulse" />
                </div>
              </div>
            ) : (
              <div className="flex items-start gap-3 mb-3">
                {profile?.picture ? (
                  <img
                    src={safeImageUrl(profile.picture)}
                    alt=""
                    className="w-14 h-14 rounded-full object-cover bg-surface-700 flex-shrink-0"
                  />
                ) : (
                  <div className="w-14 h-14 rounded-full bg-gradient-to-br from-bitcoin/40 to-nostr/40 flex items-center justify-center flex-shrink-0">
                    <span className="text-lg font-bold text-white/80">
                      {displayName.charAt(0).toUpperCase()}
                    </span>
                  </div>
                )}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <h2 className="text-base font-bold truncate">{displayName}</h2>
                    {profile?.nip05 && <BadgeCheck className="w-3.5 h-3.5 text-nostr flex-shrink-0" />}
                  </div>
                  {profile?.nip05 && (
                    <p className="text-xs text-nostr/80 truncate">{profile.nip05}</p>
                  )}
                  {profile?.about && (
                    <p className="text-xs text-gray-400 mt-1 leading-relaxed line-clamp-3 break-words">
                      <NoteContent content={profile.about} depth={1} stripImages={false} />
                    </p>
                  )}
                  {zapTotal > 0 && (
                    <p className="text-[11px] text-yellow-500 mt-1 flex items-center gap-1">
                      <Zap className="w-3 h-3" /> {zapTotal.toLocaleString()} sats zapped to them
                    </p>
                  )}
                </div>
              </div>
            )}

            {/* Metadata pills */}
            {profile && (profile.lud16 || profile.lud16Xbt || profile.website) && (
              <div className="flex flex-wrap gap-1.5 mb-3">
                {profile.lud16Xbt && (
                  <span className="flex items-center gap-1 text-[10px] bg-purple-500/10 text-purple-300 px-2 py-0.5 rounded-full">
                    <Zap className="w-2.5 h-2.5" /> XBT {profile.lud16Xbt}
                  </span>
                )}
                {profile.lud16 && (
                  <span className="flex items-center gap-1 text-[10px] bg-yellow-500/10 text-yellow-400 px-2 py-0.5 rounded-full">
                    <Zap className="w-2.5 h-2.5" /> {profile.lud16}
                  </span>
                )}
                {profile.website && (
                  <a
                    href={safeHttpUrl(profile.website)}
                    target="_blank"
                    rel="noopener"
                    className="flex items-center gap-1 text-[10px] bg-surface-700 text-gray-400 px-2 py-0.5 rounded-full hover:text-white"
                  >
                    <Globe className="w-2.5 h-2.5" /> {profile.website.replace(/^https?:\/\//, '')}
                  </a>
                )}
              </div>
            )}

            {/* npub — easily copyable */}
            <div className="bg-surface-800 rounded-xl p-3 mb-2 border border-surface-200/10">
              <p className="text-[10px] text-gray-500 mb-1 uppercase tracking-wide">npub</p>
              <div className="flex items-center gap-2">
                <code className="text-xs text-gray-200 flex-1 font-mono break-all leading-relaxed select-all">
                  {npub}
                </code>
                <button
                  onClick={() => copy(npub, 'npub')}
                  className="p-1.5 hover:bg-surface-700 rounded-lg flex-shrink-0 transition-colors"
                  title="Copy npub"
                >
                  {copied === 'npub'
                    ? <Check className="w-3.5 h-3.5 text-green-400" />
                    : <Copy className="w-3.5 h-3.5 text-gray-500" />}
                </button>
              </div>
            </div>

            {/* Hex pubkey */}
            <div className="bg-surface-800 rounded-xl p-3 mb-2 border border-surface-200/10">
              <p className="text-[10px] text-gray-500 mb-1 uppercase tracking-wide">Hex pubkey</p>
              <div className="flex items-center gap-2">
                <code className="text-[10px] text-gray-400 flex-1 font-mono break-all leading-relaxed select-all">
                  {pubkey}
                </code>
                <button
                  onClick={() => copy(pubkey, 'hex')}
                  className="p-1.5 hover:bg-surface-700 rounded-lg flex-shrink-0 transition-colors"
                  title="Copy hex pubkey"
                >
                  {copied === 'hex'
                    ? <Check className="w-3.5 h-3.5 text-green-400" />
                    : <Copy className="w-3.5 h-3.5 text-gray-500" />}
                </button>
              </div>
            </div>

            {/* Onchain Bitcoin address (derived from Nostr key) */}
            {derivedAddress && (
              <div className="bg-bitcoin/5 rounded-xl p-3 mb-2 border border-bitcoin/20">
                <p className="text-[10px] text-bitcoin/80 mb-1 uppercase tracking-wide flex items-center gap-1">
                  <Bitcoin className="w-3 h-3" /> Bitcoin address (taproot)
                </p>
                <div className="flex items-center gap-2">
                  <code className="text-[10px] text-gray-300 flex-1 font-mono break-all leading-relaxed select-all">
                    {derivedAddress}
                  </code>
                  <button
                    onClick={() => copy(derivedAddress!, 'btc')}
                    className="p-1.5 hover:bg-surface-700 rounded-lg flex-shrink-0 transition-colors"
                    title="Copy Bitcoin address"
                  >
                    {copied === 'btc'
                      ? <Check className="w-3.5 h-3.5 text-green-400" />
                      : <Copy className="w-3.5 h-3.5 text-gray-500" />}
                  </button>
                </div>
                <p className="text-[9px] text-gray-600 mt-1">Derived from their Nostr key — spendable with their nsec</p>
              </div>
            )}

            {/* Declared Bitcoin address from profile metadata */}
            {profile?.bitcoinAddress && profile.bitcoinAddress !== derivedAddress && (
              <div className="bg-surface-800 rounded-xl p-3 mb-2 border border-surface-200/10">
                <p className="text-[10px] text-gray-500 mb-1 uppercase tracking-wide">Declared Bitcoin address</p>
                <div className="flex items-center gap-2">
                  <code className="text-[10px] text-gray-300 flex-1 font-mono break-all leading-relaxed select-all">
                    {profile.bitcoinAddress}
                  </code>
                  <button
                    onClick={() => copy(profile.bitcoinAddress!, 'btc2')}
                    className="p-1.5 hover:bg-surface-700 rounded-lg flex-shrink-0 transition-colors"
                    title="Copy address"
                  >
                    {copied === 'btc2'
                      ? <Check className="w-3.5 h-3.5 text-green-400" />
                      : <Copy className="w-3.5 h-3.5 text-gray-500" />}
                  </button>
                </div>
              </div>
            )}

            {/* Silent payment address (BIP-352) */}
            {profile?.silentPaymentAddress && (
              <div className="bg-purple-500/5 rounded-xl p-3 mb-2 border border-purple-500/20">
                <p className="text-[10px] text-purple-400/80 mb-1 uppercase tracking-wide">Silent payment (BIP-352)</p>
                <div className="flex items-center gap-2">
                  <code className="text-[10px] text-gray-300 flex-1 font-mono break-all leading-relaxed select-all">
                    {profile.silentPaymentAddress}
                  </code>
                  <button
                    onClick={() => copy(profile.silentPaymentAddress!, 'sp')}
                    className="p-1.5 hover:bg-surface-700 rounded-lg flex-shrink-0 transition-colors"
                    title="Copy silent payment address"
                  >
                    {copied === 'sp'
                      ? <Check className="w-3.5 h-3.5 text-green-400" />
                      : <Copy className="w-3.5 h-3.5 text-gray-500" />}
                  </button>
                </div>
                <p className="text-[9px] text-gray-600 mt-1">Pay with a silent-payment-capable wallet for maximum privacy</p>
              </div>
            )}
            <div className="mb-1" />

            {/* Primary actions */}
            <div className="flex gap-2 mb-2">
              {auth && !isSelf && (
                <button
                  disabled={followBusy}
                  onClick={async () => {
                    setFollowBusy(true);
                    try {
                      await (isFollowing ? auth.handleUnfollow(pubkey) : auth.handleFollow(pubkey));
                    } finally {
                      setFollowBusy(false);
                    }
                  }}
                  className={`flex-1 py-2 rounded-lg font-medium text-xs transition-colors disabled:opacity-60 ${
                    isFollowing
                      ? 'bg-surface-700 text-gray-300 hover:bg-red-500/20 hover:text-red-400'
                      : 'btn-nostr'
                  }`}
                >
                  {followBusy ? '…' : isFollowing ? 'Unfollow' : 'Follow'}
                </button>
              )}
              <a
                href={`https://njump.me/${npub}`}
                target="_blank"
                rel="noopener"
                className="flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs bg-surface-700 text-gray-400 hover:text-white transition-colors"
              >
                <ExternalLink className="w-3 h-3" /> njump
              </a>
            </div>

            {/* Action grid: message, send bitcoin, zap, mute, block */}
            {!isSelf && (
              <div className="grid grid-cols-5 gap-1.5">
                <button
                  onClick={openMessages}
                  className="flex flex-col items-center gap-1 py-2.5 rounded-xl bg-surface-800 hover:bg-surface-700 transition-colors"
                  title="Message"
                >
                  <MessageCircle className="w-4 h-4 text-purple-400" />
                  <span className="text-[9px] text-gray-400">Message</span>
                </button>
                <button
                  onClick={openSendBitcoin}
                  className="flex flex-col items-center gap-1 py-2.5 rounded-xl bg-surface-800 hover:bg-surface-700 transition-colors"
                  title="Send Bitcoin"
                >
                  <Bitcoin className="w-4 h-4 text-bitcoin" />
                  <span className="text-[9px] text-gray-400">Send</span>
                </button>
                <button
                  onClick={openZap}
                  className="flex flex-col items-center gap-1 py-2.5 rounded-xl bg-surface-800 hover:bg-surface-700 transition-colors"
                  title="Zap"
                >
                  <Zap className="w-4 h-4 text-yellow-400" />
                  <span className="text-[9px] text-gray-400">Zap</span>
                </button>
                <button
                  onClick={toggleMute}
                  className="flex flex-col items-center gap-1 py-2.5 rounded-xl bg-surface-800 hover:bg-surface-700 transition-colors"
                  title={muted ? 'Unmute' : 'Mute'}
                >
                  {muted
                    ? <Volume2 className="w-4 h-4 text-green-400" />
                    : <VolumeX className="w-4 h-4 text-gray-400" />}
                  <span className="text-[9px] text-gray-400">{muted ? 'Unmute' : 'Mute'}</span>
                </button>
                <button
                  onClick={handleBlock}
                  className="flex flex-col items-center gap-1 py-2.5 rounded-xl bg-surface-800 hover:bg-red-500/20 transition-colors"
                  title="Block"
                >
                  <Ban className="w-4 h-4 text-red-400" />
                  <span className="text-[9px] text-gray-400">Block</span>
                </button>
              </div>
            )}
          </div>

          {/* Kind 1 feed */}
          <div className="border-t border-surface-200/10">
            <div className="px-4 py-2.5">
              <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Notes</p>
            </div>

            {loadingNotes && notes.length === 0 ? (
              <div className="flex flex-col items-center py-8">
                <Loader2 className="w-5 h-5 text-nostr animate-spin mb-2" />
                <p className="text-xs text-gray-500">Loading notes...</p>
              </div>
            ) : notes.length === 0 ? (
              <p className="text-xs text-gray-500 text-center py-8 px-4">No notes found</p>
            ) : (
              <div className="divide-y divide-surface-200/10">
                {notes.map((note) => (
                  <div key={note.id} className="px-4 py-3">
                    <NoteCard
                      note={note}
                      profile={profile}
                      onSelectNote={(n) => setThreadNote(n)}
                      compact
                    />
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {showZap && (
        <ZapDialog recipientPubkey={pubkey} profile={profile} onClose={() => setShowZap(false)} />
      )}

      {/* Thread modal — full note with replies, react/zap/comment */}
      {threadNote && (
        <NoteThread
          note={threadNote}
          profiles={new Map(profile ? [[pubkey, profile]] : [])}
          onClose={() => setThreadNote(null)}
        />
      )}
    </div>
  );
}
