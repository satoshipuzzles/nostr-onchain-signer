import { useState } from 'react';
import { createMessageId } from '@/shared/messages';
import { Lock } from 'lucide-react';

interface Props {
  onUnlocked: (publicKey: string, password: string) => void;
}

export function Unlock({ onUnlocked }: Props) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

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
      } else {
        onUnlocked(response.result.publicKey, password);
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to unlock');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="h-full flex flex-col items-center justify-center p-6">
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
    </div>
  );
}
