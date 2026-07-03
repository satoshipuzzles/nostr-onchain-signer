import { ShieldCheck, X } from 'lucide-react';
import { pubkeyToNpub } from '@/lib/nostr/keys';
import { KIND } from '@/lib/nostr/events';
import { type SigningRequest } from '@/popup/context/AuthContext';

interface Props {
  request: SigningRequest;
}

function kindLabel(kind: number): string {
  switch (kind) {
    case KIND.METADATA: return 'Profile Update';
    case KIND.TEXT_NOTE: return 'Note';
    case KIND.CONTACTS: return 'Follow List';
    case KIND.DM: return 'Direct Message';
    case KIND.REPOST: return 'Repost';
    case KIND.REACTION: return 'Reaction';
    case KIND.ZAP_REQUEST: return 'Zap Request';
    default: return `Kind ${kind}`;
  }
}

function contentPreview(content: string, kind: number): string {
  if (kind === KIND.METADATA) {
    try {
      const parsed = JSON.parse(content);
      return `Name: ${parsed.display_name || parsed.name || 'unnamed'}`;
    } catch {
      return content.slice(0, 120);
    }
  }
  if (kind === KIND.CONTACTS) return '(contact list update)';
  if (!content) return '(empty)';
  return content.length > 120 ? content.slice(0, 120) + '…' : content;
}

export function SigningConfirmation({ request }: Props) {
  const { event, onConfirm, onCancel } = request;
  const npub = pubkeyToNpub(event.pubkey);

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-[340px] bg-surface-800 border border-surface-200/20 rounded-2xl shadow-2xl p-5 mx-4">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-5 h-5 text-bitcoin" />
            <h3 className="text-base font-semibold">Confirm Signing</h3>
          </div>
          <button onClick={onCancel} className="p-1 hover:bg-surface-700 rounded-lg transition-colors">
            <X className="w-4 h-4 text-gray-400" />
          </button>
        </div>

        <div className="space-y-3 mb-5">
          <div className="bg-surface-900/50 rounded-lg p-3">
            <p className="text-xs text-gray-400 mb-1">Event Type</p>
            <p className="text-sm font-medium">{kindLabel(event.kind)}</p>
          </div>

          <div className="bg-surface-900/50 rounded-lg p-3">
            <p className="text-xs text-gray-400 mb-1">Content Preview</p>
            <p className="text-sm text-gray-200 break-words">{contentPreview(event.content, event.kind)}</p>
          </div>

          <div className="bg-surface-900/50 rounded-lg p-3">
            <p className="text-xs text-gray-400 mb-1">Signing As</p>
            <p className="text-xs font-mono text-bitcoin truncate">{npub}</p>
          </div>
        </div>

        <div className="flex gap-3">
          <button
            onClick={onCancel}
            className="flex-1 py-2.5 px-4 rounded-xl border border-surface-200/20 text-sm font-medium hover:bg-surface-700 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="flex-1 py-2.5 px-4 rounded-xl bg-bitcoin text-black text-sm font-semibold hover:bg-bitcoin/90 transition-colors"
          >
            Confirm
          </button>
        </div>
      </div>
    </div>
  );
}
