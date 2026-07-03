import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Radio, Edit3, Download, Lock, Zap, Check, X, Eye, EyeOff, Key, Copy, CheckCircle2, Globe, FileText } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { AccountSwitcher } from '../components/AccountSwitcher';
import { createMessageId } from '@/shared/messages';
import { parseNwcUri, loadNwcConnection, saveNwcConnection, type NwcConnection } from '@/lib/nostr/nwc';
import { loadVault, decryptVault } from '@/lib/crypto/vault';
import { privkeyToNsec } from '@/lib/nostr/keys';

export function Settings() {
  const navigate = useNavigate();
  const {
    publicKey, myProfile, accounts, activeAccountIndex,
    handleSwitchAccount, handleAddAccount, handleBackupKeys,
    vaultPassword,
  } = useAuth();

  const displayName = myProfile?.displayName || myProfile?.name || 'Anonymous';

  const [nwcUri, setNwcUri] = useState('');
  const [nwcConnected, setNwcConnected] = useState(false);
  const [nwcError, setNwcError] = useState('');
  const [nwcSaving, setNwcSaving] = useState(false);
  const [showNwcUri, setShowNwcUri] = useState(false);

  // Reveal nsec state machine: 'idle' | 'warning' | 'revealed'
  const [revealState, setRevealState] = useState<'idle' | 'warning' | 'revealed'>('idle');
  const [riskAcknowledged, setRiskAcknowledged] = useState(false);
  const [revealedNsec, setRevealedNsec] = useState('');
  const [nsecCopied, setNsecCopied] = useState(false);
  const autoHideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    loadNwcConnection().then((conn) => {
      if (conn) setNwcConnected(true);
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
    if (!vaultPassword) return;
    try {
      const vault = await loadVault();
      if (!vault) return;
      const vaultData = await decryptVault(vault, vaultPassword);
      const activeKey = vaultData[activeAccountIndex];
      if (!activeKey) return;
      const nsec = privkeyToNsec(activeKey.privateKeyHex);
      setRevealedNsec(nsec);
      setRevealState('revealed');
      autoHideTimer.current = setTimeout(hideNsec, 30_000);
    } catch {
      setRevealState('idle');
    }
  }

  async function handleCopyNsec() {
    await navigator.clipboard.writeText(revealedNsec);
    setNsecCopied(true);
    setTimeout(() => setNsecCopied(false), 2000);
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

  async function handleLock() {
    await chrome.runtime.sendMessage({ type: 'vault:lock', id: createMessageId() });
    window.location.reload();
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
          {myProfile?.picture ? (
            <img src={myProfile.picture} alt="" className="w-12 h-12 rounded-full object-cover bg-surface-700" />
          ) : (
            <div className="w-12 h-12 rounded-full bg-gradient-to-br from-bitcoin/40 to-nostr/40 flex items-center justify-center">
              <span className="text-lg font-bold text-white/80">
                {displayName.charAt(0).toUpperCase()}
              </span>
            </div>
          )}
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold truncate">{displayName}</p>
            <p className="text-xs text-gray-500">Edit profile</p>
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
                className="rounded border-red-500/50 bg-surface-700 text-red-500 focus:ring-red-500/30"
              />
              <span className="text-xs text-gray-300">I understand the risks</span>
            </label>
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
