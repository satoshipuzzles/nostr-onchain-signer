import { useState } from 'react';
import { ChevronDown, Plus, Check, User } from 'lucide-react';
import { type Account } from '@/lib/accounts';

interface Props {
  accounts: Account[];
  activeIndex: number;
  onSwitch: (index: number) => void;
  onAddAccount: () => void;
}

export function AccountSwitcher({ accounts, activeIndex, onSwitch, onAddAccount }: Props) {
  const [open, setOpen] = useState(false);
  const active = accounts[activeIndex];

  if (!active) return null;

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 hover:bg-surface-700 rounded-lg px-2 py-1.5 transition-colors"
      >
        {active.picture ? (
          <img src={active.picture} alt="" className="w-7 h-7 rounded-full object-cover" />
        ) : (
          <div className="w-7 h-7 rounded-full bg-gradient-to-br from-bitcoin/40 to-nostr/40 flex items-center justify-center">
            <span className="text-xs font-bold">{(active.displayName || active.label).charAt(0)}</span>
          </div>
        )}
        <span className="text-sm font-medium truncate max-w-[100px]">
          {active.displayName || active.label}
        </span>
        <ChevronDown className={`w-3 h-3 text-gray-400 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute bottom-full left-0 mb-1 w-56 bg-surface-800 border border-surface-200/20 rounded-xl shadow-xl z-50 max-h-[60vh] overflow-y-auto">
            {accounts.map((account, idx) => (
              <button
                key={account.publicKeyHex}
                onClick={() => { onSwitch(idx); setOpen(false); }}
                className={`w-full flex items-center gap-3 px-3 py-2.5 text-left hover:bg-surface-700 transition-colors ${
                  idx === activeIndex ? 'bg-bitcoin/5' : ''
                }`}
              >
                {account.picture ? (
                  <img src={account.picture} alt="" className="w-8 h-8 rounded-full object-cover" />
                ) : (
                  <div className="w-8 h-8 rounded-full bg-gradient-to-br from-bitcoin/30 to-nostr/30 flex items-center justify-center">
                    <User className="w-3.5 h-3.5 text-white/60" />
                  </div>
                )}
                <div className="flex-1 min-w-0">
                  <p className="text-sm truncate">{account.displayName || account.label}</p>
                  <p className="text-[10px] text-gray-500 font-mono truncate">
                    {account.npub.slice(0, 16)}...
                  </p>
                </div>
                {idx === activeIndex && <Check className="w-4 h-4 text-bitcoin flex-shrink-0" />}
              </button>
            ))}
            <div className="border-t border-surface-200/10">
              <button
                onClick={() => { onAddAccount(); setOpen(false); }}
                className="w-full flex items-center gap-3 px-3 py-2.5 text-left hover:bg-surface-700 text-gray-400"
              >
                <div className="w-8 h-8 rounded-full border border-dashed border-gray-600 flex items-center justify-center">
                  <Plus className="w-3.5 h-3.5" />
                </div>
                <span className="text-sm">Add account</span>
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
