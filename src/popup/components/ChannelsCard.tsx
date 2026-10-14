import { useEffect, useState } from 'react';
import { Loader2, ChevronDown, ChevronUp, Copy } from 'lucide-react';
import { toast } from 'sonner';
import {
  listNwcChannels, getNwcNodeSummary,
  type NwcConnection, type NwcChannel, type NwcNodeSummary,
} from '@/lib/nostr/nwc';

const n = (v: number) => v.toLocaleString();

const STATE_LABEL: Record<NwcChannel['state'], string> = {
  active: 'Active', inactive: 'Offline', opening: 'Opening', closing: 'Closing', force_closing: 'Force closing',
};

/** Node balances and channels, read over NWC. Read only. */
export function ChannelsCard({ conn, refreshKey }: { conn: NwcConnection; refreshKey: number }) {
  const [summary, setSummary] = useState<NwcNodeSummary | null>(null);
  const [channels, setChannels] = useState<NwcChannel[] | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setChannels(null);
    setError('');
    Promise.all([getNwcNodeSummary(conn), listNwcChannels(conn)]).then(([s, c]) => {
      if (!live) return;
      if (s.result) setSummary(s.result);
      if (c.error) setError(c.error);
      setChannels(c.channels ?? []);
    });
    return () => { live = false; };
  }, [conn, refreshKey]);

  const outbound = summary ? Math.floor(summary.channel_local_msat / 1000) : null;
  const inbound = summary ? Math.floor(summary.channel_remote_msat / 1000) : null;

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-3">
        <p className="text-sm font-medium">Node & channels</p>
        {summary && (
          <span className={`text-[10px] ${summary.synced_to_chain ? 'text-green-400' : 'text-amber-400'}`}>
            {summary.synced_to_chain ? `Synced · block ${n(summary.block_height)}` : 'Syncing'}
          </span>
        )}
      </div>

      {summary && (
        <div className="grid grid-cols-2 gap-2 mb-3">
          <Stat label="Can send" value={`${n(outbound!)} sats`} />
          <Stat label="Can receive" value={`${n(inbound!)} sats`} />
          <Stat
            label="On-chain (node)"
            value={`${n(summary.onchain_confirmed_sats)} sats`}
            sub={summary.onchain_unconfirmed_sats ? `+${n(summary.onchain_unconfirmed_sats)} unconfirmed` : undefined}
          />
          <Stat
            label="Channels"
            value={`${summary.num_active_channels} active`}
            sub={[
              summary.num_inactive_channels && `${summary.num_inactive_channels} offline`,
              summary.num_pending_channels && `${summary.num_pending_channels} pending`,
              `${summary.num_peers} peers`,
            ].filter(Boolean).join(' · ')}
          />
        </div>
      )}

      {channels === null ? (
        <div className="py-4 flex justify-center"><Loader2 className="w-4 h-4 animate-spin text-gray-500" /></div>
      ) : error ? (
        <p className="text-xs text-amber-400">{error}</p>
      ) : channels.length === 0 ? (
        <p className="text-xs text-gray-500">No channels.</p>
      ) : (
        <ul className="divide-y divide-white/5">
          {channels.map((c, i) => {
            const key = c.channel_point || String(i);
            const total = c.local_sats + c.remote_sats || 1;
            const isOpen = open === key;
            return (
              <li key={key} className="py-2.5">
                <button className="w-full text-left" onClick={() => setOpen(isOpen ? null : key)}>
                  <div className="flex items-center gap-2">
                    <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${c.state === 'active' ? 'bg-green-400' : c.state === 'inactive' ? 'bg-gray-600' : 'bg-amber-400'}`} />
                    <span className="text-xs font-medium truncate flex-1">{c.alias || c.remote_pubkey?.slice(0, 16) || 'unknown peer'}</span>
                    <span className="text-[10px] text-gray-500">{n(c.capacity_sats)}</span>
                    {isOpen ? <ChevronUp className="w-3.5 h-3.5 text-gray-500" /> : <ChevronDown className="w-3.5 h-3.5 text-gray-500" />}
                  </div>
                  {/* local (yours) on the left, remote on the right */}
                  <div className="mt-1.5 h-1.5 rounded-full bg-white/10 overflow-hidden">
                    <div className="h-full bg-white" style={{ width: `${(c.local_sats / total) * 100}%` }} />
                  </div>
                  <div className="mt-1 flex justify-between text-[10px] text-gray-500 tabular-nums">
                    <span>{n(c.local_sats)} yours</span>
                    <span>{c.state !== 'active' && <span className="text-amber-400 mr-1.5">{STATE_LABEL[c.state]}</span>}{n(c.remote_sats)} theirs</span>
                  </div>
                </button>
                {isOpen && (
                  <div className="mt-2 text-[10px] text-gray-500 space-y-1 break-all">
                    {c.policy && <p>Your fees: {c.policy.base_fee_msat} msat + {n(c.policy.fee_rate_ppm)} ppm{c.policy.disabled ? ' · disabled' : ''}</p>}
                    {c.private !== undefined && <p>{c.private ? 'Private' : 'Public'} · opened by {c.initiator ? 'you' : 'them'}</p>}
                    {c.remote_pubkey && <CopyLine label="Peer" value={c.remote_pubkey} />}
                    {c.channel_point && <CopyLine label="Channel" value={c.channel_point} />}
                    {c.closing_txid && <CopyLine label="Closing tx" value={c.closing_txid} />}
                    {c.blocks_til_maturity ? <p>Funds return in {n(c.blocks_til_maturity)} blocks</p> : null}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <p className="text-[10px] text-gray-600 mt-3">
        Read only. Open, close and fee changes stay in your node dashboard.
      </p>
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg bg-white/5 px-3 py-2 min-w-0">
      <p className="text-[10px] text-gray-500">{label}</p>
      <p className="text-xs font-semibold tabular-nums truncate">{value}</p>
      {sub && <p className="text-[10px] text-gray-500 truncate">{sub}</p>}
    </div>
  );
}

function CopyLine({ label, value }: { label: string; value: string }) {
  return (
    <button
      className="flex items-center gap-1 text-left hover:text-gray-300"
      onClick={() => { navigator.clipboard.writeText(value); toast.success(`${label} copied`); }}
    >
      <Copy className="w-3 h-3 flex-shrink-0" /> {label}: <span className="font-mono">{value.slice(0, 20)}…</span>
    </button>
  );
}
