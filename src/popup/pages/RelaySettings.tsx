import { useState, useEffect } from 'react';
import { ArrowLeft, Plus, Trash2, BookOpen, PenLine, Check } from 'lucide-react';
import {
  loadRelayList, saveRelayList, addRelay, removeRelay, updateRelay,
  getSuggestedRelays, type RelayList, type RelayConfig,
} from '@/lib/nostr/relays';

interface Props {
  onBack: () => void;
}

export function RelaySettings({ onBack }: Props) {
  const [relayList, setRelayList] = useState<RelayList>({ relays: [], updatedAt: 0 });
  const [newUrl, setNewUrl] = useState('');
  const [showSuggested, setShowSuggested] = useState(false);

  useEffect(() => {
    loadRelayList().then(setRelayList);
  }, []);

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!newUrl.trim()) return;
    const updated = addRelay(relayList, newUrl.trim(), true, true);
    setRelayList(updated);
    await saveRelayList(updated);
    setNewUrl('');
  }

  async function handleRemove(url: string) {
    const updated = removeRelay(relayList, url);
    setRelayList(updated);
    await saveRelayList(updated);
  }

  async function handleToggle(url: string, field: 'read' | 'write') {
    const relay = relayList.relays.find((r) => r.url === url);
    if (!relay) return;
    const updated = updateRelay(
      relayList, url,
      field === 'read' ? !relay.read : relay.read,
      field === 'write' ? !relay.write : relay.write
    );
    setRelayList(updated);
    await saveRelayList(updated);
  }

  async function handleAddSuggested(relay: RelayConfig) {
    const updated = addRelay(relayList, relay.url, relay.read, relay.write);
    setRelayList(updated);
    await saveRelayList(updated);
  }

  const suggested = getSuggestedRelays().filter(
    (s) => !relayList.relays.some((r) => r.url === s.url)
  );

  return (
    <div className="h-full flex flex-col p-4 overflow-y-auto">
      {/* Header */}
      <div className="flex items-center gap-2 mb-4">
        <button onClick={onBack} className="p-1.5 hover:bg-surface-700 rounded-lg">
          <ArrowLeft className="w-4 h-4" />
        </button>
        <h1 className="text-lg font-bold">Relays</h1>
      </div>

      {/* Add relay */}
      <form onSubmit={handleAdd} className="flex gap-2 mb-4">
        <input
          value={newUrl}
          onChange={(e) => setNewUrl(e.target.value)}
          placeholder="wss://relay.example.com"
          className="input-field text-sm flex-1"
        />
        <button type="submit" className="p-2.5 bg-bitcoin rounded-lg hover:bg-bitcoin/90">
          <Plus className="w-4 h-4" />
        </button>
      </form>

      {/* Column headers */}
      <div className="flex items-center gap-2 px-3 mb-2 text-[10px] uppercase tracking-wider text-gray-500">
        <span className="flex-1">Relay</span>
        <span className="w-12 text-center">Read</span>
        <span className="w-12 text-center">Write</span>
        <span className="w-8"></span>
      </div>

      {/* Relay list */}
      <div className="space-y-1 mb-4">
        {relayList.relays.map((relay) => (
          <div key={relay.url} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-surface-800/50">
            <div className="flex-1 min-w-0">
              <p className="text-xs text-gray-300 truncate font-mono">
                {relay.url.replace('wss://', '')}
              </p>
            </div>
            <button
              onClick={() => handleToggle(relay.url, 'read')}
              className={`w-12 flex justify-center p-1 rounded ${
                relay.read ? 'text-green-400' : 'text-gray-600'
              }`}
            >
              <BookOpen className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => handleToggle(relay.url, 'write')}
              className={`w-12 flex justify-center p-1 rounded ${
                relay.write ? 'text-bitcoin' : 'text-gray-600'
              }`}
            >
              <PenLine className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => handleRemove(relay.url)}
              className="w-8 flex justify-center p-1 text-gray-600 hover:text-red-400 rounded"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
        ))}
        {relayList.relays.length === 0 && (
          <p className="text-sm text-gray-500 text-center py-4">No relays configured</p>
        )}
      </div>

      {/* Suggested relays */}
      {suggested.length > 0 && (
        <>
          <button
            onClick={() => setShowSuggested(!showSuggested)}
            className="text-xs text-bitcoin hover:underline mb-2"
          >
            {showSuggested ? 'Hide' : 'Show'} suggested relays ({suggested.length})
          </button>
          {showSuggested && (
            <div className="space-y-1">
              {suggested.map((relay) => (
                <div key={relay.url} className="flex items-center gap-2 px-3 py-2 rounded-lg border border-dashed border-surface-200/20">
                  <p className="text-xs text-gray-400 truncate flex-1 font-mono">
                    {relay.url.replace('wss://', '')}
                  </p>
                  <button
                    onClick={() => handleAddSuggested(relay)}
                    className="text-xs bg-bitcoin/20 text-bitcoin px-2 py-0.5 rounded hover:bg-bitcoin/30"
                  >
                    Add
                  </button>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
