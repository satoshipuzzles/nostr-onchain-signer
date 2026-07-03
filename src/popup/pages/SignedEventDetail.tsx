import { useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Copy, Check, ExternalLink, Clock, Hash, Tag } from 'lucide-react';
import { pubkeyToNpub } from '@/lib/nostr/keys';

interface SignedEventEntry {
  id: string;
  kind: number;
  content: string;
  created_at: number;
  origin?: string;
  pubkey: string;
  sig?: string;
  tags?: string[][];
}

const KIND_LABELS: Record<number, { label: string; color: string }> = {
  0: { label: 'Metadata', color: 'bg-blue-500/20 text-blue-400' },
  1: { label: 'Note', color: 'bg-green-500/20 text-green-400' },
  3: { label: 'Contacts', color: 'bg-cyan-500/20 text-cyan-400' },
  4: { label: 'DM', color: 'bg-purple-500/20 text-purple-400' },
  7: { label: 'Reaction', color: 'bg-yellow-500/20 text-yellow-400' },
  9735: { label: 'Zap', color: 'bg-amber-500/20 text-amber-400' },
  9800: { label: 'OP_RETURN', color: 'bg-bitcoin/20 text-bitcoin' },
};

function getKindBadge(kind: number) {
  return KIND_LABELS[kind] || { label: `Kind ${kind}`, color: 'bg-gray-500/20 text-gray-400' };
}

export function SignedEventDetail() {
  const { eventId } = useParams<{ eventId: string }>();
  const navigate = useNavigate();
  const [event, setEvent] = useState<SignedEventEntry | null>(null);
  const [copied, setCopied] = useState('');

  useEffect(() => {
    async function load() {
      const data = await chrome.storage.local.get('signed_events_log');
      const events: SignedEventEntry[] = data.signed_events_log || [];
      const found = events.find((e) => e.id === eventId);
      setEvent(found || null);
    }
    load();
  }, [eventId]);

  async function copy(text: string, label: string) {
    await navigator.clipboard.writeText(text);
    setCopied(label);
    setTimeout(() => setCopied(''), 2000);
  }

  if (!event) {
    return (
      <div className="h-full flex flex-col items-center justify-center p-6">
        <p className="text-sm text-gray-500">Event not found</p>
        <button onClick={() => navigate('/settings/events')} className="text-xs text-nostr mt-2">
          Back to log
        </button>
      </div>
    );
  }

  const badge = getKindBadge(event.kind);
  const npub = pubkeyToNpub(event.pubkey);
  const time = new Date(event.created_at * 1000).toLocaleString();

  return (
    <div className="h-full flex flex-col p-4 md:p-6 overflow-y-auto pb-24">
      <div className="flex items-center gap-3 mb-4">
        <button onClick={() => navigate('/settings/events')} className="text-gray-400 hover:text-white">
          <ArrowLeft className="w-5 h-5" />
        </button>
        <h1 className="text-lg font-bold flex-1">Event Detail</h1>
        <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium ${badge.color}`}>
          {badge.label}
        </span>
      </div>

      {/* Content */}
      <div className="card mb-3">
        <p className="text-sm text-gray-200 whitespace-pre-wrap break-words leading-relaxed">
          {event.content || <span className="text-gray-600 italic">No content</span>}
        </p>
      </div>

      {/* Metadata */}
      <div className="space-y-2">
        <CopyField label="Event ID" value={event.id} copied={copied} onCopy={copy} />
        <CopyField label="npub (author)" value={npub} copied={copied} onCopy={copy} />
        <CopyField label="Hex pubkey" value={event.pubkey} copied={copied} onCopy={copy} />
        {event.sig && <CopyField label="Signature" value={event.sig} copied={copied} onCopy={copy} />}

        <div className="card">
          <div className="flex items-center gap-2 mb-1">
            <Clock className="w-3 h-3 text-gray-500" />
            <p className="text-[10px] text-gray-500 uppercase">Signed at</p>
          </div>
          <p className="text-xs text-gray-300">{time}</p>
          <p className="text-[10px] text-gray-600 mt-0.5">Unix: {event.created_at}</p>
        </div>

        {event.origin && (
          <div className="card">
            <p className="text-[10px] text-gray-500 uppercase mb-1">Origin</p>
            <p className="text-xs text-gray-300">{event.origin}</p>
          </div>
        )}

        {event.tags && event.tags.length > 0 && (
          <div className="card">
            <div className="flex items-center gap-2 mb-2">
              <Tag className="w-3 h-3 text-gray-500" />
              <p className="text-[10px] text-gray-500 uppercase">Tags ({event.tags.length})</p>
            </div>
            <div className="space-y-1 max-h-48 overflow-y-auto">
              {event.tags.map((tag, i) => (
                <div key={i} className="flex gap-1 text-[10px] font-mono">
                  <span className="text-nostr">{tag[0]}</span>
                  {tag.slice(1).map((v, j) => (
                    <span key={j} className="text-gray-400 truncate">{v}</span>
                  ))}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* External links */}
      <div className="flex gap-2 mt-4">
        <a
          href={`https://njump.me/${event.id}`}
          target="_blank"
          rel="noopener"
          className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-xs bg-surface-700 text-gray-400 hover:text-white transition-colors"
        >
          <ExternalLink className="w-3 h-3" /> njump.me
        </a>
        <a
          href={`https://nostr.band/?event=${event.id}`}
          target="_blank"
          rel="noopener"
          className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-xs bg-surface-700 text-gray-400 hover:text-white transition-colors"
        >
          <ExternalLink className="w-3 h-3" /> nostr.band
        </a>
      </div>
    </div>
  );
}

function CopyField({
  label, value, copied, onCopy,
}: {
  label: string;
  value: string;
  copied: string;
  onCopy: (text: string, label: string) => void;
}) {
  return (
    <div className="card">
      <div className="flex items-center justify-between mb-1">
        <p className="text-[10px] text-gray-500 uppercase">{label}</p>
        <button onClick={() => onCopy(value, label)} className="p-1 hover:bg-surface-700 rounded">
          {copied === label
            ? <Check className="w-3 h-3 text-green-400" />
            : <Copy className="w-3 h-3 text-gray-500" />}
        </button>
      </div>
      <code className="text-[10px] text-gray-300 font-mono break-all leading-relaxed select-all">
        {value}
      </code>
    </div>
  );
}
