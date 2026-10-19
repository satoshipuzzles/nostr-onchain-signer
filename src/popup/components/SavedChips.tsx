import { useContext, useEffect, useState } from 'react';
import { Pencil, Check, ChevronLeft, ChevronRight, X, Plus, CloudUpload, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { AuthContext } from '@/popup/context/AuthContext';
import { publishEvent } from '@/lib/nostr/publish';
import {
  useSavedList, addItem, removeItem, moveItem, isDirty, listTemplate, markSynced, pullLists, type ListKind,
} from '@/lib/nostr/saved-lists';

const pulled = new Set<string>();

interface Props {
  kind: ListKind;
  active: string;
  onPick: (v: string) => void;
  /** offer to save the currently shown item when it isn't in the list */
  showSaveActive?: boolean;
}

/** The user's saved hashtags or relays as chips: pick one, add, remove, reorder, and save the list to Nostr. */
export function SavedChips({ kind, active, onPick, showSaveActive = true }: Props) {
  const auth = useContext(AuthContext);
  const pubkey = auth?.publicKey || '';
  const list = useSavedList(kind, pubkey);
  const [editing, setEditing] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [adding, setAdding] = useState('');

  // once per session, adopt a newer list published from another client
  useEffect(() => {
    if (!pubkey || pulled.has(pubkey)) return;
    pulled.add(pubkey);
    pullLists(pubkey).catch(() => {});
  }, [pubkey]);

  const label = (v: string) => (kind === 'tags' ? `#${v}` : v.replace(/^wss:\/\//, ''));
  const chip = (on: boolean) => `flex items-center gap-1 px-3 py-1.5 rounded-full text-[13px] font-medium border whitespace-nowrap transition-colors ${
    on ? 'bg-purple-600/25 text-purple-200 border-purple-500/40' : 'bg-white/5 text-gray-300 border-white/10 hover:border-white/25'}`;

  async function sync() {
    if (!auth?.confirmAndSign) return;
    setSyncing(true);
    try {
      const signed = await auth.confirmAndSign(listTemplate(kind, list.items));
      const r = await publishEvent(signed, { resolveAfter: 1 });
      if (!r.success.length) throw new Error('No relay took the list');
      markSynced(kind, pubkey, signed.created_at);
      toast.success(kind === 'tags' ? 'Saved your hashtags to Nostr' : 'Saved your relays to Nostr');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save the list');
    } finally {
      setSyncing(false);
    }
  }

  const canSaveActive = showSaveActive && active && !list.items.includes(active);

  return (
    <div data-testid={`saved-${kind}`}>
      <div className="flex gap-1.5 overflow-x-auto scrollbar-none pb-1 items-center">
        {list.items.map((v, i) => (
          editing ? (
            <span key={v} className={chip(false)} data-saved={v}>
              <button type="button" onClick={() => moveItem(kind, pubkey, v, -1)} disabled={i === 0} className="disabled:opacity-30" aria-label={`Move ${label(v)} left`}><ChevronLeft className="w-3.5 h-3.5" /></button>
              {label(v)}
              <button type="button" onClick={() => moveItem(kind, pubkey, v, 1)} disabled={i === list.items.length - 1} className="disabled:opacity-30" aria-label={`Move ${label(v)} right`}><ChevronRight className="w-3.5 h-3.5" /></button>
              <button type="button" onClick={() => removeItem(kind, pubkey, v)} className="text-red-300 ml-0.5" aria-label={`Remove ${label(v)}`}><X className="w-3.5 h-3.5" /></button>
            </span>
          ) : (
            <button key={v} type="button" onClick={() => onPick(v)} className={chip(v === active)} data-saved={v} title={v}>{label(v)}</button>
          )
        ))}
        {canSaveActive && !editing && (
          <button type="button" onClick={() => addItem(kind, pubkey, active)} className={chip(false) + ' border-dashed'} data-testid={`save-active-${kind}`}>
            <Plus className="w-3.5 h-3.5" /> Save {label(active)}
          </button>
        )}
        <button type="button" onClick={() => setEditing((v) => !v)} className="flex-shrink-0 p-1.5 rounded-full text-gray-400 hover:text-white hover:bg-white/10" aria-label={editing ? 'Done editing' : 'Edit list'} data-testid={`edit-${kind}`}>
          {editing ? <Check className="w-4 h-4" /> : <Pencil className="w-3.5 h-3.5" />}
        </button>
      </div>
      {editing && (
        <form onSubmit={(e) => { e.preventDefault(); if (adding.trim() && !addItem(kind, pubkey, adding)) toast.error(kind === 'relays' ? 'That is not a wss:// relay (relay.primal.net is not allowed)' : 'Type a hashtag'); setAdding(''); }} className="flex gap-2 mt-1.5">
          <input value={adding} onChange={(e) => setAdding(e.target.value)} placeholder={kind === 'tags' ? 'add a hashtag' : 'add a relay, e.g. relay.example.com'} autoCapitalize="none" autoCorrect="off" spellCheck={false}
            className="flex-1 min-w-0 bg-white/5 border border-white/10 rounded-full px-3 py-1.5 text-[14px] outline-none focus:border-purple-500/50" data-testid={`add-${kind}`} />
          <button type="submit" className="px-3 py-1.5 bg-white/10 rounded-full text-[13px]">Add</button>
        </form>
      )}
      {pubkey && isDirty(list) && (
        <button type="button" onClick={sync} disabled={syncing} className="mt-1 flex items-center gap-1.5 text-[12px] text-purple-300 hover:text-purple-200 disabled:opacity-60" data-testid={`sync-${kind}`}>
          {syncing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CloudUpload className="w-3.5 h-3.5" />}
          Save this list to Nostr so your other apps see it
        </button>
      )}
    </div>
  );
}
