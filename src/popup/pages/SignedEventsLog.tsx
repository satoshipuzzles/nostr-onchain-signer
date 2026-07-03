import { useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Trash2, Search, Filter, FileText } from 'lucide-react';

interface SignedEventEntry {
  id: string;
  kind: number;
  content: string;
  created_at: number;
  origin?: string;
  pubkey: string;
}

function relativeTime(unix: number): string {
  const diff = Date.now() - unix * 1000;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(unix * 1000).toLocaleDateString();
}

const KIND_LABELS: Record<number, { label: string; color: string }> = {
  0: { label: 'Metadata', color: 'bg-blue-500/20 text-blue-400' },
  1: { label: 'Note', color: 'bg-green-500/20 text-green-400' },
  3: { label: 'Contacts', color: 'bg-cyan-500/20 text-cyan-400' },
  4: { label: 'DM', color: 'bg-purple-500/20 text-purple-400' },
  5: { label: 'Delete', color: 'bg-red-500/20 text-red-400' },
  6: { label: 'Repost', color: 'bg-teal-500/20 text-teal-400' },
  7: { label: 'Reaction', color: 'bg-yellow-500/20 text-yellow-400' },
  9733: { label: 'Zap Req', color: 'bg-orange-500/20 text-orange-400' },
  9734: { label: 'Zap Req', color: 'bg-orange-500/20 text-orange-400' },
  9735: { label: 'Zap', color: 'bg-amber-500/20 text-amber-400' },
  9800: { label: 'OP_RETURN', color: 'bg-bitcoin/20 text-bitcoin' },
  10002: { label: 'Relay List', color: 'bg-indigo-500/20 text-indigo-400' },
  30023: { label: 'Article', color: 'bg-pink-500/20 text-pink-400' },
};

function getKindBadge(kind: number) {
  const config = KIND_LABELS[kind] || { label: `Kind ${kind}`, color: 'bg-gray-500/20 text-gray-400' };
  return config;
}

const FILTER_KINDS = [
  { value: 0, label: 'All Kinds' },
  { value: 1, label: 'Notes (1)' },
  { value: 4, label: 'DMs (4)' },
  { value: 7, label: 'Reactions (7)' },
  { value: 9733, label: 'Zap Req (9733)' },
  { value: 9800, label: 'OP_RETURN (9800)' },
];

export function SignedEventsLog() {
  const navigate = useNavigate();
  const [events, setEvents] = useState<SignedEventEntry[]>([]);
  const [search, setSearch] = useState('');
  const [kindFilter, setKindFilter] = useState(0);
  const [showFilter, setShowFilter] = useState(false);

  const loadEvents = useCallback(async () => {
    const data = await chrome.storage.local.get('signed_events_log');
    setEvents((data.signed_events_log as SignedEventEntry[]) || []);
  }, []);

  useEffect(() => { loadEvents(); }, [loadEvents]);

  async function clearLog() {
    await chrome.storage.local.remove('signed_events_log');
    setEvents([]);
  }

  const filtered = useMemo(() => {
    let list = events;
    if (kindFilter !== 0) {
      list = list.filter(e => e.kind === kindFilter);
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(e =>
        e.content.toLowerCase().includes(q) ||
        e.id.toLowerCase().includes(q)
      );
    }
    return list;
  }, [events, kindFilter, search]);

  return (
    <div className="h-full flex flex-col p-4 md:p-6 overflow-y-auto pb-24">
      <div className="flex items-center gap-3 mb-4">
        <button onClick={() => navigate('/settings')} className="text-gray-400 hover:text-white transition-colors">
          <ArrowLeft className="w-5 h-5" />
        </button>
        <h1 className="text-lg font-bold flex-1">Signed Events</h1>
        {events.length > 0 && (
          <button onClick={clearLog} className="text-xs text-red-400 hover:text-red-300 transition-colors flex items-center gap-1">
            <Trash2 className="w-3.5 h-3.5" />
            Clear Log
          </button>
        )}
      </div>

      {events.length > 0 && (
        <div className="space-y-2 mb-4">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search by content or event ID..."
              className="w-full bg-surface-700/50 rounded-xl pl-9 pr-10 py-2.5 text-xs text-white placeholder-gray-600 outline-none border border-surface-200/10 focus:border-bitcoin/30"
            />
            <button
              onClick={() => setShowFilter(!showFilter)}
              className={`absolute right-3 top-1/2 -translate-y-1/2 transition-colors ${kindFilter !== 0 ? 'text-bitcoin' : 'text-gray-500 hover:text-gray-300'}`}
            >
              <Filter className="w-4 h-4" />
            </button>
          </div>

          {showFilter && (
            <div className="flex flex-wrap gap-1.5">
              {FILTER_KINDS.map(f => (
                <button
                  key={f.value}
                  onClick={() => { setKindFilter(f.value); setShowFilter(false); }}
                  className={`px-2.5 py-1 rounded-full text-[10px] font-medium transition-colors ${
                    kindFilter === f.value
                      ? 'bg-bitcoin/20 text-bitcoin'
                      : 'bg-surface-700/50 text-gray-500 hover:text-gray-300'
                  }`}
                >
                  {f.label}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {events.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center text-center px-8">
          <FileText className="w-12 h-12 text-gray-600 mb-3" />
          <p className="text-sm text-gray-400">No signed events yet</p>
          <p className="text-xs text-gray-600 mt-1">
            Events will appear here as you sign Nostr events.
          </p>
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center text-center px-8">
          <Search className="w-10 h-10 text-gray-600 mb-3" />
          <p className="text-sm text-gray-400">No matching events</p>
          <p className="text-xs text-gray-600 mt-1">Try a different search or filter.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map(event => {
            const badge = getKindBadge(event.kind);
            return (
              <button
                key={event.id}
                onClick={() => navigate(`/settings/events/${event.id}`)}
                className="card w-full text-left hover:border-bitcoin/30 transition-colors"
              >
                <div className="flex items-start gap-3">
                  <span className={`flex-shrink-0 px-2 py-0.5 rounded-full text-[10px] font-medium ${badge.color}`}>
                    {badge.label}
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs text-white truncate">
                      {event.content || <span className="text-gray-600 italic">no content</span>}
                    </p>
                    <div className="flex items-center gap-2 mt-1">
                      <span className="text-[10px] text-gray-600 font-mono truncate max-w-[120px]">
                        {event.id.slice(0, 12)}...
                      </span>
                      {event.origin && (
                        <span className="text-[10px] text-gray-500 truncate">{event.origin}</span>
                      )}
                    </div>
                  </div>
                  <span className="text-[10px] text-gray-600 flex-shrink-0 whitespace-nowrap">
                    {relativeTime(event.created_at)}
                  </span>
                </div>
              </button>
            );
          })}
          <p className="text-center text-[10px] text-gray-600 pt-2">
            {filtered.length} event{filtered.length !== 1 ? 's' : ''}
            {filtered.length !== events.length && ` (${events.length} total)`}
          </p>
        </div>
      )}
    </div>
  );
}
