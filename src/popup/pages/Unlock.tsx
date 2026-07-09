import { useState } from 'react';
import { createMessageId } from '@/shared/messages';
import { clearVault } from '@/lib/crypto/vault';
import { Lock, AlertTriangle, Trash2 } from 'lucide-react';

interface Props {
  onUnlocked: (publicKey: string, password: string) => void;
  onReset?: () => void;
}

export function Unlock({ onUnlocked, onReset }: Props) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [showReset, setShowReset] = useState(false);
  const [resetConfirm, setResetConfirm] = useState('');

  async function handleUnlock(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const response = await chrome.runtime.sendMessage({
        type: 'vault:unlock',
        payload: { password },
        id: createMessageId(),
      });

      if (response.error) {
        setError(response.error);
      } else if (response.result?.publicKey) {
        onUnlocked(response.result.publicKey, password);
      } else {
        setError('Unlock failed — vault may be corrupted. Use "Reset" below to start fresh.');
      }
    } catch (err: unknown) {
      setError('Unlock failed. If you keep getting this error, reset and restore from backup.');
    } finally {
      setLoading(false);
    }
  }

  async function handleReset() {
    if (resetConfirm !== 'RESET') return;
    try {
      await clearVault();
      // Clear all local data
      if (typeof chrome !== 'undefined' && chrome.storage?.local) {
        await chrome.storage.local.remove(['vault']);
      }
      // Also clear localStorage in PWA mode
      const keys = Object.keys(localStorage);
      for (const key of keys) {
        if (key.startsWith('nostr_onchain_')) {
          localStorage.removeItem(key);
        }
      }
      sessionStorage.clear();
      if (onReset) onReset();
      else window.location.reload();
    } catch {
      window.location.reload();
    }
  }

  if (showReset) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center p-6">
        <div className="w-14 h-14 rounded-full bg-red-500/20 flex items-center justify-center mb-4">
          <AlertTriangle className="w-7 h-7 text-red-400" />
        </div>

        <h2 className="text-lg font-bold mb-2 text-red-400">Reset Vault</h2>
        <p className="text-gray-400 text-sm mb-4 text-center">
          This will delete all stored keys. You will need to restore from a backup file or import your nsec again.
        </p>
        <p className="text-gray-500 text-xs mb-6 text-center">
          Type <span className="text-red-400 font-mono font-bold">RESET</span> to confirm:
        </p>

        <input
          type="text"
          value={resetConfirm}
          onChange={(e) => setResetConfirm(e.target.value.toUpperCase())}
          placeholder="Type RESET"
          className="input-field text-center font-mono mb-4"
          autoFocus
        />

        <div className="w-full space-y-2">
          <button
            onClick={handleReset}
            disabled={resetConfirm !== 'RESET'}
            className="w-full py-3 bg-red-500 hover:bg-red-600 disabled:opacity-40 disabled:cursor-not-allowed text-white font-semibold rounded-xl flex items-center justify-center gap-2 transition-colors"
          >
            <Trash2 className="w-4 h-4" />
            Delete Vault & Reset
          </button>
          <button onClick={() => setShowReset(false)} className="btn-secondary w-full">
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-6">
      <div className="w-16 h-16 rounded-full bg-bitcoin/20 flex items-center justify-center mb-6">
        <Lock className="w-8 h-8 text-bitcoin" />
      </div>

      <h1 className="text-xl font-bold mb-2">Nostr Onchain Signer</h1>
      <p className="text-gray-400 text-sm mb-8 text-center">
        Enter your password to unlock
      </p>

      <form onSubmit={handleUnlock} className="w-full space-y-4">
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
          className="input-field"
          autoFocus
        />

        {error && (
          <p className="text-red-400 text-sm">{error}</p>
        )}

        <button
          type="submit"
          disabled={!password || loading}
          className="btn-primary w-full"
        >
          {loading ? 'Unlocking...' : 'Unlock'}
        </button>
      </form>

      {/* Reset option - always visible */}
      <button
        onClick={() => setShowReset(true)}
        className="mt-8 text-xs text-gray-600 hover:text-red-400 transition-colors"
      >
        Forgot password? Reset vault & restore from backup
      </button>
    </div>
  );
}
