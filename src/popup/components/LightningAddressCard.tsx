import { useEffect, useState } from 'react';
import { AtSign, Check, Copy, Pencil } from 'lucide-react';
import { QRCode } from './QRCode';
import { addressToLnurl } from '@/lib/lightning/scan';
import type { LightningChain } from '@/lib/nostr/nwc';

const STORE_KEY = 'ln_receive_address_v1';

// Addresses served by known nodes, filled in when the user hasn't set one.
const NODE_ADDRESSES: Record<string, string> = {
  '0345a801f63d1cf94ce3ec1405b00edb30278a6473316235b3aa2c6c5ad4ca25': 'bigfoot@lightning.nostronchain.com',
};

function loadSaved(): Partial<Record<LightningChain, string>> {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
  } catch {
    return {};
  }
}

function save(chain: LightningChain, address: string) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ ...loadSaved(), [chain]: address }));
  } catch {
    /* storage blocked: the address just isn't remembered */
  }
}

/** The wallet's reusable Lightning Address, as a QR (LNURL) with one-tap copy. */
export function LightningAddressCard({ chain, nodePubkey }: { chain: LightningChain; nodePubkey?: string }) {
  const [address, setAddress] = useState('');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [copied, setCopied] = useState<'address' | 'lnurl' | null>(null);

  useEffect(() => {
    const a = loadSaved()[chain] ?? (nodePubkey && NODE_ADDRESSES[nodePubkey]) ?? '';
    setAddress(a);
    setEditing(false);
  }, [chain, nodePubkey]);

  const lnurl = address ? addressToLnurl(address) : null;

  async function copy(text: string, which: 'address' | 'lnurl') {
    await navigator.clipboard.writeText(text);
    setCopied(which);
    setTimeout(() => setCopied(null), 1500);
  }

  function commit() {
    const a = draft.trim().toLowerCase();
    if (a && !addressToLnurl(a)) return;
    save(chain, a);
    setAddress(a);
    setEditing(false);
  }

  if (editing || !address) {
    return (
      <div className="card">
        <p className="text-sm font-medium mb-1 flex items-center gap-1.5"><AtSign className="w-4 h-4" /> Lightning address</p>
        <p className="text-[11px] text-gray-500 mb-2">A reusable address anyone can pay any amount to, like name@domain.com.</p>
        <div className="flex gap-2">
          <input
            type="email" inputMode="email" autoCapitalize="none" spellCheck={false}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && commit()}
            placeholder="name@domain.com"
            className="flex-1 min-w-0 bg-surface-700/50 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 outline-none border border-surface-200/10 focus:border-bitcoin/30"
          />
          <button
            onClick={commit}
            disabled={!!draft.trim() && !addressToLnurl(draft)}
            className="px-4 rounded-lg bg-bitcoin text-black text-sm font-semibold disabled:opacity-40"
          >
            Save
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-3">
        <p className="text-sm font-medium flex items-center gap-1.5"><AtSign className="w-4 h-4" /> Lightning address</p>
        <button
          onClick={() => { setDraft(address); setEditing(true); }}
          className="text-[11px] text-gray-500 hover:text-white flex items-center gap-1"
        >
          <Pencil className="w-3 h-3" /> Change
        </button>
      </div>
      <div className="flex flex-col items-center">
        {lnurl && <QRCode data={`lightning:${lnurl}`} size={200} />}
        <button
          onClick={() => copy(address, 'address')}
          className="mt-3 max-w-full font-mono text-sm text-white break-all text-center"
          title="Tap to copy"
        >
          {address}
        </button>
        <p className="text-[10px] text-gray-500 mt-1">Any amount · {chain === 'xbt' ? 'XBT' : 'BTC'} Lightning only</p>
        <div className="grid grid-cols-2 gap-2 w-full mt-3">
          <button
            onClick={() => copy(address, 'address')}
            className="py-2.5 rounded-lg bg-white/10 text-xs flex items-center justify-center gap-1.5"
          >
            {copied === 'address' ? <Check className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4" />}
            {copied === 'address' ? 'Copied' : 'Copy address'}
          </button>
          <button
            onClick={() => lnurl && copy(lnurl, 'lnurl')}
            className="py-2.5 rounded-lg bg-white/10 text-xs flex items-center justify-center gap-1.5"
          >
            {copied === 'lnurl' ? <Check className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4" />}
            {copied === 'lnurl' ? 'Copied' : 'Copy LNURL'}
          </button>
        </div>
        {lnurl && (
          <p className="mt-2 w-full font-mono text-[10px] text-gray-600 break-all select-all">{lnurl}</p>
        )}
      </div>
    </div>
  );
}
