import { useState } from 'react';
import { ShieldCheck, KeyRound, Eye } from 'lucide-react';
import { nip19 } from 'nostr-tools';
import { bytesToHex } from '@noble/hashes/utils';
import { createVault, generateAccount, addSigningAccount, addWatchOnlyAccount } from '../lib/vault';

type Mode = 'create' | 'import' | 'watch';

export function Onboarding() {
  const [step, setStep] = useState<'intro' | 'password' | 'key'>('intro');
  const [mode, setMode] = useState<Mode>('create');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [keyInput, setKeyInput] = useState('');
  const [label, setLabel] = useState('Main wallet');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function handlePassword(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (password !== confirm) {
      setError('Passwords do not match');
      return;
    }
    try {
      setBusy(true);
      await createVault(password);
      setStep('key');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create vault');
    } finally {
      setBusy(false);
    }
  }

  async function handleKey(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      if (mode === 'create') {
        await generateAccount(label || 'Main wallet');
      } else if (mode === 'import') {
        let hexKey = keyInput.trim();
        if (hexKey.startsWith('nsec1')) {
          const decoded = nip19.decode(hexKey);
          if (decoded.type !== 'nsec') throw new Error('Invalid nsec');
          hexKey = bytesToHex(decoded.data);
        }
        await addSigningAccount(hexKey, label || 'Imported wallet');
      } else {
        const input = keyInput.trim();
        if (/^(bc1|tb1)/i.test(input)) {
          await addWatchOnlyAccount({ address: input, label: label || 'Watch-only' });
        } else {
          let pubkeyHex = input;
          if (input.startsWith('npub1')) {
            const decoded = nip19.decode(input);
            if (decoded.type !== 'npub') throw new Error('Invalid npub');
            pubkeyHex = decoded.data;
          }
          await addWatchOnlyAccount({ pubkeyHex, label: label || 'Watch-only' });
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add account');
      setBusy(false);
      return;
    }
    setBusy(false);
  }

  if (step === 'intro') {
    return (
      <div className="min-h-screen flex items-center justify-center p-6 safe-top safe-bottom">
        <div className="max-w-sm w-full space-y-6 text-center">
          <img src="/icon.svg" alt="" className="w-20 h-20 mx-auto" />
          <div>
            <h1 className="text-2xl font-bold">Bitcoin Wallet Manager</h1>
            <p className="text-stone-400 text-sm mt-2">
              Sparrow-style control with Nostr built in. Offline-first, keys stay on this device, connect your own node
              if you want.
            </p>
          </div>
          <div className="space-y-2 text-left">
            {(
              [
                { m: 'create' as Mode, icon: ShieldCheck, title: 'Create new wallet', sub: 'Generate a fresh key on this device' },
                { m: 'import' as Mode, icon: KeyRound, title: 'Import key', sub: 'nsec or 64-char hex private key' },
                { m: 'watch' as Mode, icon: Eye, title: 'Watch-only', sub: 'npub, pubkey, or bc1 address — no signing' },
              ]
            ).map(({ m, icon: Icon, title, sub }) => (
              <button
                key={m}
                onClick={() => {
                  setMode(m);
                  setStep('password');
                }}
                className="card w-full flex items-center gap-3 text-left hover:border-accent transition-colors"
              >
                <Icon size={22} className="text-accent shrink-0" />
                <div>
                  <div className="font-semibold text-sm">{title}</div>
                  <div className="text-xs text-stone-400">{sub}</div>
                </div>
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (step === 'password') {
    return (
      <div className="min-h-screen flex items-center justify-center p-6 safe-top safe-bottom">
        <form onSubmit={handlePassword} className="max-w-sm w-full space-y-4">
          <h2 className="text-xl font-bold">Set a vault password</h2>
          <p className="text-stone-400 text-sm">
            Your keys are encrypted on this device with scrypt + AES-256-GCM. There is no recovery — write it down.
          </p>
          <div>
            <label className="label">Password (min 8 chars)</label>
            <input type="password" className="input" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
          </div>
          <div>
            <label className="label">Confirm</label>
            <input type="password" className="input" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          </div>
          {error && <p className="text-red-400 text-sm">{error}</p>}
          <button type="submit" className="btn-primary w-full" disabled={busy || password.length < 8}>
            {busy ? 'Encrypting…' : 'Continue'}
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-6 safe-top safe-bottom">
      <form onSubmit={handleKey} className="max-w-sm w-full space-y-4">
        <h2 className="text-xl font-bold">
          {mode === 'create' ? 'Name your wallet' : mode === 'import' ? 'Import your key' : 'Add watch-only'}
        </h2>
        <div>
          <label className="label">Label</label>
          <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} />
        </div>
        {mode !== 'create' && (
          <div>
            <label className="label">{mode === 'import' ? 'nsec or hex private key' : 'npub, hex pubkey, or bc1 address'}</label>
            <textarea
              className="input font-mono text-xs"
              rows={3}
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              placeholder={mode === 'import' ? 'nsec1…' : 'npub1… / bc1p…'}
            />
          </div>
        )}
        {error && <p className="text-red-400 text-sm">{error}</p>}
        <button type="submit" className="btn-primary w-full" disabled={busy}>
          {busy ? 'Working…' : 'Finish setup'}
        </button>
      </form>
    </div>
  );
}
