import { useState } from 'react';
import { Lock, Download, Radio, Zap, Server } from 'lucide-react';
import {
  createManifest,
  accountFromNostrPubkey,
  serializeManifest,
  exportBip329,
  deriveSpKeysFromNostrKey,
  type Bip329Label,
} from '@nostr-onchain/core';
import { loadSettings, saveSettings, loadContacts, type AppSettings } from '../lib/storage';
import { getAccounts, accountAddress, lockVault } from '../lib/vault';
import { publishProfileFields } from '../lib/nostr';

export function Settings() {
  const [settings, setSettings] = useState<AppSettings>(loadSettings());
  const [nodeUrl, setNodeUrl] = useState(settings.ownNodeUrl ?? '');
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [spAddress, setSpAddress] = useState('');
  const [busy, setBusy] = useState(false);

  const signerAccounts = getAccounts().filter((a) => !a.watchOnly);

  function update(patch: Partial<AppSettings>) {
    const next = { ...settings, ...patch };
    setSettings(next);
    saveSettings(next);
  }

  function download(filename: string, data: string, mime = 'application/json') {
    const blob = new Blob([data], { type: mime });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function exportWalletFile() {
    const manifest = createManifest('My wallets', settings.network);
    for (const acct of getAccounts()) {
      if (acct.addressOverride) {
        manifest.accounts.push({
          id: acct.id,
          label: acct.label,
          type: 'watch-only',
          descriptor: `addr(${acct.addressOverride})`,
          address: acct.addressOverride,
          createdAt: acct.createdAt,
        });
      } else {
        const account = accountFromNostrPubkey(acct.publicKeyHex, acct.label, settings.network);
        account.id = acct.id;
        if (acct.watchOnly) account.type = 'watch-only';
        manifest.accounts.push(account);
      }
    }
    download('wallets.nostr-onchain.json', serializeManifest(manifest));
  }

  function exportLabels() {
    const labels: Bip329Label[] = [];
    for (const acct of getAccounts()) {
      labels.push({ type: 'addr', ref: accountAddress(acct, settings.network), label: acct.label });
    }
    for (const contact of loadContacts()) {
      labels.push({ type: 'addr', ref: contact.taprootAddress, label: `nostr: ${contact.name}` });
    }
    download('labels.jsonl', exportBip329(labels), 'application/jsonl');
  }

  async function generateAndPublishSp(publish: boolean) {
    setError('');
    setStatus('');
    const account = signerAccounts[0];
    if (!account?.privateKeyHex) {
      setError('Need a signing account (not watch-only) to derive silent payment keys');
      return;
    }
    setBusy(true);
    try {
      const sp = deriveSpKeysFromNostrKey(account.privateKeyHex);
      setSpAddress(sp.address);
      if (publish) {
        await publishProfileFields(account.privateKeyHex, { silent_payment_address: sp.address });
        setStatus('Published silent_payment_address to your Nostr profile');
      } else {
        setStatus('Derived (not published) — deterministic from your nsec, recoverable anytime');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold">Settings</h1>
      </header>

      {/* Node connection */}
      <section className="card space-y-3">
        <h2 className="font-semibold text-sm flex items-center gap-2">
          <Server size={16} className="text-accent" /> Your node (optional)
        </h2>
        <p className="text-xs text-stone-400">
          Point the app at your own node's Esplora/electrs REST API (e.g. http://umbrel.local:3006/api). Falls back to
          public providers when unset or unreachable.
        </p>
        <div className="flex gap-2">
          <input className="input flex-1" placeholder="https://my-node:3006/api" value={nodeUrl} onChange={(e) => setNodeUrl(e.target.value)} />
          <button
            className="btn-secondary text-xs"
            onClick={() => {
              update({ ownNodeUrl: nodeUrl.trim() || undefined });
              setStatus(nodeUrl.trim() ? 'Node saved — used first for all chain queries' : 'Node removed');
            }}
          >
            Save
          </button>
        </div>
        <div>
          <label className="label">Network</label>
          <select className="input" value={settings.network} onChange={(e) => update({ network: e.target.value as AppSettings['network'] })}>
            <option value="mainnet">Mainnet</option>
            <option value="testnet">Testnet</option>
          </select>
        </div>
      </section>

      {/* Silent payments */}
      <section className="card space-y-3">
        <h2 className="font-semibold text-sm flex items-center gap-2">
          <Zap size={16} className="text-purple-300" /> Silent payments (experimental)
        </h2>
        <p className="text-xs text-stone-400">
          Derive a BIP-352 sp1… address from your key and publish it to your Nostr profile, so people can pay you
          without revealing a reusable address on-chain. Detecting received payments requires your own node (coming
          later) — funds are still yours and recoverable from your nsec.
        </p>
        {spAddress && <div className="font-mono text-xs break-all text-purple-200 bg-surface rounded-xl p-3">{spAddress}</div>}
        <div className="flex gap-2">
          <button className="btn-secondary text-xs" onClick={() => generateAndPublishSp(false)} disabled={busy}>
            Derive address
          </button>
          <button className="btn-primary text-xs" onClick={() => generateAndPublishSp(true)} disabled={busy}>
            <Radio size={14} /> Derive & publish to profile
          </button>
        </div>
      </section>

      {/* Exports */}
      <section className="card space-y-3">
        <h2 className="font-semibold text-sm flex items-center gap-2">
          <Download size={16} className="text-accent" /> Export
        </h2>
        <p className="text-xs text-stone-400">
          Open formats only: wallet file (JSON + descriptors, imports into Sparrow/Core) and BIP-329 labels. Keys stay
          in the encrypted vault.
        </p>
        <div className="flex flex-wrap gap-2">
          <button className="btn-secondary text-xs" onClick={exportWalletFile}>
            Wallet file (.json)
          </button>
          <button className="btn-secondary text-xs" onClick={exportLabels}>
            Labels (BIP-329)
          </button>
        </div>
      </section>

      {/* Relays */}
      <section className="card space-y-3">
        <h2 className="font-semibold text-sm">Nostr relays</h2>
        <textarea
          className="input font-mono text-xs"
          rows={4}
          value={settings.relays.join('\n')}
          onChange={(e) => update({ relays: e.target.value.split('\n').map((r) => r.trim()).filter(Boolean) })}
        />
      </section>

      {status && <p className="text-green-400 text-sm">{status}</p>}
      {error && <p className="text-red-400 text-sm">{error}</p>}

      <button className="btn-secondary w-full" onClick={lockVault}>
        <Lock size={16} /> Lock vault
      </button>

      <p className="text-center text-xs text-stone-600">
        Bitcoin Wallet Manager · offline-first PWA · keys never leave this device
      </p>
    </div>
  );
}
