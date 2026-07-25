import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, Send, Star, Trash2, Zap } from 'lucide-react';
import { loadContacts, saveContact, removeContact, type Contact } from '../lib/storage';
import { searchPeople, profileToContact, type NostrProfile } from '../lib/nostr';
import { loadSettings } from '../lib/storage';

export function Contacts() {
  const navigate = useNavigate();
  const network = loadSettings().network;
  const [contacts, setContacts] = useState<Contact[]>(loadContacts());
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<NostrProfile[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState('');

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    if (!query.trim()) return;
    setSearching(true);
    setError('');
    try {
      setResults(await searchPeople(query.trim()));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Search failed — check your connection');
    } finally {
      setSearching(false);
    }
  }

  function sendTo(c: { silentPaymentAddress?: string; taprootAddress?: string; npub?: string }) {
    const recipient = c.silentPaymentAddress ?? c.taprootAddress ?? c.npub ?? '';
    navigate('/send', { state: { recipient } });
  }

  function ProfileCard({ p, saved }: { p: NostrProfile | Contact; saved: boolean }) {
    const name = p.name;
    const picture = 'picture' in p ? p.picture : undefined;
    const sp = p.silentPaymentAddress;
    return (
      <div className="card flex items-center gap-3">
        {picture ? (
          <img src={picture} alt="" className="w-11 h-11 rounded-full object-cover shrink-0 bg-surface-overlay" />
        ) : (
          <div className="w-11 h-11 rounded-full bg-surface-overlay flex items-center justify-center text-stone-400 font-bold shrink-0">
            {name.slice(0, 1).toUpperCase()}
          </div>
        )}
        <div className="flex-1 min-w-0">
          <div className="font-semibold text-sm truncate flex items-center gap-1.5">
            {name}
            {sp && (
              <span className="text-purple-300" title="Publishes a silent payment address — sends are unlinkable">
                <Zap size={12} />
              </span>
            )}
          </div>
          <div className="text-xs text-stone-500 font-mono truncate">{p.npub}</div>
          {'nip05' in p && p.nip05 && <div className="text-xs text-stone-500 truncate">{p.nip05}</div>}
        </div>
        <div className="flex gap-1 shrink-0">
          {!saved && (
            <button
              className="btn-ghost px-2"
              title="Save contact"
              onClick={() => {
                saveContact(profileToContact(p as NostrProfile, network));
                setContacts(loadContacts());
              }}
            >
              <Star size={16} />
            </button>
          )}
          {saved && (
            <button
              className="btn-ghost px-2 text-red-400"
              title="Remove"
              onClick={() => {
                removeContact(p.pubkeyHex);
                setContacts(loadContacts());
              }}
            >
              <Trash2 size={16} />
            </button>
          )}
          <button
            className="btn-primary px-3"
            title="Send bitcoin"
            onClick={() => sendTo(saved ? (p as Contact) : profileToContact(p as NostrProfile, network))}
          >
            <Send size={15} />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-2xl font-bold">People</h1>
        <p className="text-stone-400 text-sm">
          Nostr is your address book — search anyone, send to their npub. A <Zap size={11} className="inline text-purple-300" /> means
          they publish a silent payment address (private, unlinkable sends).
        </p>
      </header>

      <form onSubmit={handleSearch} className="flex gap-2">
        <input
          className="input flex-1"
          placeholder="Search name, or paste npub / nprofile / hex"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button type="submit" className="btn-primary" disabled={searching}>
          <Search size={16} />
        </button>
      </form>
      {error && <p className="text-red-400 text-sm">{error}</p>}
      {searching && <p className="text-stone-400 text-sm">Searching relays…</p>}

      {results.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-xs uppercase tracking-wide text-stone-500 font-medium">Results</h2>
          {results.map((p) => (
            <ProfileCard key={p.pubkeyHex} p={p} saved={contacts.some((c) => c.pubkeyHex === p.pubkeyHex)} />
          ))}
        </section>
      )}

      <section className="space-y-2">
        <h2 className="text-xs uppercase tracking-wide text-stone-500 font-medium">Saved ({contacts.length})</h2>
        {contacts.length === 0 && <div className="card text-stone-500 text-sm text-center py-6">No saved contacts yet</div>}
        {contacts.map((c) => (
          <ProfileCard key={c.pubkeyHex} p={c} saved />
        ))}
      </section>
    </div>
  );
}
