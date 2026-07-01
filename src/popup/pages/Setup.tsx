import { useState } from 'react';
import { createMessageId } from '@/shared/messages';
import { encryptVault, saveVault, type VaultData } from '@/lib/crypto/vault';
import { generateKeyPair, keyPairFromPrivateKey, nsecToPrivkey, isValidNsec } from '@/lib/nostr/keys';
import { Shield, Key, Import } from 'lucide-react';

interface Props {
  onCreated: (publicKey: string) => void;
}

type Step = 'choose' | 'generate' | 'import' | 'password';

export function Setup({ onCreated }: Props) {
  const [step, setStep] = useState<Step>('choose');
  const [privateKey, setPrivateKey] = useState('');
  const [publicKey, setPublicKey] = useState('');
  const [nsecInput, setNsecInput] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  function handleGenerate() {
    const pair = generateKeyPair();
    setPrivateKey(pair.privateKeyHex);
    setPublicKey(pair.publicKeyHex);
    setStep('password');
  }

  function handleImport() {
    setStep('import');
  }

  function handleImportSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');

    if (!isValidNsec(nsecInput)) {
      setError('Invalid nsec key');
      return;
    }

    const privHex = nsecToPrivkey(nsecInput);
    const pair = keyPairFromPrivateKey(privHex);
    setPrivateKey(pair.privateKeyHex);
    setPublicKey(pair.publicKeyHex);
    setStep('password');
  }

  async function handleCreateVault(e: React.FormEvent) {
    e.preventDefault();
    setError('');

    if (password.length < 8) {
      setError('Password must be at least 8 characters');
      return;
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }

    setLoading(true);
    try {
      const vaultData: VaultData[] = [
        {
          privateKeyHex: privateKey,
          publicKeyHex: publicKey,
          createdAt: Date.now(),
          label: 'Primary Key',
        },
      ];

      const encrypted = await encryptVault(vaultData, password);
      await saveVault(encrypted);

      // Unlock immediately
      await chrome.runtime.sendMessage({
        type: 'vault:unlock',
        payload: { password },
        id: createMessageId(),
      });

      onCreated(publicKey);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to create vault');
    } finally {
      setLoading(false);
    }
  }

  if (step === 'choose') {
    return (
      <div className="h-full flex flex-col items-center justify-center p-6">
        <div className="w-16 h-16 rounded-full bg-gradient-to-br from-bitcoin to-nostr flex items-center justify-center mb-6">
          <Shield className="w-8 h-8 text-white" />
        </div>

        <h1 className="text-xl font-bold mb-2">Nostr Onchain Signer</h1>
        <p className="text-gray-400 text-sm mb-8 text-center">
          Dual signer for Bitcoin &amp; Nostr
        </p>

        <div className="w-full space-y-3">
          <button onClick={handleGenerate} className="btn-primary w-full flex items-center justify-center gap-2">
            <Key className="w-4 h-4" />
            Generate New Key
          </button>
          <button onClick={handleImport} className="btn-secondary w-full flex items-center justify-center gap-2">
            <Import className="w-4 h-4" />
            Import nsec
          </button>
        </div>
      </div>
    );
  }

  if (step === 'import') {
    return (
      <div className="h-full flex flex-col p-6">
        <h2 className="text-lg font-bold mb-4">Import Key</h2>
        <form onSubmit={handleImportSubmit} className="space-y-4">
          <div>
            <label className="text-sm text-gray-400 mb-1 block">nsec key</label>
            <input
              type="password"
              value={nsecInput}
              onChange={(e) => setNsecInput(e.target.value)}
              placeholder="nsec1..."
              className="input-field font-mono text-sm"
              autoFocus
            />
          </div>
          {error && <p className="text-red-400 text-sm">{error}</p>}
          <button type="submit" className="btn-primary w-full">
            Continue
          </button>
          <button type="button" onClick={() => setStep('choose')} className="btn-secondary w-full">
            Back
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col p-6">
      <h2 className="text-lg font-bold mb-2">Set Password</h2>
      <p className="text-gray-400 text-sm mb-4">
        This encrypts your keys locally. Choose a strong password.
      </p>

      <form onSubmit={handleCreateVault} className="space-y-4">
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password (min 8 characters)"
          className="input-field"
          autoFocus
        />
        <input
          type="password"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          placeholder="Confirm password"
          className="input-field"
        />
        {error && <p className="text-red-400 text-sm">{error}</p>}
        <button type="submit" disabled={loading} className="btn-primary w-full">
          {loading ? 'Creating...' : 'Create Vault'}
        </button>
      </form>
    </div>
  );
}
