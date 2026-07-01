import { useState, useRef } from 'react';
import { createMessageId } from '@/shared/messages';
import { encryptVault, saveVault, clearVault, type VaultData } from '@/lib/crypto/vault';
import { generateKeyPair, keyPairFromPrivateKey, nsecToPrivkey, isValidNsec, pubkeyToNpub } from '@/lib/nostr/keys';
import { Shield, Key, Import, Upload, AlertTriangle, FileUp, Globe } from 'lucide-react';

interface Props {
  onCreated: (publicKey: string, password: string) => void;
}

type Step = 'choose' | 'generate' | 'import' | 'import-file' | 'nip07' | 'password';

export function Setup({ onCreated }: Props) {
  const [step, setStep] = useState<Step>('choose');
  const [keysToImport, setKeysToImport] = useState<VaultData[]>([]);
  const [privateKey, setPrivateKey] = useState('');
  const [publicKey, setPublicKey] = useState('');
  const [nsecInput, setNsecInput] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function handleGenerate() {
    const pair = generateKeyPair();
    setPrivateKey(pair.privateKeyHex);
    setPublicKey(pair.publicKeyHex);
    setKeysToImport([{
      privateKeyHex: pair.privateKeyHex,
      publicKeyHex: pair.publicKeyHex,
      createdAt: Date.now(),
      label: 'Primary Key',
    }]);
    setStep('password');
  }

  function handleImport() {
    setStep('import');
  }

  async function handleNip07Login() {
    setError('');
    setLoading(true);
    try {
      const nostr = (window as any).nostr;
      if (!nostr) {
        setError('No NIP-07 extension found. Install Alby, nos2x, or another Nostr signer extension.');
        return;
      }
      const pubkey = await nostr.getPublicKey();
      if (!pubkey) throw new Error('No public key returned');
      setPublicKey(pubkey);

      // For NIP-07 login, we create a read-only vault entry (no private key stored)
      setKeysToImport([{
        privateKeyHex: '', // empty = read-only, signing delegated to external extension
        publicKeyHex: pubkey,
        createdAt: Date.now(),
        label: 'NIP-07 (External Signer)',
      }]);
      setStep('password');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'NIP-07 login failed');
    } finally {
      setLoading(false);
    }
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
    setKeysToImport([{
      privateKeyHex: pair.privateKeyHex,
      publicKeyHex: pair.publicKeyHex,
      createdAt: Date.now(),
      label: 'Imported Key',
    }]);
    setStep('password');
  }

  function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      const text = event.target?.result as string;
      if (!text) { setError('Could not read file'); return; }

      try {
        const keys = parseBackupFile(text);
        if (keys.length === 0) {
          setError('No valid keys found in file. Make sure it contains nsec keys.');
          return;
        }
        setKeysToImport(keys);
        setPrivateKey(keys[0].privateKeyHex);
        setPublicKey(keys[0].publicKeyHex);
        setStep('password');
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to parse backup file');
      }
    };
    reader.readAsText(file);
    e.target.value = '';
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
      const vaultData: VaultData[] = keysToImport.length > 0
        ? keysToImport
        : [{
            privateKeyHex: privateKey,
            publicKeyHex: publicKey,
            createdAt: Date.now(),
            label: 'Primary Key',
          }];

      const encrypted = await encryptVault(vaultData, password);
      await saveVault(encrypted);

      // Unlock immediately
      await chrome.runtime.sendMessage({
        type: 'vault:unlock',
        payload: { password },
        id: createMessageId(),
      });

      onCreated(publicKey, password);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to create vault');
    } finally {
      setLoading(false);
    }
  }

  // ─── CHOOSE STEP ────────────────────────────────────────────

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

        {error && <p className="text-red-400 text-sm mb-4 text-center">{error}</p>}

        <div className="w-full space-y-3">
          {typeof (window as any).nostr !== 'undefined' && (
            <button onClick={handleNip07Login} disabled={loading} className="btn-primary w-full flex items-center justify-center gap-2">
              <Globe className="w-4 h-4" />
              {loading ? 'Connecting...' : 'Login with NIP-07 Extension'}
            </button>
          )}
          <button onClick={handleGenerate} className="btn-primary w-full flex items-center justify-center gap-2">
            <Key className="w-4 h-4" />
            Generate New Key
          </button>
          <button onClick={handleImport} className="btn-secondary w-full flex items-center justify-center gap-2">
            <Import className="w-4 h-4" />
            Import nsec
          </button>
          <button
            onClick={() => setStep('import-file')}
            className="btn-secondary w-full flex items-center justify-center gap-2"
          >
            <FileUp className="w-4 h-4" />
            Restore from Backup File
          </button>
        </div>
      </div>
    );
  }

  // ─── IMPORT FILE STEP ───────────────────────────────────────

  if (step === 'import-file') {
    return (
      <div className="h-full flex flex-col p-6">
        <h2 className="text-lg font-bold mb-2">Restore from Backup</h2>
        <p className="text-gray-400 text-sm mb-6">
          Upload the backup .txt file you downloaded earlier. All accounts in the file will be restored.
        </p>

        <div className="flex-1 flex flex-col items-center justify-center">
          <button
            onClick={() => fileInputRef.current?.click()}
            className="w-full max-w-[280px] h-40 border-2 border-dashed border-surface-200/30 rounded-2xl flex flex-col items-center justify-center gap-3 hover:border-bitcoin/50 transition-colors"
          >
            <Upload className="w-10 h-10 text-gray-500" />
            <span className="text-sm text-gray-400">Tap to select backup file</span>
            <span className="text-[10px] text-gray-600">.txt file with nsec keys</span>
          </button>

          <input
            ref={fileInputRef}
            type="file"
            accept=".txt,text/plain"
            onChange={handleFileUpload}
            className="hidden"
          />
        </div>

        {error && (
          <p className="text-red-400 text-sm mb-4">{error}</p>
        )}

        <button onClick={() => { setStep('choose'); setError(''); }} className="btn-secondary w-full">
          Back
        </button>
      </div>
    );
  }

  // ─── IMPORT NSEC STEP ───────────────────────────────────────

  if (step === 'import') {
    return (
      <div className="h-full flex flex-col p-6">
        <h2 className="text-lg font-bold mb-4">Import Key</h2>
        <form onSubmit={handleImportSubmit} className="space-y-4 flex-1">
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
          <button type="button" onClick={() => { setStep('choose'); setError(''); }} className="btn-secondary w-full">
            Back
          </button>
        </form>
      </div>
    );
  }

  // ─── SET PASSWORD STEP ──────────────────────────────────────

  return (
    <div className="h-full flex flex-col p-6">
      <h2 className="text-lg font-bold mb-2">Set Password</h2>
      <p className="text-gray-400 text-sm mb-4">
        {keysToImport.length > 1
          ? `Restoring ${keysToImport.length} accounts. Choose a password to encrypt them.`
          : 'This encrypts your keys locally. Choose a strong password.'}
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
          {loading ? 'Creating...' : keysToImport.length > 1 ? `Restore ${keysToImport.length} Accounts` : 'Create Vault'}
        </button>
      </form>
    </div>
  );
}

// ─── BACKUP FILE PARSER ──────────────────────────────────────────

function parseBackupFile(text: string): VaultData[] {
  const keys: VaultData[] = [];
  const lines = text.split('\n');

  let currentLabel = '';

  for (const line of lines) {
    const trimmed = line.trim();

    // Parse account labels: "--- Account 1: Primary Key ---"
    const labelMatch = trimmed.match(/^---\s*Account\s*\d+:\s*(.+?)\s*---$/);
    if (labelMatch) {
      currentLabel = labelMatch[1];
      continue;
    }

    // Parse nsec lines: "nsec: nsec1..."
    const nsecMatch = trimmed.match(/^nsec:\s*(nsec1\w+)$/);
    if (nsecMatch) {
      const nsec = nsecMatch[1];
      try {
        if (isValidNsec(nsec)) {
          const privHex = nsecToPrivkey(nsec);
          const pair = keyPairFromPrivateKey(privHex);
          keys.push({
            privateKeyHex: pair.privateKeyHex,
            publicKeyHex: pair.publicKeyHex,
            createdAt: Date.now(),
            label: currentLabel || `Account ${keys.length + 1}`,
          });
        }
      } catch {}
      continue;
    }

    // Also try bare nsec on a line by itself
    if (trimmed.startsWith('nsec1') && trimmed.length > 60) {
      try {
        if (isValidNsec(trimmed)) {
          const privHex = nsecToPrivkey(trimmed);
          const pair = keyPairFromPrivateKey(privHex);
          keys.push({
            privateKeyHex: pair.privateKeyHex,
            publicKeyHex: pair.publicKeyHex,
            createdAt: Date.now(),
            label: currentLabel || `Account ${keys.length + 1}`,
          });
        }
      } catch {}
    }
  }

  return keys;
}
