import { useState } from 'react';
import { unlockVault } from '../lib/vault';

export function Unlock() {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await unlockVault(password);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unlock failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-6 safe-top safe-bottom">
      <form onSubmit={handleSubmit} className="max-w-sm w-full space-y-5 text-center">
        <img src="/icon.svg" alt="" className="w-16 h-16 mx-auto" />
        <h1 className="text-xl font-bold">Unlock your vault</h1>
        <input
          type="password"
          className="input text-center"
          placeholder="Vault password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoFocus
        />
        {error && <p className="text-red-400 text-sm">{error}</p>}
        <button type="submit" className="btn-primary w-full" disabled={busy || !password}>
          {busy ? 'Decrypting…' : 'Unlock'}
        </button>
      </form>
    </div>
  );
}
