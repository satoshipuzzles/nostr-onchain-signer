import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Radio, Edit3, Download, Upload, Lock, Zap, Check, X, Eye, EyeOff, Key, Copy, CheckCircle2, Globe, FileText, Server, Smartphone } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { AccountSwitcher } from '../components/AccountSwitcher';
import { createMessageId } from '@/shared/messages';
import { parseNwcUri, loadNwcConnection, saveNwcConnection, type NwcConnection } from '@/lib/nostr/nwc';
import { connectRemoteSigner, disconnectRemoteSigner, loadRemoteConnection } from '@/lib/nostr/nip46';
import { loadVault, decryptVault } from '@/lib/crypto/vault';
import { replaceAccountNsec } from '@/lib/accounts';
import { privkeyToNsec, pubkeyToNpub } from '@/lib/nostr/keys';
import { loadMultisigWallets, walletToSyncConfig, syncConfigToWallet, saveMultisigWallet } from '@/lib/bitcoin/wallet-store';
import { type SyncableWalletConfig } from '@/lib/nostr/wallet-sync';
import { loadBitcoinNodeConfig, saveBitcoinNodeConfig, testNodeConnection, type BitcoinNodeConfig } from '@/lib/bitcoin/node';

export function Settings() {
  const navigate = useNavigate();
  const {
    publicKey, myProfile, accounts, activeAccountIndex,
    handleSwitchAccount, handleAddAccount, handleBackupKeys,
    vaultPassword,
  } = useAuth();

  const activeAccount = accounts[activeAccountIndex];
  const displayName = myProfile?.displayName || myProfile?.name || activeAccount?.displayName || activeAccount?.label || 'Anonymous';
  const npub = activeAccount?.npub || pubkeyToNpub(publicKey);

  const [nwcUri, setNwcUri] = useState('');
  const [nwcConnected, setNwcConnected] = useState(false);
  const [nwcError, setNwcError] = useState('');
  const [nwcSaving, setNwcSaving] = useState(false);
  const [showNwcUri, setShowNwcUri] = useState(false);

  const [nodeEnabled, setNodeEnabled] = useState(false);
  const [nodeRpcUrl, setNodeRpcUrl] = useState('http://127.0.0.1:8332');
  const [nodeRpcUser, setNodeRpcUser] = useState('');
  const [nodeRpcPassword, setNodeRpcPassword] = useState('');
  const [nodeStatus, setNodeStatus] = useState('');
  const [nodeTesting, setNodeTesting] = useState(false);
  const [nodeSaving, setNodeSaving] = useState(false);

  // Remote signer (Amber / NIP-46)
  const [amberUri, setAmberUri] = useState('');
  const [amberNpub, setAmberNpub] = useState('');
  const [amberConnecting, setAmberConnecting] = useState(false);
  const [amberError, setAmberError] = useState('');

  // Reveal nsec state machine: 'idle' | 'warning' | 'revealed'
  const [revealState, setRevealState] = useState<'idle' | 'warning' | 'revealed'>('idle');
  const [riskAcknowledged, setRiskAcknowledged] = useState(false);
  const [revealedNsec, setRevealedNsec] = useState('');
  const [nsecCopied, setNsecCopied] = useState(false);
  const [revealError, setRevealError] = useState('');
  const autoHideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Replace nsec (fix dummy/placeholder keys)
  const [editNsecOpen, setEditNsecOpen] = useState(false);
  const [editNsecInput, setEditNsecInput] = useState('');
  const [editNsecSaving, setEditNsecSaving] = useState(false);
  const [editNsecError, setEditNsecError] = useState('');
  const [editNsecSuccess, setEditNsecSuccess] = useState('');

  useEffect(() => {
    loadNwcConnection().then((conn) => {
      if (conn) setNwcConnected(true);
    });
    loadBitcoinNodeConfig().then((cfg) => {
      if (cfg) {
        setNodeEnabled(cfg.enabled);
        setNodeRpcUrl(cfg.rpcUrl);
        setNodeRpcUser(cfg.rpcUser || '');
        setNodeRpcPassword(cfg.rpcPassword || '');
      }
    });
    loadRemoteConnection().then((conn) => {
      if (conn?.userPubkey) setAmberNpub(pubkeyToNpub(conn.userPubkey));
    });
  }, []);

  useEffect(() => {
    return () => {
      if (autoHideTimer.current) clearTimeout(autoHideTimer.current);
    };
  }, []);

  function hideNsec() {
    setRevealState('idle');
    setRevealedNsec('');
    setRiskAcknowledged(false);
    setNsecCopied(false);
    if (autoHideTimer.current) {
      clearTimeout(autoHideTimer.current);
      autoHideTimer.current = null;
    }
  }

  async function handleRevealNsec() {
    setRevealError('');
    let pw = vaultPassword;
    if (!pw) {
      const entered = prompt('Enter your vault password to reveal your secret key');
      if (!entered) {
        setRevealError('Password required to reveal secret key');
        return;
      }
      try {
        const vault = await loadVault();
        if (!vault) { setRevealError('No vault found'); return; }
        await decryptVault(vault, entered);
        pw = entered;
      } catch {
        setRevealError('Incorrect password');
        return;
      }
    }
    try {
      const vault = await loadVault();
      if (!vault) { setRevealError('No vault found'); return; }
      const vaultData = await decryptVault(vault, pw);
      const activeKey = vaultData[activeAccountIndex];
      if (!activeKey) { setRevealError('No key found for active account'); return; }
      const nsec = privkeyToNsec(activeKey.privateKeyHex);
      setRevealedNsec(nsec);
      setRevealState('revealed');
      autoHideTimer.current = setTimeout(hideNsec, 30_000);
    } catch (err) {
      console.error('[Settings] Reveal nsec failed:', err);
      setRevealError('Failed to decrypt vault. Try locking and unlocking again.');
    }
  }

  async function handleCopyNsec() {
    await navigator.clipboard.writeText(revealedNsec);
    setNsecCopied(true);
    setTimeout(() => setNsecCopied(false), 2000);
  }

  async function handleReplaceNsec(e: React.FormEvent) {
    e.preventDefault();
    setEditNsecError('');
    setEditNsecSuccess('');
    if (!editNsecInput.trim()) return;

    // Get vault password (from memory or prompt)
    let pw = vaultPassword;
    if (!pw) {
      const entered = prompt('Enter your vault password to replace the secret key');
      if (!entered) { setEditNsecError('Password required'); return; }
      try {
        const vault = await loadVault();
        if (!vault) { setEditNsecError('No vault found'); return; }
        await decryptVault(vault, entered);
        pw = entered;
      } catch {
        setEditNsecError('Incorrect password');
        return;
      }
    }

    setEditNsecSaving(true);
    try {
      const { accounts: updated, newPublicKeyHex } = await replaceAccountNsec(pw, publicKey, editNsecInput.trim());

      // Refresh everything that caches keys
      await chrome.storage.local.set({ cached_accounts: updated });
      await chrome.runtime.sendMessage({
        type: 'vault:unlock',
        payload: { password: pw },
        id: createMessageId(),
      });
      try {
        const vault = await loadVault();
        if (vault) {
          const vaultData = await decryptVault(vault, pw);
          sessionStorage.setItem('nostr_onchain_session_keys', JSON.stringify(vaultData));
        }
      } catch {}
      const { clearDMKeyCache } = await import('@/lib/nostr/dm');
      clearDMKeyCache();

      setEditNsecInput('');
      setEditNsecSuccess(
        newPublicKeyHex === publicKey
          ? 'Secret key saved — signing is now enabled.'
          : 'Secret key replaced — reloading with your new identity...'
      );
      // Reload so every context (auth, DMs, wallets) picks up the new key
      setTimeout(() => window.location.reload(), 1200);
    } catch (err) {
      setEditNsecError(err instanceof Error ? err.message : 'Failed to replace nsec');
    } finally {
      setEditNsecSaving(false);
    }
  }

  async function handleNwcSave() {
    setNwcError('');
    if (!nwcUri.trim()) return;

    const parsed = parseNwcUri(nwcUri);
    if (!parsed) {
      setNwcError('Invalid NWC connection string');
      return;
    }

    setNwcSaving(true);
    try {
      await saveNwcConnection(parsed);
      setNwcConnected(true);
      setNwcUri('');
    } catch {
      setNwcError('Failed to save connection');
    } finally {
      setNwcSaving(false);
    }
  }

  async function handleNwcDisconnect() {
    await saveNwcConnection(null);
    setNwcConnected(false);
    setNwcUri('');
  }

  async function handleAmberConnect() {
    setAmberError('');
    if (!amberUri.trim()) return;
    setAmberConnecting(true);
    try {
      const conn = await connectRemoteSigner(amberUri.trim(), (url) => {
        // Some bunkers require approving the connection at a URL first
        window.open(url, '_blank', 'noopener');
      });
      setAmberNpub(pubkeyToNpub(conn.userPubkey));
      setAmberUri('');
    } catch (err) {
      setAmberError(err instanceof Error ? err.message : 'Failed to connect to Amber');
    } finally {
      setAmberConnecting(false);
    }
  }

  async function handleAmberDisconnect() {
    await disconnectRemoteSigner();
    setAmberNpub('');
    setAmberUri('');
    setAmberError('');
  }

  async function handleNodeSave() {
    setNodeSaving(true);
    setNodeStatus('');
    try {
      const config: BitcoinNodeConfig = {
        enabled: nodeEnabled,
        rpcUrl: nodeRpcUrl.trim(),
        rpcUser: nodeRpcUser.trim() || undefined,
        rpcPassword: nodeRpcPassword || undefined,
      };
      if (nodeEnabled && !config.rpcUrl) {
        setNodeStatus('RPC URL required when node broadcast is enabled');
        return;
      }
      await saveBitcoinNodeConfig(config);
      setNodeStatus('Saved');
    } catch {
      setNodeStatus('Failed to save');
    } finally {
      setNodeSaving(false);
    }
  }

  async function handleNodeTest() {
    setNodeTesting(true);
    setNodeStatus('');
    const result = await testNodeConnection({
      enabled: true,
      rpcUrl: nodeRpcUrl.trim(),
      rpcUser: nodeRpcUser.trim() || undefined,
      rpcPassword: nodeRpcPassword || undefined,
    });
    setNodeTesting(false);
    if (result.ok) {
      setNodeStatus(`Connected — block height ${result.blocks ?? '?'}`);
    } else {
      setNodeStatus(result.error || 'Connection failed');
    }
  }

  async function handleLock() {
    await chrome.runtime.sendMessage({ type: 'vault:lock', id: createMessageId() });
    window.location.reload();
  }

  async function handleExportWallets() {
    const wallets = await loadMultisigWallets();
    if (wallets.length === 0) {
      alert('No wallets to export');
      return;
    }
    const configs = wallets.map(walletToSyncConfig);
    const json = JSON.stringify(configs, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `nostr-onchain-wallets-${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  async function handleImportWallets(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    try {
      const configs: SyncableWalletConfig[] = JSON.parse(text);
      if (!Array.isArray(configs) || configs.length === 0) {
        alert('No valid wallet configs found in file');
        return;
      }
      let imported = 0;
      for (const config of configs) {
        const wallet = syncConfigToWallet(config, publicKey);
        await saveMultisigWallet(wallet);
        imported++;
      }
      alert(`Imported ${imported} wallet(s)`);
    } catch {
      alert('Invalid wallet backup file');
    }
    e.target.value = '';
  }

  return (
    <div className="h-full flex flex-col p-4 md:p-6 overflow-y-auto">
      {/* Header */}
      <h1 className="text-lg font-bold mb-5">Settings</h1>

      {/* Profile section */}
      <button
        onClick={() => navigate('/settings/profile')}
        className="card mb-4 w-full text-left hover:border-bitcoin/30 transition-colors"
      >
        <div className="flex items-center gap-3">
          {myProfile?.picture || activeAccount?.picture ? (
            <img
              key={publicKey}
              src={myProfile?.picture || activeAccount?.picture}
              alt=""
              className="w-12 h-12 rounded-full object-cover bg-surface-700"
            />
          ) : (
            <div key={publicKey} className="w-12 h-12 rounded-full bg-gradient-to-br from-bitcoin/40 to-nostr/40 flex items-center justify-center">
              <span className="text-lg font-bold text-white/80">
                {displayName.charAt(0).toUpperCase()}
              </span>
            </div>
          )}
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold truncate">{displayName}</p>
            <p className="text-[10px] text-gray-500 font-mono truncate" title={npub}>
              {npub.slice(0, 18)}...{npub.slice(-6)}
            </p>
          </div>
          <Edit3 className="w-4 h-4 text-gray-500" />
        </div>
      </button>

      {/* Account section */}
      <div className="mb-4">
        <p className="text-[10px] text-gray-500 uppercase tracking-wider px-1 mb-2">Accounts</p>
        <div className="card">
          <AccountSwitcher
            accounts={accounts}
            activeIndex={activeAccountIndex}
            onSwitch={handleSwitchAccount}
            onAddAccount={handleAddAccount}
          />
        </div>
      </div>

      {/* Settings links */}
      <div className="space-y-1 mb-4">
        <p className="text-[10px] text-gray-500 uppercase tracking-wider px-1 mb-2">Preferences</p>

        <button
          onClick={() => navigate('/settings/relays')}
          className="w-full flex items-center gap-3 px-4 py-3 rounded-xl hover:bg-surface-700 transition-colors"
        >
          <Radio className="w-5 h-5 text-gray-400" />
          <div className="flex-1 text-left">
            <p className="text-sm font-medium">Relays</p>
            <p className="text-xs text-gray-500">Manage Nostr relay connections</p>
          </div>
        </button>

        <button
          onClick={() => navigate('/settings/profile')}
          className="w-full flex items-center gap-3 px-4 py-3 rounded-xl hover:bg-surface-700 transition-colors"
        >
          <Edit3 className="w-5 h-5 text-gray-400" />
          <div className="flex-1 text-left">
            <p className="text-sm font-medium">Edit Profile</p>
            <p className="text-xs text-gray-500">Update your Nostr profile metadata</p>
          </div>
        </button>

        <button
          onClick={() => navigate('/settings/apps')}
          className="w-full flex items-center gap-3 px-4 py-3 rounded-xl hover:bg-surface-700 transition-colors"
        >
          <Globe className="w-5 h-5 text-gray-400" />
          <div className="flex-1 text-left">
            <p className="text-sm font-medium">Connected Apps</p>
            <p className="text-xs text-gray-500">Manage app permissions</p>
          </div>
        </button>

        <button
          onClick={() => navigate('/settings/events')}
          className="w-full flex items-center gap-3 px-4 py-3 rounded-xl hover:bg-surface-700 transition-colors"
        >
          <FileText className="w-5 h-5 text-gray-400" />
          <div className="flex-1 text-left">
            <p className="text-sm font-medium">Signed Events</p>
            <p className="text-xs text-gray-500">View signing history</p>
          </div>
        </button>
      </div>

      {/* Wallet Connect (NWC) */}
      <div className="mb-4">
        <p className="text-[10px] text-gray-500 uppercase tracking-wider px-1 mb-2">Wallet</p>
        <div className="card">
          <div className="flex items-center gap-3 mb-3">
            <Zap className={`w-5 h-5 ${nwcConnected ? 'text-bitcoin' : 'text-gray-400'}`} />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium">Nostr Wallet Connect</p>
              <p className="text-xs text-gray-500">
                {nwcConnected ? 'Wallet connected' : 'Link your Lightning wallet for zaps'}
              </p>
            </div>
            {nwcConnected && (
              <div className="flex items-center gap-1.5">
                <Check className="w-4 h-4 text-green-400" />
                <button
                  onClick={handleNwcDisconnect}
                  className="text-xs text-red-400 hover:text-red-300 transition-colors"
                >
                  Disconnect
                </button>
              </div>
            )}
          </div>
          {!nwcConnected && (
            <>
              <div className="relative">
                <input
                  type={showNwcUri ? 'text' : 'password'}
                  value={nwcUri}
                  onChange={(e) => { setNwcUri(e.target.value); setNwcError(''); }}
                  placeholder="nostr+walletconnect://..."
                  className="w-full bg-surface-700/50 rounded-lg px-3 py-2 pr-9 text-xs text-white placeholder-gray-600 outline-none border border-surface-200/10 focus:border-bitcoin/30 font-mono"
                />
                <button
                  onClick={() => setShowNwcUri(!showNwcUri)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300"
                >
                  {showNwcUri ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                </button>
              </div>
              {nwcError && <p className="text-xs text-red-400 mt-1.5">{nwcError}</p>}
              <button
                onClick={handleNwcSave}
                disabled={!nwcUri.trim() || nwcSaving}
                className="mt-2 w-full py-2 bg-bitcoin text-white rounded-lg text-xs font-medium disabled:opacity-50 hover:bg-bitcoin/90 transition-colors"
              >
                {nwcSaving ? 'Connecting...' : 'Connect Wallet'}
              </button>
              <p className="text-[10px] text-gray-600 mt-2">
                Get a connection string from Alby, Mutiny, or any NWC-compatible wallet.
              </p>
            </>
          )}
        </div>

        <div className="card mt-3">
          <div className="flex items-center gap-3 mb-3">
            <Server className={`w-5 h-5 ${nodeEnabled ? 'text-bitcoin' : 'text-gray-400'}`} />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium">Bitcoin Node Broadcast</p>
              <p className="text-xs text-gray-500">
                Pair your node to broadcast via sendrawtransaction
              </p>
            </div>
            <label className="flex items-center gap-2 text-xs text-gray-400">
              <input
                type="checkbox"
                checked={nodeEnabled}
                onChange={(e) => setNodeEnabled(e.target.checked)}
                className="w-4 h-4 rounded accent-bitcoin"
              />
              Use node
            </label>
          </div>
          <input
            value={nodeRpcUrl}
            onChange={(e) => setNodeRpcUrl(e.target.value)}
            placeholder="http://127.0.0.1:8332"
            className="w-full bg-surface-700/50 rounded-lg px-3 py-2 text-xs text-white placeholder-gray-600 outline-none border border-surface-200/10 focus:border-bitcoin/30 font-mono mb-2"
          />
          <div className="grid grid-cols-2 gap-2 mb-2">
            <input
              value={nodeRpcUser}
              onChange={(e) => setNodeRpcUser(e.target.value)}
              placeholder="RPC user"
              className="w-full bg-surface-700/50 rounded-lg px-3 py-2 text-xs text-white placeholder-gray-600 outline-none border border-surface-200/10 font-mono"
            />
            <input
              type="password"
              value={nodeRpcPassword}
              onChange={(e) => setNodeRpcPassword(e.target.value)}
              placeholder="RPC password"
              className="w-full bg-surface-700/50 rounded-lg px-3 py-2 text-xs text-white placeholder-gray-600 outline-none border border-surface-200/10 font-mono"
            />
          </div>
          <p className="text-[10px] text-gray-600 mb-2">
            Local nodes (127.0.0.1) connect directly from your browser. Remote nodes use our API proxy. Falls back to public mempool on failure.
          </p>
          {nodeStatus && (
            <p className={`text-xs mb-2 ${nodeStatus.startsWith('Connected') || nodeStatus === 'Saved' ? 'text-green-400' : 'text-red-400'}`}>
              {nodeStatus}
            </p>
          )}
          <div className="flex gap-2">
            <button
              onClick={handleNodeTest}
              disabled={nodeTesting || !nodeRpcUrl.trim()}
              className="flex-1 py-2 bg-surface-700 text-gray-300 rounded-lg text-xs font-medium disabled:opacity-50 hover:bg-surface-600"
            >
              {nodeTesting ? 'Testing...' : 'Test Connection'}
            </button>
            <button
              onClick={handleNodeSave}
              disabled={nodeSaving}
              className="flex-1 py-2 bg-bitcoin text-white rounded-lg text-xs font-medium disabled:opacity-50 hover:bg-bitcoin/90"
            >
              {nodeSaving ? 'Saving...' : 'Save'}
            </button>
          </div>
        </div>

        {/* Remote signer: Amber (NIP-46) */}
        <div className="card mt-3">
          <div className="flex items-center gap-3 mb-3">
            <Smartphone className={`w-5 h-5 ${amberNpub ? 'text-bitcoin' : 'text-gray-400'}`} />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium">Amber (Remote Signer)</p>
              <p className="text-xs text-gray-500">
                {amberNpub ? 'Paired — signs Nostr events & PSBTs on your phone' : 'Sign PSBTs with Amber over NIP-46 — key stays on your device'}
              </p>
            </div>
            {amberNpub && (
              <div className="flex items-center gap-1.5">
                <Check className="w-4 h-4 text-green-400" />
                <button
                  onClick={handleAmberDisconnect}
                  className="text-xs text-red-400 hover:text-red-300 transition-colors"
                >
                  Disconnect
                </button>
              </div>
            )}
          </div>
          {amberNpub ? (
            <p className="text-[10px] text-gray-500 font-mono break-all">
              {amberNpub.slice(0, 18)}...{amberNpub.slice(-6)}
            </p>
          ) : (
            <>
              <input
                type="text"
                value={amberUri}
                onChange={(e) => { setAmberUri(e.target.value); setAmberError(''); }}
                placeholder="bunker://..."
                className="w-full bg-surface-700/50 rounded-lg px-3 py-2 text-xs text-white placeholder-gray-600 outline-none border border-surface-200/10 focus:border-bitcoin/30 font-mono"
              />
              {amberError && <p className="text-xs text-red-400 mt-1.5">{amberError}</p>}
              <button
                onClick={handleAmberConnect}
                disabled={!amberUri.trim() || amberConnecting}
                className="mt-2 w-full py-2 bg-bitcoin text-white rounded-lg text-xs font-medium disabled:opacity-50 hover:bg-bitcoin/90 transition-colors"
              >
                {amberConnecting ? 'Pairing with Amber...' : 'Pair Amber'}
              </button>
              <p className="text-[10px] text-gray-600 mt-2">
                In Amber: Applications → add a new connection → copy the <code className="text-gray-500">bunker://</code> string here. Requires Amber v6.1.0+ for PSBT signing.
              </p>
            </>
          )}
        </div>
      </div>

      {/* Security section */}
      <div className="space-y-1 mb-4">
        <p className="text-[10px] text-gray-500 uppercase tracking-wider px-1 mb-2">Security</p>

        {/* Reveal Secret Key */}
        {revealState === 'idle' && (
          <button
            onClick={() => setRevealState('warning')}
            className="w-full flex items-center gap-3 px-4 py-3 rounded-xl hover:bg-surface-700 transition-colors"
          >
            <Key className="w-5 h-5 text-gray-400" />
            <div className="flex-1 text-left">
              <p className="text-sm font-medium">Reveal Secret Key</p>
              <p className="text-xs text-gray-500">Show your nsec for the active account</p>
            </div>
          </button>
        )}

        {revealState === 'warning' && (
          <div className="bg-red-900/20 border border-red-500/30 rounded-xl p-4">
            <div className="flex items-center gap-2 mb-2">
              <Key className="w-4 h-4 text-red-400" />
              <p className="text-sm font-semibold text-red-400">Danger Zone</p>
            </div>
            <p className="text-xs text-red-400 mb-3">
              Your secret key gives full control of your account. Never share it with anyone.
            </p>
            <label className="flex items-center gap-2 mb-3 cursor-pointer">
              <input
                type="checkbox"
                checked={riskAcknowledged}
                onChange={(e) => setRiskAcknowledged(e.target.checked)}
                className="w-4 h-4 rounded accent-red-500 border-red-500/50 bg-surface-700"
              />
              <span className="text-xs text-gray-300">I understand the risks</span>
            </label>
            {revealError && (
              <p className="text-xs text-red-400 mb-2">{revealError}</p>
            )}
            <div className="flex gap-2">
              <button
                onClick={handleRevealNsec}
                disabled={!riskAcknowledged}
                className="flex-1 py-2 bg-red-600 text-white rounded-lg text-xs font-medium disabled:opacity-40 hover:bg-red-500 transition-colors"
              >
                Show nsec
              </button>
              <button
                onClick={hideNsec}
                className="flex-1 py-2 bg-surface-700 text-gray-300 rounded-lg text-xs font-medium hover:bg-surface-600 transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {revealState === 'revealed' && (
          <div className="bg-red-900/20 border border-red-500/30 rounded-xl p-4">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <Key className="w-4 h-4 text-red-400" />
                <p className="text-xs font-semibold text-red-400">Secret Key (nsec)</p>
              </div>
              <button
                onClick={hideNsec}
                className="text-xs text-gray-400 hover:text-white transition-colors"
              >
                Hide
              </button>
            </div>
            <div className="font-mono text-xs break-all bg-surface-700 rounded-lg p-3 text-white/90">
              {revealedNsec}
            </div>
            <button
              onClick={handleCopyNsec}
              className="mt-2 flex items-center gap-1.5 text-xs text-gray-400 hover:text-white transition-colors"
            >
              {nsecCopied ? (
                <>
                  <CheckCircle2 className="w-3.5 h-3.5 text-green-400" />
                  <span className="text-green-400">Copied</span>
                </>
              ) : (
                <>
                  <Copy className="w-3.5 h-3.5" />
                  <span>Copy to clipboard</span>
                </>
              )}
            </button>
          </div>
        )}

        {/* Replace Secret Key */}
        {!editNsecOpen ? (
          <button
            onClick={() => { setEditNsecOpen(true); setEditNsecError(''); setEditNsecSuccess(''); }}
            className="w-full flex items-center gap-3 px-4 py-3 rounded-xl hover:bg-surface-700 transition-colors"
          >
            <Edit3 className="w-5 h-5 text-gray-400" />
            <div className="flex-1 text-left">
              <p className="text-sm font-medium">Edit Secret Key (nsec)</p>
              <p className="text-xs text-gray-500">
                Replace a dummy or wrong nsec for this account
              </p>
            </div>
          </button>
        ) : (
          <div className="bg-surface-800 border border-surface-200/10 rounded-xl p-4">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <Edit3 className="w-4 h-4 text-bitcoin" />
                <p className="text-sm font-semibold">Edit Secret Key</p>
              </div>
              <button
                onClick={() => { setEditNsecOpen(false); setEditNsecInput(''); setEditNsecError(''); setEditNsecSuccess(''); }}
                className="text-xs text-gray-400 hover:text-white transition-colors"
              >
                Cancel
              </button>
            </div>
            <p className="text-[11px] text-gray-500 mb-3 leading-relaxed">
              Paste the real nsec for this account. If the nsec belongs to a different
              npub, this account's identity switches to it. The key is encrypted with
              your vault password and stored on this device only.
            </p>
            <form onSubmit={handleReplaceNsec} className="space-y-2">
              <input
                type="password"
                value={editNsecInput}
                onChange={(e) => setEditNsecInput(e.target.value)}
                placeholder="nsec1..."
                className="input-field text-xs font-mono"
                autoComplete="off"
              />
              {editNsecError && <p className="text-xs text-red-400">{editNsecError}</p>}
              {editNsecSuccess && (
                <p className="text-xs text-green-400 flex items-center gap-1.5">
                  <CheckCircle2 className="w-3.5 h-3.5" /> {editNsecSuccess}
                </p>
              )}
              <button
                type="submit"
                disabled={editNsecSaving || !editNsecInput.trim()}
                className="w-full py-2 bg-bitcoin text-white rounded-lg text-xs font-medium disabled:opacity-50 hover:bg-bitcoin/90 transition-colors"
              >
                {editNsecSaving ? 'Saving...' : 'Save Secret Key'}
              </button>
            </form>
          </div>
        )}

        <button
          onClick={handleBackupKeys}
          className="w-full flex items-center gap-3 px-4 py-3 rounded-xl hover:bg-surface-700 transition-colors"
        >
          <Download className="w-5 h-5 text-gray-400" />
          <div className="flex-1 text-left">
            <p className="text-sm font-medium">Backup Keys</p>
            <p className="text-xs text-gray-500">Download all keys as encrypted file</p>
          </div>
        </button>

        <button
          onClick={handleExportWallets}
          className="w-full flex items-center gap-3 px-4 py-3 rounded-xl hover:bg-surface-700 transition-colors"
        >
          <Download className="w-5 h-5 text-gray-400" />
          <div className="flex-1 text-left">
            <p className="text-sm font-medium">Export Wallets</p>
            <p className="text-xs text-gray-500">Download multi-sig wallet configs as JSON</p>
          </div>
        </button>

        <label className="w-full flex items-center gap-3 px-4 py-3 rounded-xl hover:bg-surface-700 transition-colors cursor-pointer">
          <Upload className="w-5 h-5 text-gray-400" />
          <div className="flex-1 text-left">
            <p className="text-sm font-medium">Import Wallets</p>
            <p className="text-xs text-gray-500">Restore wallets from a backup file</p>
          </div>
          <input
            type="file"
            accept=".json"
            onChange={handleImportWallets}
            className="hidden"
          />
        </label>

        <button
          onClick={handleLock}
          className="w-full flex items-center gap-3 px-4 py-3 rounded-xl hover:bg-surface-700 hover:text-red-400 transition-colors group"
        >
          <Lock className="w-5 h-5 text-gray-400 group-hover:text-red-400" />
          <div className="flex-1 text-left">
            <p className="text-sm font-medium">Lock Vault</p>
            <p className="text-xs text-gray-500">Require password to access again</p>
          </div>
        </button>
      </div>

      {/* Status footer */}
      <div className="mt-auto pt-4 text-center">
        <p className="text-[10px] text-gray-600">
          NIP-07 active &bull; {accounts.length} account{accounts.length > 1 ? 's' : ''} &bull; v0.1.0
        </p>
      </div>
    </div>
  );
}
