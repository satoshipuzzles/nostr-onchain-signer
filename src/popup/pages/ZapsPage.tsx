import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { nip19 } from 'nostr-tools';
import { ArrowLeft, Zap, ArrowUpRight, ArrowDownLeft, Loader2, Repeat, FileText, Info } from 'lucide-react';
import { useAuth } from '@/popup/context/AuthContext';
import { streamZapHistory, bridgePaysFromWallet, type ZapRow } from '@/lib/nostr/zap-history';
import { useProfile } from '@/popup/hooks/useNostr';
import { ClickableAvatar } from '@/popup/components/ClickableAvatar';

type Tab = 'sent' | 'received';
type Span = 7 | 30 | 0;

const ago = (ts: number) => {
  const m = (Date.now() / 1000 - ts) / 60;
  if (m < 60) return `${Math.max(1, Math.round(m))}m`;
  if (m < 1440) return `${Math.round(m / 60)}h`;
  if (m < 43200) return `${Math.round(m / 1440)}d`;
  return new Date(ts * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

function ChainPill({ chain }: { chain: 'xbt' | 'btc' }) {
  return <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${chain === 'xbt' ? 'bg-purple-500/20 text-purple-200' : 'bg-orange-500/20 text-orange-200'}`}>{chain.toUpperCase()} ⚡</span>;
}

function Row({ z, onNote }: { z: ZapRow; onNote: (id: string) => void }) {
  const who = z.direction === 'sent' ? z.recipient : z.sender;
  const p = useProfile(who || null);
  const name = z.anonymous || !who ? 'Anonymous' : p?.displayName || p?.name || who.slice(0, 10) + '…';
  const how = z.direction === 'sent'
    ? z.via === 'bridge'
      ? `From your XBT wallet through the bridge${z.costXbtSats ? ` · cost ${z.costXbtSats.toLocaleString()} XBT sats` : ''}`
      : z.via === 'direct'
        ? `From your ${z.chain.toUpperCase()} wallet${z.feeSats != null ? ` · fee ${z.feeSats} sat${z.feeSats === 1 ? '' : 's'}` : ''}`
        : `Paid on ${z.chain.toUpperCase()} Lightning`
    : `Paid on ${z.chain.toUpperCase()} Lightning`;
  return (
    <div className="flex gap-3 py-3 border-b border-white/5">
      {who && !z.anonymous
        ? <ClickableAvatar pubkey={who} picture={p?.picture} name={name} size="md" />
        : <div className="w-10 h-10 rounded-full bg-white/10 flex items-center justify-center text-gray-400 flex-shrink-0">?</div>}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-white truncate">{name}</span>
          <span className="text-[11px] text-gray-500 ml-auto flex-shrink-0">{ago(z.createdAt)}</span>
        </div>
        <div className="flex items-center gap-2 mt-0.5">
          <span className={`text-base font-bold ${z.direction === 'sent' ? 'text-white' : 'text-green-300'}`}>{z.direction === 'sent' ? '−' : '+'}{z.amountSats.toLocaleString()} <span className="text-xs font-medium text-gray-400">sats</span></span>
          <ChainPill chain={z.chain} />
          {z.via === 'bridge' && <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-white/10 text-gray-200 flex items-center gap-0.5"><Repeat className="w-2.5 h-2.5" /> bridge</span>}
        </div>
        <p className="text-[11px] text-gray-400 mt-0.5">{how}</p>
        {z.comment && <p className="text-xs text-gray-200 mt-1 break-words">“{z.comment}”</p>}
        <div className="flex gap-3 mt-1">
          {z.eventId && <button onClick={() => onNote(z.eventId!)} className="text-[11px] text-purple-300 hover:text-purple-200 flex items-center gap-1"><FileText className="w-3 h-3" /> The note</button>}
          {z.noReceipt && <span className="text-[11px] text-amber-300/80">paid · no receipt seen on relays yet</span>}
        </div>
      </div>
    </div>
  );
}

export function ZapsPage() {
  const navigate = useNavigate();
  const auth = useAuth();
  // /zaps?pubkey=<hex> shows anyone's zaps (receipts are public); default is yours
  const other = new URLSearchParams(location.search).get('pubkey');
  const publicKey = other && /^[0-9a-f]{64}$/.test(other) ? other : auth.publicKey;
  const [rows, setRows] = useState<ZapRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>('sent');
  const [span, setSpan] = useState<Span>(30);

  useEffect(() => {
    if (!publicKey) return;
    setLoading(true);
    let stop: (() => void) | null = null;
    let live = true;
    // your own history: ask the XBT wallet which BTC zaps it paid through the bridge
    (publicKey === auth.publicKey ? bridgePaysFromWallet().catch(() => []) : Promise.resolve([])).then((bridge) => {
      if (live) stop = streamZapHistory(publicKey, (r, done) => { setRows(r); if (done) setLoading(false); }, bridge);
    });
    return () => { live = false; stop?.(); };
  }, [publicKey]);

  const cutoff = span ? Date.now() / 1000 - span * 86400 : 0;
  const shown = useMemo(() => rows.filter((r) => r.direction === tab && r.createdAt >= cutoff), [rows, tab, cutoff]);
  const totals = useMemo(() => {
    const t = { sent: { xbt: 0, btc: 0, n: 0, bridgeXbt: 0 }, received: { xbt: 0, btc: 0, n: 0, bridgeXbt: 0 } };
    for (const r of rows) {
      if (r.createdAt < cutoff) continue;
      const d = t[r.direction];
      d[r.chain] += r.amountSats; d.n++;
      if (r.via === 'bridge' && r.costXbtSats) d.bridgeXbt += r.costXbtSats;
    }
    return t;
  }, [rows, cutoff]);
  const T = totals[tab];

  return (
    <div className="min-h-full flex flex-col p-4 md:p-6 max-w-2xl">
      <div className="flex items-center gap-3 mb-3">
        <button onClick={() => navigate(-1)} className="p-2 -ml-2 rounded-lg hover:bg-surface-700" aria-label="Back"><ArrowLeft className="w-5 h-5" /></button>
        <h1 className="text-lg font-bold flex items-center gap-2"><Zap className="w-5 h-5 text-amber-300" /> Zaps</h1>
        {loading && <Loader2 className="w-4 h-4 animate-spin text-gray-500" />}
      </div>

      <div className="flex rounded-xl bg-surface-700 p-1 text-sm font-medium mb-3">
        {(['sent', 'received'] as Tab[]).map((t) => (
          <button key={t} onClick={() => setTab(t)} className={`flex-1 py-2 rounded-lg flex items-center justify-center gap-1.5 ${tab === t ? 'bg-white text-black' : 'text-gray-400'}`}>
            {t === 'sent' ? <ArrowUpRight className="w-4 h-4" /> : <ArrowDownLeft className="w-4 h-4" />}
            {t === 'sent' ? 'You zapped' : 'Zapped you'} <span className="text-xs opacity-70">{totals[t].n}</span>
          </button>
        ))}
      </div>

      <div className="card mb-3">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs text-gray-400">{span ? `Last ${span} days` : 'All time'}</span>
          <div className="flex gap-1">
            {([7, 30, 0] as Span[]).map((s) => (
              <button key={s} onClick={() => setSpan(s)} className={`text-[11px] px-2 py-0.5 rounded-full border ${span === s ? 'border-purple-400 text-white bg-purple-500/20' : 'border-white/10 text-gray-400'}`}>{s ? `${s}d` : 'All'}</button>
            ))}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div><p className="text-[10px] text-purple-300 uppercase tracking-wider">XBT Lightning{tab === 'sent' && T.bridgeXbt > 0 ? ' + bridge' : ''}</p><p className="text-lg font-bold">{(T.xbt + (tab === 'sent' ? T.bridgeXbt : 0)).toLocaleString()}<span className="text-xs text-gray-400 font-medium"> sats</span></p></div>
          <div><p className="text-[10px] text-orange-300 uppercase tracking-wider">BTC Lightning</p><p className="text-lg font-bold">{T.btc.toLocaleString()}<span className="text-xs text-gray-400 font-medium"> sats</span></p></div>
        </div>
        {tab === 'sent' && T.bridgeXbt > 0 && <p className="text-[11px] text-gray-400 mt-2">BTC zaps paid from XBT through the bridge cost {T.bridgeXbt.toLocaleString()} XBT sats.</p>}
      </div>

      {shown.map((z) => <Row key={z.id} z={z} onNote={(id) => navigate(`/find?q=${nip19.noteEncode(id)}`)} />)}
      {!loading && shown.length === 0 && <p className="text-sm text-gray-500 text-center py-10">{tab === 'sent' ? 'No zaps from you' : 'No zaps to you'} in this period.</p>}

      <p className="text-[11px] text-gray-500 mt-4 flex gap-1.5"><Info className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" /> From zap receipts on your relays. Whether a zap went through the bridge, and what it cost, is known only on the device that sent it.</p>
    </div>
  );
}
