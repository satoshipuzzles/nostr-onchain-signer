import { useState, useEffect, useMemo } from 'react';
import { fetchFollowingList, fetchProfiles, type ContactInfo, type ProfileMetadata } from '@/lib/nostr/social';
import { createMultisigFromPubkeys, type MultisigWallet } from '@/lib/bitcoin/multisig';
import { pubkeyToNpub } from '@/lib/nostr/keys';
import { saveMultisigWallet, createArchivedMultisig, type KeyHolder } from '@/lib/bitcoin/wallet-store';
import { fetchBalance, formatSats } from '@/lib/bitcoin/mempool';
import {
  ArrowLeft, Users, Check, Loader2, Search, Shield, Copy,
  BadgeCheck, Zap,
} from 'lucide-react';

interface Props {
  publicKey: string;
  followingPubkeys?: Set<string>;
  onBack: () => void;
  onCreated?: () => void;
}

type Step = 'select' | 'configure' | 'result';

export function MultiSig({ publicKey, followingPubkeys, onBack, onCreated }: Props) {
  const [step, setStep] = useState<Step>('select');
  const [following, setFollowing] = useState<ContactInfo[]>([]);
  const [profiles, setProfiles] = useState<Map<string, ProfileMetadata>>(new Map());
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [threshold, setThreshold] = useState(3);
  const [includeOwn, setIncludeOwn] = useState(true);
  const [loading, setLoading] = useState(false);
  const [loadingProfiles, setLoadingProfiles] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [result, setResult] = useState<{ address: string; threshold: number; total: number; wallet: MultisigWallet } | null>(null);
  const [copied, setCopied] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    loadFollowing();
  }, []);

  async function loadFollowing() {
    setLoading(true);
    try {
      // First: use passed-in following set (already loaded in App.tsx)
      let contactPubkeys: string[] = [];

      if (followingPubkeys && followingPubkeys.size > 0) {
        contactPubkeys = Array.from(followingPubkeys);
      } else {
        // Second: try local storage cache
        const cached = await chrome.storage.local.get(`following_${publicKey}`);
        if (cached[`following_${publicKey}`] && cached[`following_${publicKey}`].length > 0) {
          contactPubkeys = cached[`following_${publicKey}`];
        }
      }

      // Third: if still empty, fetch from relays
      if (contactPubkeys.length === 0) {
        const contacts = await fetchFollowingList(publicKey);
        contactPubkeys = contacts.map((c) => c.pubkey);
        // Save to local for next time
        if (contactPubkeys.length > 0) {
          await chrome.storage.local.set({ [`following_${publicKey}`]: contactPubkeys });
        }
      }

      // Convert pubkeys to ContactInfo format
      const contacts: ContactInfo[] = contactPubkeys.map((pk) => ({ pubkey: pk }));
      setFollowing(contacts);

      // Fetch profiles
      if (contacts.length > 0) {
        setLoadingProfiles(true);

        // Check local profile cache first
        const profileMap = new Map<string, ProfileMetadata>();
        const uncachedPubkeys: string[] = [];

        for (const pk of contactPubkeys) {
          const cached = await chrome.storage.local.get(`profile_${pk}`);
          if (cached[`profile_${pk}`]) {
            profileMap.set(pk, cached[`profile_${pk}`]);
          } else {
            uncachedPubkeys.push(pk);
          }
        }

        // Show cached profiles immediately
        if (profileMap.size > 0) {
          setProfiles(new Map(profileMap));
          setLoading(false);
        }

        // Fetch uncached from relays
        if (uncachedPubkeys.length > 0) {
          const fetched = await fetchProfiles(uncachedPubkeys);
          for (const [pk, profile] of fetched) {
            profileMap.set(pk, profile);
            // Cache for next time
            await chrome.storage.local.set({ [`profile_${pk}`]: profile });
          }
          setProfiles(new Map(profileMap));
        }

        setLoadingProfiles(false);
      }
    } catch (err) {
      console.error('Failed to fetch following:', err);
    } finally {
      setLoading(false);
    }
  }

  const filteredFollowing = useMemo(() => {
    if (!searchQuery.trim()) return following;
    const q = searchQuery.toLowerCase();
    return following.filter((contact) => {
      const profile = profiles.get(contact.pubkey);
      const name = (profile?.displayName || profile?.name || '').toLowerCase();
      const nip05 = (profile?.nip05 || '').toLowerCase();
      const npub = pubkeyToNpub(contact.pubkey).toLowerCase();
      const petname = (contact.petname || '').toLowerCase();
      return (
        name.includes(q) ||
        nip05.includes(q) ||
        npub.includes(q) ||
        petname.includes(q) ||
        contact.pubkey.includes(q)
      );
    });
  }, [following, profiles, searchQuery]);

  function toggleKey(pubkey: string) {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(pubkey)) {
        next.delete(pubkey);
      } else {
        next.add(pubkey);
      }
      return next;
    });
  }

  function selectAll() {
    setSelectedKeys(new Set(filteredFollowing.map((c) => c.pubkey)));
  }

  function selectNone() {
    setSelectedKeys(new Set());
  }

  const totalKeys = (includeOwn ? 1 : 0) + selectedKeys.size;

  function handleConfigure() {
    if (totalKeys < 2) return;
    setThreshold(Math.min(Math.ceil(totalKeys / 2), totalKeys));
    setStep('configure');
  }

  async function handleCreate() {
    const allKeys = includeOwn
      ? [publicKey, ...Array.from(selectedKeys)]
      : Array.from(selectedKeys);

    if (allKeys.length < 2 || threshold > allKeys.length) return;

    // Validate all keys are 64-char hex (32 bytes)
    const invalidKeys = allKeys.filter(k => !k || k.length !== 64 || !/^[0-9a-f]+$/i.test(k));
    if (invalidKeys.length > 0) {
      console.error('Invalid pubkeys detected:', invalidKeys);
      alert(`${invalidKeys.length} invalid key(s) found. Please deselect them and try again.`);
      return;
    }

    setSaving(true);
    try {
      const wallet = createMultisigFromPubkeys(allKeys, threshold);

      // Build key holder list with profiles
      const keyHolders: KeyHolder[] = allKeys.map((pk) => ({
        pubkey: pk,
        profile: profiles.get(pk) || (pk === publicKey ? { pubkey: pk, name: 'You' } : undefined),
        isOwnKey: pk === publicKey,
      }));

      // Create a readable name
      const signerNames = keyHolders
        .filter((h) => !h.isOwnKey)
        .slice(0, 3)
        .map((h) => h.profile?.displayName || h.profile?.name || h.pubkey.slice(0, 6))
        .join(', ');
      const walletName = `${threshold}-of-${allKeys.length} with ${signerNames}${keyHolders.length > 4 ? '...' : ''}`;

      // Save to storage (convert Uint8Arrays to hex for JSON serialization)
      const serializableWallet = {
        ...wallet,
        script: undefined,
        merkleRoot: undefined,
        merkleRootHex: wallet.merkleRoot instanceof Uint8Array
          ? Array.from(wallet.merkleRoot).map(b => b.toString(16).padStart(2, '0')).join('')
          : String(wallet.merkleRoot ?? ''),
      };
      const archived = createArchivedMultisig(serializableWallet as any, keyHolders, walletName, undefined, publicKey);
      await saveMultisigWallet(archived);

      setResult({ address: wallet.address, threshold, total: allKeys.length, wallet });
      setStep('result');

      // Fetch balance in background (don't block UI)
      fetchBalance(wallet.address).then(bal => {
        if (bal.total > 0) {
          archived.currentBalance = bal.total;
          saveMultisigWallet(archived).catch(() => {});
        }
      }).catch(() => {});
    } catch (err) {
      console.error('Failed to create multisig:', err);
      alert(`Multi-sig creation failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setSaving(false);
    }
  }

  async function copyAddress() {
    if (!result) return;
    await navigator.clipboard.writeText(result.address);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  // ─── RESULT STEP ────────────────────────────────────────────────

  if (step === 'result' && result) {
    return (
      <div className="h-full flex flex-col p-4">
        <div className="page-header mb-6">
          <button onClick={onBack} className="btn-back">
            <ArrowLeft className="w-5 h-5" />
          </button>
          <h1>Multi-Sig Created</h1>
        </div>

        <div className="flex-1 flex flex-col items-center justify-center">
          <div className="w-16 h-16 rounded-full bg-green-500/20 flex items-center justify-center mb-4">
            <Shield className="w-8 h-8 text-green-400" />
          </div>

          <p className="text-xl font-bold text-bitcoin mb-1">
            {result.threshold}-of-{result.total}
          </p>
          <p className="text-sm text-gray-400 mb-6">Social Multi-Sig Wallet</p>

          <div className="card w-full">
            <p className="text-xs text-gray-400 mb-2">Taproot Address</p>
            <div className="flex items-center gap-2">
              <code className="text-xs text-green-300 break-all flex-1 leading-relaxed">
                {result.address}
              </code>
              <button
                onClick={copyAddress}
                className="p-2 hover:bg-surface-700 rounded-lg flex-shrink-0"
              >
                {copied ? (
                  <Check className="w-4 h-4 text-green-400" />
                ) : (
                  <Copy className="w-4 h-4 text-gray-400" />
                )}
              </button>
            </div>
          </div>

          {/* Selected signers summary */}
          <div className="card w-full mt-3">
            <p className="text-xs text-gray-400 mb-2">Key Holders ({result.total})</p>
            <div className="flex flex-wrap gap-1.5">
              {includeOwn && (
                <span className="text-xs bg-bitcoin/20 text-bitcoin px-2 py-0.5 rounded-full">
                  You
                </span>
              )}
              {Array.from(selectedKeys).slice(0, 10).map((pk) => {
                const p = profiles.get(pk);
                return (
                  <span key={pk} className="text-xs bg-surface-700 text-gray-300 px-2 py-0.5 rounded-full truncate max-w-[120px]">
                    {p?.displayName || p?.name || pk.slice(0, 8)}
                  </span>
                );
              })}
              {selectedKeys.size > 10 && (
                <span className="text-xs text-gray-500">+{selectedKeys.size - 10} more</span>
              )}
            </div>
          </div>
        </div>

        <div className="space-y-2 mt-4 pb-24 md:pb-0">
          <button onClick={() => { setResult(null); setStep('select'); }} className="btn-secondary w-full">
            Create Another
          </button>
          <button onClick={() => onCreated ? onCreated() : onBack()} className="btn-primary w-full">
            View My Wallets
          </button>
        </div>
      </div>
    );
  }

  // ─── CONFIGURE STEP ─────────────────────────────────────────────

  if (step === 'configure') {
    return (
      <div className="h-full flex flex-col p-4">
        <div className="page-header">
          <button onClick={() => setStep('select')} className="btn-back">
            <ArrowLeft className="w-5 h-5" />
          </button>
          <h1>Configure Threshold</h1>
        </div>

        {/* Visual threshold selector */}
        <div className="card mb-4">
          <p className="text-sm text-gray-400 mb-4">
            How many signatures are required to spend?
          </p>

          <div className="text-center mb-6">
            <span className="text-5xl font-bold text-bitcoin">{threshold}</span>
            <span className="text-2xl text-gray-400 mx-2">of</span>
            <span className="text-5xl font-bold text-white">{totalKeys}</span>
          </div>

          {/* Slider */}
          <input
            type="range"
            min={1}
            max={totalKeys}
            value={threshold}
            onChange={(e) => setThreshold(parseInt(e.target.value, 10))}
            className="w-full h-2 bg-surface-700 rounded-full appearance-none cursor-pointer
                       [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-5
                       [&::-webkit-slider-thumb]:h-5 [&::-webkit-slider-thumb]:rounded-full
                       [&::-webkit-slider-thumb]:bg-bitcoin [&::-webkit-slider-thumb]:cursor-pointer"
          />

          <div className="flex justify-between text-xs text-gray-500 mt-2">
            <span>1 (any signer)</span>
            <span>{totalKeys} (all must sign)</span>
          </div>
        </div>

        {/* Quick presets */}
        <div className="grid grid-cols-3 gap-2 mb-4">
          <button
            onClick={() => setThreshold(Math.ceil(totalKeys / 2))}
            className={`px-3 py-2 rounded-lg text-xs font-medium border transition-colors ${
              threshold === Math.ceil(totalKeys / 2)
                ? 'border-bitcoin bg-bitcoin/10 text-bitcoin'
                : 'border-surface-200/20 text-gray-400 hover:border-bitcoin/40'
            }`}
          >
            Majority<br />({Math.ceil(totalKeys / 2)}/{totalKeys})
          </button>
          <button
            onClick={() => setThreshold(Math.ceil(totalKeys * 2 / 3))}
            className={`px-3 py-2 rounded-lg text-xs font-medium border transition-colors ${
              threshold === Math.ceil(totalKeys * 2 / 3)
                ? 'border-bitcoin bg-bitcoin/10 text-bitcoin'
                : 'border-surface-200/20 text-gray-400 hover:border-bitcoin/40'
            }`}
          >
            Supermajority<br />({Math.ceil(totalKeys * 2 / 3)}/{totalKeys})
          </button>
          <button
            onClick={() => setThreshold(totalKeys)}
            className={`px-3 py-2 rounded-lg text-xs font-medium border transition-colors ${
              threshold === totalKeys
                ? 'border-bitcoin bg-bitcoin/10 text-bitcoin'
                : 'border-surface-200/20 text-gray-400 hover:border-bitcoin/40'
            }`}
          >
            Unanimous<br />({totalKeys}/{totalKeys})
          </button>
        </div>

        {/* Include own key toggle */}
        <label className="flex items-center gap-3 px-3 py-2.5 rounded-lg bg-surface-800/50 mb-4 cursor-pointer">
          <input
            type="checkbox"
            checked={includeOwn}
            onChange={(e) => setIncludeOwn(e.target.checked)}
            className="w-4 h-4 rounded border-gray-600 text-bitcoin focus:ring-bitcoin"
          />
          <div>
            <p className="text-sm">Include my key</p>
            <p className="text-xs text-gray-500">Your npub as one of the signers</p>
          </div>
        </label>

        <div className="mt-auto pb-24 md:pb-0">
          <button onClick={handleCreate} disabled={saving} className="btn-primary w-full flex items-center justify-center gap-2">
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Shield className="w-4 h-4" />}
            {saving ? 'Creating...' : `Create ${threshold}-of-${totalKeys} Multi-Sig`}
          </button>
        </div>
      </div>
    );
  }

  // ─── SELECT STEP (main) ─────────────────────────────────────────

  return (
    <div className="h-full flex flex-col p-4">
      {/* Header */}
      <div className="page-header">
        <button onClick={onBack} className="btn-back">
          <ArrowLeft className="w-5 h-5" />
        </button>
        <h1>Social Multi-Sig</h1>
      </div>

      {/* Search */}
      <div className="relative mb-3">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
        <input
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Search by name, npub, or NIP-05..."
          className="input-field pl-9 text-sm"
        />
      </div>

      {/* Selection bar */}
      <div className="flex items-center justify-between mb-2 px-1">
        <span className="text-xs text-gray-400">
          {selectedKeys.size} selected of {following.length} following
        </span>
        <div className="flex gap-2">
          <button onClick={selectAll} className="text-xs text-bitcoin hover:underline">
            All
          </button>
          <button onClick={selectNone} className="text-xs text-gray-400 hover:underline">
            None
          </button>
        </div>
      </div>

      {/* Contact List */}
      <div className="flex-1 overflow-y-auto space-y-1 min-h-0">
        {loading ? (
          <div className="flex flex-col items-center justify-center py-12">
            <Loader2 className="w-6 h-6 animate-spin text-bitcoin mb-2" />
            <p className="text-sm text-gray-400">Loading your follows...</p>
          </div>
        ) : filteredFollowing.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12">
            <Users className="w-8 h-8 text-gray-600 mb-2" />
            <p className="text-sm text-gray-500">
              {searchQuery ? 'No matches found' : 'No following list found'}
            </p>
          </div>
        ) : (
          filteredFollowing.map((contact) => (
            <ContactRow
              key={contact.pubkey}
              contact={contact}
              profile={profiles.get(contact.pubkey)}
              isSelected={selectedKeys.has(contact.pubkey)}
              onToggle={() => toggleKey(contact.pubkey)}
              isLoadingProfile={loadingProfiles && !profiles.has(contact.pubkey)}
            />
          ))
        )}
      </div>

      {/* Bottom action */}
      <div className="pt-3 border-t border-surface-200/10 mt-2 pb-24 md:pb-0">
        <button
          onClick={handleConfigure}
          disabled={totalKeys < 2}
          className="btn-primary w-full flex items-center justify-center gap-2"
        >
          <Shield className="w-4 h-4" />
          {totalKeys < 2
            ? 'Select at least 2 keys'
            : `Continue with ${totalKeys} keys`
          }
        </button>
      </div>
    </div>
  );
}

// ─── CONTACT ROW COMPONENT ──────────────────────────────────────

function ContactRow({
  contact,
  profile,
  isSelected,
  onToggle,
  isLoadingProfile,
}: {
  contact: ContactInfo;
  profile?: ProfileMetadata;
  isSelected: boolean;
  onToggle: () => void;
  isLoadingProfile: boolean;
}) {
  const npub = pubkeyToNpub(contact.pubkey);
  const displayName = profile?.displayName || profile?.name || contact.petname || npub.slice(5, 15) + '...';
  const hasNip05 = !!profile?.nip05;

  return (
    <button
      onClick={onToggle}
      className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-left transition-all duration-150 ${
        isSelected
          ? 'bg-bitcoin/10 border border-bitcoin/40 shadow-sm shadow-bitcoin/5'
          : 'hover:bg-surface-700/60 border border-transparent'
      }`}
    >
      {/* Avatar */}
      <div className="relative flex-shrink-0">
        {profile?.picture ? (
          <img
            src={profile.picture}
            alt=""
            className="w-10 h-10 rounded-full object-cover bg-surface-700"
            onError={(e) => {
              (e.target as HTMLImageElement).style.display = 'none';
              (e.target as HTMLImageElement).nextElementSibling?.classList.remove('hidden');
            }}
          />
        ) : null}
        <div className={`w-10 h-10 rounded-full bg-gradient-to-br from-bitcoin/40 to-nostr/40 flex items-center justify-center ${profile?.picture ? 'hidden' : ''}`}>
          <span className="text-sm font-bold text-white/80">
            {displayName.charAt(0).toUpperCase()}
          </span>
        </div>
        {isSelected && (
          <div className="absolute -bottom-0.5 -right-0.5 w-4 h-4 rounded-full bg-bitcoin flex items-center justify-center">
            <Check className="w-2.5 h-2.5 text-white" />
          </div>
        )}
      </div>

      {/* Info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <p className="text-sm font-medium truncate">{displayName}</p>
          {hasNip05 && (
            <BadgeCheck className="w-3.5 h-3.5 text-nostr flex-shrink-0" />
          )}
        </div>
        <div className="flex items-center gap-2">
          {profile?.nip05 && (
            <p className="text-xs text-nostr/70 truncate">{profile.nip05}</p>
          )}
          {!profile?.nip05 && (
            <p className="text-xs text-gray-500 truncate font-mono">
              {npub.slice(0, 16)}...{npub.slice(-4)}
            </p>
          )}
        </div>
        {isLoadingProfile && (
          <div className="flex items-center gap-1 mt-0.5">
            <Loader2 className="w-2.5 h-2.5 animate-spin text-gray-600" />
            <span className="text-[10px] text-gray-600">loading...</span>
          </div>
        )}
      </div>

      {/* Lightning indicator */}
      {profile?.lud16 && (
        <Zap className="w-3.5 h-3.5 text-yellow-500/60 flex-shrink-0" />
      )}
    </button>
  );
}
