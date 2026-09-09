import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ShieldCheck, ShieldAlert, ShieldQuestion, FileCheck2, Receipt, Type, Box } from 'lucide-react';
import type { Event } from 'nostr-tools';
import type { AnchorRecord } from '../lib/scanner';
import {
  resolveAnchoredEvent,
  fetchProfile,
  timeAgo,
  type Profile,
  type VerificationStatus,
} from '../lib/nostr';
import { NoteContent } from './NoteContent';
import { useChain, chainTicker, SPLIT_HEIGHT } from '../lib/chain';

export function VerifiedBadge({ status }: { status: VerificationStatus }) {
  if (status === 'verified') {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-green-400 bg-green-400/10 rounded-full px-2 py-0.5">
        <ShieldCheck size={12} /> verified on-chain
      </span>
    );
  }
  if (status === 'mismatch') {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-red-400 bg-red-400/10 rounded-full px-2 py-0.5">
        <ShieldAlert size={12} /> hash mismatch
      </span>
    );
  }
  if (status === 'found') {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-zinc-400 bg-zinc-400/10 rounded-full px-2 py-0.5">
        <ShieldCheck size={12} /> anchored
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-amber-400 bg-amber-400/10 rounded-full px-2 py-0.5">
      <ShieldQuestion size={12} /> event not on relays
    </span>
  );
}

export function ProfileChip({ profile, time }: { profile: Profile | null; time?: number }) {
  if (!profile) {
    return <div className="h-9 flex items-center text-xs text-zinc-500">loading author…</div>;
  }
  return (
    <Link to={`/p/${profile.npub}`} className="flex items-center gap-2.5 group" onClick={(e) => e.stopPropagation()}>
      {profile.picture ? (
        <img src={profile.picture} alt="" className="w-9 h-9 rounded-full object-cover bg-ink-overlay" loading="lazy" />
      ) : (
        <div className="w-9 h-9 rounded-full bg-nostr/25 flex items-center justify-center text-sm font-bold text-nostr">
          {profile.name.slice(0, 1).toUpperCase()}
        </div>
      )}
      <div className="leading-tight">
        <div className="text-sm font-semibold group-hover:text-nostr transition-colors">{profile.name}</div>
        <div className="text-[11px] text-zinc-500">
          {profile.nip05 ?? profile.npub.slice(0, 16) + '…'}
          {time ? ` · ${timeAgo(time)}` : ''}
        </div>
      </div>
    </Link>
  );
}

export function ChainFooter({ anchor }: { anchor: AnchorRecord }) {
  const [chain] = useChain();
  const preSplit = anchor.blockHeight > 0 && anchor.blockHeight < SPLIT_HEIGHT;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-zinc-500 font-mono">
      <span className="inline-flex items-center gap-1 text-bitcoin">
        <Box size={11} /> block {anchor.blockHeight ? anchor.blockHeight.toLocaleString() : 'mempool'}
      </span>
      <span>{anchor.txid.slice(0, 12)}…</span>
      <span>{anchor.scriptSize}B script</span>
      {anchor.feeSats > 0 && <span>{anchor.feeSats.toLocaleString()} sat fee</span>}
      {preSplit ? (
        <span className="text-green-500" title="Mined before the split at block 961,632 — this history is shared by BTC and XBT">
          pre-split · BTC + XBT
        </span>
      ) : (
        <span className={chain === 'xbt' ? 'text-purple-400' : 'text-bitcoin'}>
          {chainTicker(chain)}
          {anchor.scriptSize > 83 && ' · over BIP-110 limit (BTC only)'}
        </span>
      )}
    </div>
  );
}

const PROTOCOL_META = {
  NSTR: { icon: Type, label: 'Nostr note', color: 'text-nostr' },
  LOPS: { icon: FileCheck2, label: 'Proof of existence', color: 'text-sky-400' },
  NINV: { icon: Receipt, label: 'Invoice settlement', color: 'text-emerald-400' },
  TEXT: { icon: Type, label: 'On-chain message', color: 'text-zinc-300' },
} as const;

export function AnchorCard({ anchor }: { anchor: AnchorRecord }) {
  const [event, setEvent] = useState<Event | null>(null);
  const [status, setStatus] = useState<VerificationStatus | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);

  useEffect(() => {
    let alive = true;
    if (anchor.protocol === 'NSTR' && anchor.nostrEventId) {
      resolveAnchoredEvent(anchor.nostrEventId, anchor.scriptHex).then(async ({ event, status }) => {
        if (!alive) return;
        setEvent(event);
        setStatus(status);
        if (event) {
          const p = await fetchProfile(event.pubkey);
          if (alive) setProfile(p);
        }
      });
    }
    return () => {
      alive = false;
    };
  }, [anchor]);

  const meta = PROTOCOL_META[anchor.protocol];
  const Icon = meta.icon;

  return (
    <Link to={`/tx/${anchor.txid}`} className="card block p-4 space-y-3 hover:border-bitcoin/60 transition-colors">
      <div className="flex items-center justify-between gap-2">
        <span className={`inline-flex items-center gap-1.5 text-xs font-semibold ${meta.color}`}>
          <Icon size={14} /> {meta.label}
        </span>
        {anchor.protocol === 'NSTR' && status && <VerifiedBadge status={status} />}
      </div>

      {anchor.protocol === 'NSTR' && (
        <>
          {event ? (
            <>
              <ProfileChip profile={profile} time={event.created_at} />
              <NoteContent content={event.content} />
            </>
          ) : status === 'missing' ? (
            <p className="text-sm text-zinc-500">
              Event <span className="font-mono">{anchor.nostrEventId?.slice(0, 16)}…</span> (kind {anchor.nostrKind}) is anchored
              here but no relay we know has it.
            </p>
          ) : (
            <div className="h-16 rounded-xl bg-ink-overlay animate-pulse" />
          )}
        </>
      )}

      {anchor.protocol === 'TEXT' && <NoteContent content={anchor.text ?? ''} />}

      {(anchor.protocol === 'LOPS' || anchor.protocol === 'NINV') && (
        <p className="text-sm text-zinc-400">
          {anchor.protocol === 'LOPS' ? 'SHA-256 proof anchored:' : 'Settled invoice hash:'}{' '}
          <span className="font-mono text-xs break-all">{anchor.hash}</span>
        </p>
      )}

      <ChainFooter anchor={anchor} />
    </Link>
  );
}
