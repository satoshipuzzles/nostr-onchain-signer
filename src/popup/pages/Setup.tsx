import { useState, useRef } from 'react';
import { createMessageId } from '@/shared/messages';
import { encryptVault, saveVault, clearVault, type VaultData } from '@/lib/crypto/vault';
import { generateKeyPair, keyPairFromPrivateKey, nsecToPrivkey, isValidNsec, pubkeyToNpub } from '@/lib/nostr/keys';
import { Shield, Key, Import, Upload, AlertTriangle, FileUp, Globe } from 'lucide-react';
import { detectNostrSignerType, nip07SignerLabel } from '@/lib/bitcoin/psbt-external-sign';

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

      const signerType = detectNostrSignerType();
      setKeysToImport([{
        privateKeyHex: '',
        publicKeyHex: pubkey,
        createdAt: Date.now(),
        label: `${nip07SignerLabel(signerType)} (Extension)`,
        externalSigner: true,
        signerType,
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

  // ─── CHOOSE STEP (Landing Page) ─────────────────────────────

  if (step === 'choose') {
    return (
      <div className="min-h-screen overflow-y-auto">
        {/* Hero Section */}
        <div className="flex flex-col items-center justify-center p-6 pt-12 pb-8">
          <img src="/logo.svg" alt="Nostr Onchain" className="w-16 h-16 mb-5" />

          <h1 className="text-2xl font-bold mb-2 text-center">Nostr Onchain</h1>
          <p className="text-gray-400 text-sm mb-1 text-center">
            Social Multi-Sig Bitcoin Signer
          </p>
          <p className="text-gray-500 text-xs text-center max-w-[280px] mb-8">
            Create multi-sig wallets from your Nostr network. Sign Bitcoin transactions and Nostr events from one place.
          </p>

          {error && <p className="text-red-400 text-sm mb-4 text-center">{error}</p>}

          {/* Auth Actions */}
          <div className="w-full space-y-3 mb-8">
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
              Restore from Backup
            </button>
          </div>
        </div>

        {/* Features Section */}
        <div className="px-6 pb-6">
          <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-3">How it works</p>
          <div className="space-y-3 mb-8">
            <div className="flex items-start gap-3 p-3 rounded-xl bg-white/5 border border-white/5">
              <div className="w-8 h-8 rounded-lg bg-white/10 flex items-center justify-center flex-shrink-0">
                <Shield className="w-4 h-4 text-white" />
              </div>
              <div>
                <p className="text-sm font-medium">Social Multi-Sig</p>
                <p className="text-xs text-gray-500">Create Taproot multi-sig wallets using npubs from your Nostr contacts</p>
              </div>
            </div>
            <div className="flex items-start gap-3 p-3 rounded-xl bg-white/5 border border-white/5">
              <div className="w-8 h-8 rounded-lg bg-white/10 flex items-center justify-center flex-shrink-0">
                <Key className="w-4 h-4 text-white" />
              </div>
              <div>
                <p className="text-sm font-medium">Dual Signer</p>
                <p className="text-xs text-gray-500">NIP-07 Nostr signer + Bitcoin transaction signing in one extension</p>
              </div>
            </div>
            <div className="flex items-start gap-3 p-3 rounded-xl bg-white/5 border border-white/5">
              <div className="w-8 h-8 rounded-lg bg-white/10 flex items-center justify-center flex-shrink-0">
                <Globe className="w-4 h-4 text-white" />
              </div>
              <div>
                <p className="text-sm font-medium">On-Chain Invoices</p>
                <p className="text-xs text-gray-500">Request Bitcoin payments via Nostr with OP_RETURN proof of settlement</p>
              </div>
            </div>
          </div>

          {/* Download / Platform Section */}
          <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-3">Get it</p>
          <div className="space-y-2 mb-8">
            <a
              href="https://github.com/satoshipuzzles/nostr-onchain-signer"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-3 px-4 py-3 rounded-xl bg-white/5 border border-white/10 hover:bg-white/10 transition-colors"
            >
              <div className="w-8 h-8 rounded-lg bg-white/10 flex items-center justify-center flex-shrink-0">
                <svg className="w-4 h-4 text-white" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.3 3.44 9.8 8.2 11.39.6.11.82-.26.82-.58v-2.03c-3.34.73-4.04-1.61-4.04-1.61-.55-1.39-1.34-1.76-1.34-1.76-1.09-.74.08-.73.08-.73 1.2.08 1.84 1.24 1.84 1.24 1.07 1.83 2.81 1.3 3.5 1 .11-.78.42-1.3.76-1.6-2.67-.3-5.47-1.33-5.47-5.93 0-1.31.47-2.38 1.24-3.22-.13-.3-.54-1.52.12-3.18 0 0 1-.32 3.3 1.23a11.5 11.5 0 016.02 0c2.28-1.55 3.29-1.23 3.29-1.23.66 1.66.25 2.88.12 3.18.77.84 1.24 1.91 1.24 3.22 0 4.61-2.81 5.63-5.48 5.93.43.37.81 1.1.81 2.22v3.29c0 .32.22.7.82.58C20.56 21.8 24 17.3 24 12c0-6.63-5.37-12-12-12z"/></svg>
              </div>
              <div className="flex-1">
                <p className="text-sm font-medium">GitHub</p>
                <p className="text-[10px] text-gray-500">Source code &amp; extension download</p>
              </div>
            </a>
            <a
              href="https://nostr-onchain-signer.vercel.app"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-3 px-4 py-3 rounded-xl bg-white/5 border border-white/10 hover:bg-white/10 transition-colors"
            >
              <div className="w-8 h-8 rounded-lg bg-white/10 flex items-center justify-center flex-shrink-0">
                <Globe className="w-4 h-4 text-white" />
              </div>
              <div className="flex-1">
                <p className="text-sm font-medium">Web App / PWA</p>
                <p className="text-[10px] text-gray-500">Use on mobile — add to home screen</p>
              </div>
            </a>
            <div className="flex items-center gap-3 px-4 py-3 rounded-xl bg-white/5 border border-white/10 opacity-60">
              <div className="w-8 h-8 rounded-lg bg-white/10 flex items-center justify-center flex-shrink-0">
                <Import className="w-4 h-4 text-white" />
              </div>
              <div className="flex-1">
                <p className="text-sm font-medium">Chrome Extension</p>
                <p className="text-[10px] text-gray-500">Load unpacked from GitHub dist/ folder</p>
              </div>
            </div>
          </div>

          {/* Footer */}
          <div className="text-center pb-6">
            <p className="text-[10px] text-gray-600">
              Built with Nostr &bull; Taproot &bull; BIP-342 Tapscript
            </p>
            <p className="text-[10px] text-gray-700 mt-1">
              NIP-07 &bull; NIP-04 &bull; Custom Kinds 9733, 9800-9802
            </p>
          </div>
        </div>
      </div>
    );
  }

  // ─── IMPORT FILE STEP ───────────────────────────────────────

  if (step === 'import-file') {
    return (
      <div className="min-h-screen flex flex-col p-6">
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
      <div className="min-h-screen flex flex-col p-6">
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
    <div className="min-h-screen flex flex-col p-6">
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
