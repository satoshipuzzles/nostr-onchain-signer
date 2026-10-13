import { useState, useEffect } from 'react';
import { Zap, Check, Eye, EyeOff } from 'lucide-react';
import { parseNwcUri, loadNwcConnection, saveNwcConnection, type LightningChain } from '@/lib/nostr/nwc';

const COPY: Record<LightningChain, { title: string; idle: string; hint: string }> = {
  xbt: {
    title: 'XBT Lightning wallet',
    idle: 'Zap on the XBT Lightning network',
    hint: 'Create a connection on your XBT Lightning node (NWC) and paste it here. Set a daily budget there.',
  },
  btc: {
    title: 'BTC Lightning wallet',
    idle: 'Zap on the BTC Lightning network',
    hint: 'Get a connection string from Alby, Mutiny, or any NWC-compatible wallet.',
  },
};

/** One Nostr Wallet Connect slot. XBT and BTC Lightning each get their own. */
export function NwcWalletCard({ chain, className = '' }: { chain: LightningChain; className?: string }) {
  const [uri, setUri] = useState('');
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [showUri, setShowUri] = useState(false);
  const copy = COPY[chain];

  useEffect(() => {
    loadNwcConnection(chain).then((conn) => setConnected(!!conn));
  }, [chain]);

  async function handleSave() {
    setError('');
    if (!uri.trim()) return;
    const parsed = parseNwcUri(uri);
    if (!parsed) {
      setError('Invalid NWC connection string');
      return;
    }
    setSaving(true);
    try {
      await saveNwcConnection(parsed, chain);
      setConnected(true);
      setUri('');
    } catch {
      setError('Failed to save connection');
    } finally {
      setSaving(false);
    }
  }

  async function handleDisconnect() {
    await saveNwcConnection(null, chain);
    setConnected(false);
    setUri('');
  }

  return (
    <div className={`card ${className}`}>
      <div className="flex items-center gap-3 mb-3">
        <Zap className={`w-5 h-5 ${connected ? 'text-bitcoin' : 'text-gray-400'}`} />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium">{copy.title}</p>
          <p className="text-xs text-gray-500">{connected ? 'Wallet connected' : copy.idle}</p>
        </div>
        {connected && (
          <div className="flex items-center gap-1.5">
            <Check className="w-4 h-4 text-green-400" />
            <button
              onClick={handleDisconnect}
              className="text-xs text-red-400 hover:text-red-300 transition-colors"
            >
              Disconnect
            </button>
          </div>
        )}
      </div>
      {!connected && (
        <>
          <div className="relative">
            <input
              type={showUri ? 'text' : 'password'}
              value={uri}
              onChange={(e) => { setUri(e.target.value); setError(''); }}
              placeholder="nostr+walletconnect://..."
              className="w-full bg-surface-700/50 rounded-lg px-3 py-2 pr-9 text-xs text-white placeholder-gray-600 outline-none border border-surface-200/10 focus:border-bitcoin/30 font-mono"
            />
            <button
              onClick={() => setShowUri(!showUri)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300"
            >
              {showUri ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
            </button>
          </div>
          {error && <p className="text-xs text-red-400 mt-1.5">{error}</p>}
          <button
            onClick={handleSave}
            disabled={!uri.trim() || saving}
            className="mt-2 w-full py-2 bg-bitcoin text-black rounded-lg text-xs font-medium disabled:opacity-50 hover:bg-bitcoin/90 transition-colors"
          >
            {saving ? 'Connecting...' : 'Connect Wallet'}
          </button>
          <p className="text-[10px] text-gray-600 mt-2">{copy.hint}</p>
        </>
      )}
    </div>
  );
}
