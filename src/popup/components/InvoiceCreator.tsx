import { useState, useRef, useEffect, useCallback } from 'react';
import { createOnchainInvoice } from '@/lib/nostr/kinds';
import { pubkeyToTaprootAddress } from '@/lib/bitcoin/address';
import { npubToPubkey, pubkeyToNpub, isValidHexPubkey } from '@/lib/nostr/keys';
import { ArrowLeft, Loader2, Send, ImageIcon, X, Repeat, Copy, Check, Search } from 'lucide-react';
import { uploadImageToNostrBuild } from '@/lib/nostr/image-upload';
import { encryptDM } from '@/lib/nostr/dm';
import { resolveNip05 } from '@/lib/nostr/nip05';
import { encodeInvoiceOpReturn } from '@/lib/bitcoin/opreturn';
import type { ProfileMetadata } from '@/lib/nostr/social';
import { useAuth } from '@/popup/context/AuthContext';
import { publishWithFeedback } from '@/lib/ui/publish-feedback';
import { toast } from 'sonner';

const INVOICE_BASE_URL = 'https://nostr-onchain-signer.vercel.app/invoice';
const SEND_BASE_PATH = '/send';

const EXPIRATION_OPTIONS = [
  { label: '1 hour', seconds: 60 * 60 },
  { label: '24 hours', seconds: 24 * 60 * 60 },
  { label: '3 days', seconds: 3 * 24 * 60 * 60 },
  { label: '7 days', seconds: 7 * 24 * 60 * 60 },
  { label: '30 days', seconds: 30 * 24 * 60 * 60 },
  { label: 'Never', seconds: 0 },
] as const;

interface Props {
  publicKey: string;
  onClose: () => void;
  onCreated: () => void;
}

type FrequencyUnit = 'days' | 'blocks';

interface SearchResult {
  pubkey: string;
  displayName?: string;
  picture?: string;
  nip05?: string;
}

export function InvoiceCreator({ publicKey, onClose, onCreated }: Props) {
  const { confirmAndSign } = useAuth();
  const [recipients, setRecipients] = useState<string[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [showDropdown, setShowDropdown] = useState(false);
  const [address, setAddress] = useState(() => pubkeyToTaprootAddress(publicKey));
  const [amountSats, setAmountSats] = useState('');
  const [memo, setMemo] = useState('');
  const [password, setPassword] = useState('');
  const [imageUrl, setImageUrl] = useState('');
  const [uploading, setUploading] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [expirationSeconds, setExpirationSeconds] = useState(7 * 24 * 60 * 60);
  const [isRecurring, setIsRecurring] = useState(false);
  const [frequencyValue, setFrequencyValue] = useState('30');
  const [frequencyUnit, setFrequencyUnit] = useState<FrequencyUnit>('days');
  const [occurrences, setOccurrences] = useState('');
  const [opReturnEnabled, setOpReturnEnabled] = useState(true);
  const [createdEventId, setCreatedEventId] = useState<string | null>(null);
  const [opReturnHex, setOpReturnHex] = useState<string | null>(null);
  const [copiedOpReturn, setCopiedOpReturn] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  // Close dropdown on outside click
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node) &&
          searchInputRef.current && !searchInputRef.current.contains(e.target as Node)) {
        setShowDropdown(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const searchRecipients = useCallback(async (query: string) => {
    if (!query.trim()) {
      setSearchResults([]);
      setShowDropdown(false);
      return;
    }

    setSearchLoading(true);
    const results: SearchResult[] = [];
    const seen = new Set<string>();

    try {
      // Direct npub or hex match
      if (query.startsWith('npub1')) {
        try {
          const pk = npubToPubkey(query);
          if (!seen.has(pk)) {
            seen.add(pk);
            results.push({ pubkey: pk });
          }
        } catch { /* invalid npub */ }
      } else if (/^[0-9a-f]{64}$/i.test(query)) {
        if (!seen.has(query.toLowerCase())) {
          seen.add(query.toLowerCase());
          results.push({ pubkey: query.toLowerCase() });
        }
      }

      // NIP-05 resolution
      if (query.includes('@') || (query.includes('.') && !query.startsWith('npub'))) {
        const nip05Result = await resolveNip05(query.includes('@') ? query : `_@${query}`);
        if (nip05Result && !seen.has(nip05Result.pubkey)) {
          seen.add(nip05Result.pubkey);
          results.push({ pubkey: nip05Result.pubkey, nip05: query });
        }
      }

      // Search local following list
      const followingStored = await chrome.storage.local.get(`following_${publicKey}`);
      const followingList: string[] = followingStored[`following_${publicKey}`] ?? [];

      // Search local profile cache for matches
      const profileKeys = followingList.map(pk => `profile_${pk}`);
      const batchSize = 50;
      for (let i = 0; i < profileKeys.length; i += batchSize) {
        const batch = profileKeys.slice(i, i + batchSize);
        const cached = await chrome.storage.local.get(batch);

        for (const key of batch) {
          const profile = cached[key] as ProfileMetadata | undefined;
          if (!profile) continue;

          const pk = profile.pubkey;
          if (seen.has(pk)) continue;

          const lowerQuery = query.toLowerCase();
          const matchesName = profile.name?.toLowerCase().includes(lowerQuery) ||
                             profile.displayName?.toLowerCase().includes(lowerQuery);
          const matchesNip05 = profile.nip05?.toLowerCase().includes(lowerQuery);
          const matchesPubkey = pk.startsWith(lowerQuery);

          if (matchesName || matchesNip05 || matchesPubkey) {
            seen.add(pk);
            results.push({
              pubkey: pk,
              displayName: profile.displayName || profile.name,
              picture: profile.picture,
              nip05: profile.nip05,
            });
          }
        }
      }

      // Also check general profile cache store
      const cacheResult = await chrome.storage.local.get('profile_cache_v2');
      const profileCache = cacheResult['profile_cache_v2'];
      if (profileCache?.profiles) {
        const lowerQuery = query.toLowerCase();
        for (const [pk, entry] of Object.entries(profileCache.profiles) as [string, { profile: ProfileMetadata }][]) {
          if (seen.has(pk)) continue;
          const p = entry.profile;
          const matchesName = p.name?.toLowerCase().includes(lowerQuery) ||
                             p.displayName?.toLowerCase().includes(lowerQuery);
          const matchesNip05 = p.nip05?.toLowerCase().includes(lowerQuery);
          if (matchesName || matchesNip05) {
            seen.add(pk);
            results.push({
              pubkey: pk,
              displayName: p.displayName || p.name,
              picture: p.picture,
              nip05: p.nip05,
            });
          }
          if (results.length >= 8) break;
        }
      }
    } catch {
      // Search failed silently
    }

    setSearchResults(results.slice(0, 8));
    setShowDropdown(results.length > 0);
    setSearchLoading(false);
  }, [publicKey]);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!searchQuery.trim()) {
      setSearchResults([]);
      setShowDropdown(false);
      return;
    }
    debounceRef.current = setTimeout(() => {
      searchRecipients(searchQuery);
    }, 300);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [searchQuery, searchRecipients]);

  function addRecipient(pubkey: string) {
    if (!recipients.includes(pubkey)) {
      setRecipients([...recipients, pubkey]);
    }
    setSearchQuery('');
    setSearchResults([]);
    setShowDropdown(false);
  }

  function removeRecipient(pubkey: string) {
    setRecipients(recipients.filter(pk => pk !== pubkey));
  }

  function handleSearchKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      const q = searchQuery.trim();
      if (q.startsWith('npub1')) {
        try { addRecipient(npubToPubkey(q)); } catch { /* invalid */ }
      } else if (isValidHexPubkey(q)) {
        addRecipient(q);
      } else if (searchResults.length > 0) {
        addRecipient(searchResults[0].pubkey);
      }
    }
  }

  function truncateNpub(pubkey: string): string {
    const npub = pubkeyToNpub(pubkey);
    return `${npub.slice(0, 12)}...${npub.slice(-6)}`;
  }

  async function handleImageUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploading(true);
    setError('');
    try {
      const url = await uploadImageToNostrBuild(file);
      setImageUrl(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Image upload failed');
    } finally {
      setUploading(false);
      e.target.value = '';
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');

    if (recipients.length === 0) { setError('At least one recipient is required'); return; }
    if (!address.trim()) { setError('Bitcoin address is required'); return; }

    setLoading(true);
    try {
      const amount = amountSats ? parseInt(amountSats, 10) : undefined;
      const memoWithImage = imageUrl
        ? `${memo.trim()}${memo.trim() ? '\n' : ''}${imageUrl}`
        : memo.trim() || undefined;

      // Send invoice to each recipient
      for (const recipientHex of recipients) {
        const invoiceEvent = createOnchainInvoice(
          {
            address: address.trim(),
            amount_sats: amount,
            memo: memoWithImage,
            expires_at: expirationSeconds > 0
              ? Math.floor(Date.now() / 1000) + expirationSeconds
              : 0,
          },
          recipientHex,
          publicKey
        );

        if (password.trim()) {
          invoiceEvent.tags.push(['password', password.trim()]);
        }
        if (imageUrl) {
          invoiceEvent.tags.push(['image', imageUrl]);
        }
        if (isRecurring) {
          invoiceEvent.tags.push(['recurring', 'true']);
          if (frequencyUnit === 'days') {
            invoiceEvent.tags.push(['frequency_days', frequencyValue || '30']);
          } else {
            invoiceEvent.tags.push(['frequency_blocks', frequencyValue || '4320']);
          }
          invoiceEvent.tags.push(['occurrences', occurrences.trim() || 'unlimited']);
        }
        if (opReturnEnabled) {
          invoiceEvent.tags.push(['op_return', 'true']);
        }

        const signed = await confirmAndSign(invoiceEvent);
        await publishWithFeedback(signed, 'Invoice published!');

        const eventId = signed.id;
        const opReturn = opReturnEnabled ? encodeInvoiceOpReturn(eventId) : null;

        // Generate OP_RETURN if enabled (use the last event's ID for display)
        if (opReturn) {
          setOpReturnHex(opReturn.scriptHex);
          setCreatedEventId(eventId);
        } else {
          setCreatedEventId(eventId);
        }

        const invoiceLink = `${INVOICE_BASE_URL}/${eventId}`;
        const payUrl = new URL(SEND_BASE_PATH, window.location.origin);
        payUrl.searchParams.set('invoice', eventId);
        payUrl.searchParams.set('to', address.trim());
        if (amount) payUrl.searchParams.set('amount', String(amount));

        const machinePayload = {
          type: 'nostr-onchain-invoice',
          invoice_event_id: eventId,
          address: address.trim(),
          amount_sats: amount ?? null,
          op_return_hex: opReturn?.scriptHex ?? null,
          pay_url: payUrl.toString(),
        };

        const dmContent = [
          `📄 Onchain Invoice`,
          ``,
          `Address: ${address.trim()}`,
          amount ? `Amount: ${amount.toLocaleString()} sats` : `Amount: Any`,
          memo.trim() ? `Memo: ${memo.trim()}` : '',
          ``,
          `View & Pay: ${invoiceLink}`,
          opReturn ? `\nOP_RETURN proof (auto-included when paying in-app):\n${opReturn.scriptHex}` : '',
          `\nPay in-app: ${payUrl.toString()}`,
          ``,
          `Pay via Nostr Onchain Signer or any Bitcoin wallet.`,
          `---`,
          JSON.stringify(machinePayload),
        ].filter(Boolean).join('\n');

        let encryptedDmContent: string;
        let dmKind: number;
        try {
          const result = await encryptDM(recipientHex, dmContent);
          encryptedDmContent = result.content;
          dmKind = result.kind;
        } catch (encryptErr) {
          const msg = encryptErr instanceof Error ? encryptErr.message : 'DM encryption failed';
          throw new Error(`${msg}. Unlock your vault to send encrypted invoice DMs.`);
        }

        const dmTags: string[][] = [
          ['p', recipientHex],
          ['e', eventId, '', 'mention'],
        ];
        if (opReturn) {
          dmTags.push(['op_return', opReturn.scriptHex]);
        }

        const dmEvent = {
          kind: dmKind,
          content: encryptedDmContent,
          tags: dmTags,
          created_at: Math.floor(Date.now() / 1000),
          pubkey: publicKey,
        };

        const signedDm = await confirmAndSign(dmEvent);
        await publishWithFeedback(signedDm, 'Invoice DM sent!');
      }

      if (!opReturnEnabled) {
        onCreated();
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create invoice';
      setError(message);
      toast.error(message);
    } finally {
      setLoading(false);
    }
  }

  async function copyOpReturn() {
    if (!opReturnHex) return;
    await navigator.clipboard.writeText(opReturnHex);
    setCopiedOpReturn(true);
    setTimeout(() => setCopiedOpReturn(false), 2000);
  }

  // Success view with OP_RETURN info
  if (createdEventId && opReturnEnabled && opReturnHex) {
    return (
      <div className="h-full flex flex-col">
        <div className="page-header px-4">
          <button onClick={onClose} className="btn-back">
            <ArrowLeft className="w-5 h-5" />
          </button>
          <h1>Invoice Created</h1>
        </div>

        <div className="flex-1 overflow-y-auto px-4 pb-24 space-y-4">
          <div className="bg-surface-700 rounded-xl p-4 space-y-3">
            <div className="flex items-center gap-2">
              <Check className="w-5 h-5 text-green-400" />
              <span className="text-sm text-white font-medium">Invoice published successfully</span>
            </div>
            <a
              href={`${INVOICE_BASE_URL}/${createdEventId}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-nostr hover:underline break-all"
            >
              {INVOICE_BASE_URL}/{createdEventId}
            </a>
          </div>

          <div className="bg-surface-700 rounded-xl p-4 space-y-3">
            <h3 className="text-sm font-medium text-white">OP_RETURN Proof</h3>
            <p className="text-xs text-gray-400">
              Share this hex with payers to include in their transaction. It proves on-chain
              which Nostr invoice was settled (39 bytes, well within OP_RETURN limits).
            </p>
            <div className="bg-surface-600 rounded-lg p-3">
              <code className="text-[11px] text-green-300 break-all font-mono">
                {opReturnHex}
              </code>
            </div>
            <button
              type="button"
              onClick={copyOpReturn}
              className="btn-primary w-full flex items-center justify-center gap-2 text-sm"
            >
              {copiedOpReturn ? (
                <><Check className="w-4 h-4" /> Copied!</>
              ) : (
                <><Copy className="w-4 h-4" /> Copy OP_RETURN Hex</>
              )}
            </button>
            <p className="text-[10px] text-gray-600">
              Add this as an OP_RETURN output in Sparrow or your wallet software when paying.
            </p>
          </div>

          <button
            type="button"
            onClick={onCreated}
            className="w-full text-center text-sm text-nostr hover:underline py-2"
          >
            Done
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      <div className="page-header px-4">
        <button onClick={onClose} className="btn-back">
          <ArrowLeft className="w-5 h-5" />
        </button>
        <h1>Create Invoice</h1>
      </div>

      <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto px-4 pb-safe space-y-4" style={{ paddingBottom: 'calc(6rem + var(--safe-bottom))' }}>
        {/* Recipient search */}
        <div>
          <label className="text-xs text-gray-400 mb-1 block">Recipients</label>

          {/* Recipient chips */}
          {recipients.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mb-2">
              {recipients.map(pk => (
                <span
                  key={pk}
                  className="inline-flex items-center gap-1 px-2 py-1 bg-surface-600 rounded-full text-xs text-white"
                >
                  <span className="font-mono text-[10px]">{truncateNpub(pk)}</span>
                  <button
                    type="button"
                    onClick={() => removeRecipient(pk)}
                    className="w-3.5 h-3.5 flex items-center justify-center hover:bg-surface-500 rounded-full"
                  >
                    <X className="w-2.5 h-2.5" />
                  </button>
                </span>
              ))}
            </div>
          )}

          {/* Search input */}
          <div className="relative">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-500" />
              <input
                ref={searchInputRef}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onFocus={() => { if (searchResults.length > 0) setShowDropdown(true); }}
                onKeyDown={handleSearchKeyDown}
                placeholder="npub, hex, NIP-05, or name..."
                className="input-field text-sm pl-9 pr-8"
              />
              {searchLoading && (
                <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 animate-spin text-gray-500" />
              )}
            </div>

            {/* Dropdown */}
            {showDropdown && searchResults.length > 0 && (
              <div
                ref={dropdownRef}
                className="absolute z-50 w-full mt-1 bg-surface-700 border border-surface-200/10 rounded-xl shadow-xl max-h-60 overflow-y-auto"
              >
                {searchResults.map(result => (
                  <button
                    key={result.pubkey}
                    type="button"
                    onClick={() => addRecipient(result.pubkey)}
                    className="w-full px-3 py-2.5 flex items-center gap-3 hover:bg-surface-600 transition-colors text-left first:rounded-t-xl last:rounded-b-xl"
                  >
                    {result.picture ? (
                      <img
                        src={result.picture}
                        alt=""
                        className="w-8 h-8 rounded-full object-cover flex-shrink-0"
                        onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                      />
                    ) : (
                      <div className="w-8 h-8 rounded-full bg-surface-500 flex-shrink-0" />
                    )}
                    <div className="flex-1 min-w-0">
                      <div className="text-sm text-white truncate">
                        {result.displayName || truncateNpub(result.pubkey)}
                      </div>
                      <div className="text-[10px] text-gray-400 truncate">
                        {result.nip05 || truncateNpub(result.pubkey)}
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
          <p className="text-[10px] text-gray-600 mt-1">Search by npub, hex pubkey, NIP-05, or display name</p>
        </div>

        <div>
          <label className="text-xs text-gray-400 mb-1 block">Your Bitcoin Address</label>
          <input
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="bc1p..."
            className="input-field text-sm font-mono"
          />
          <p className="text-[10px] text-gray-600 mt-1">Auto-filled from your Taproot key</p>
        </div>

        <div>
          <label className="text-xs text-gray-400 mb-1 block">Amount (sats, optional)</label>
          <input
            type="number"
            value={amountSats}
            onChange={(e) => setAmountSats(e.target.value)}
            placeholder="Leave empty for any amount"
            className="input-field text-sm"
          />
        </div>

        <div>
          <label className="text-xs text-gray-400 mb-1 flex items-center justify-between">
            <span>Memo (optional)</span>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              className="text-[10px] text-nostr hover:underline flex items-center gap-1"
            >
              {uploading ? <Loader2 className="w-2.5 h-2.5 animate-spin" /> : <ImageIcon className="w-2.5 h-2.5" />}
              Attach Image
            </button>
          </label>
          <textarea
            value={memo}
            onChange={(e) => setMemo(e.target.value)}
            placeholder="What is this invoice for?"
            className="input-field h-16 resize-none text-sm"
          />
          <input ref={fileInputRef} type="file" accept="image/*" onChange={handleImageUpload} className="hidden" />
          {imageUrl && (
            <div className="relative w-16 h-16 rounded-lg overflow-hidden bg-surface-700 mt-2">
              <img src={imageUrl} alt="" className="w-full h-full object-cover" />
              <button type="button" onClick={() => setImageUrl('')} className="absolute top-0 right-0 w-4 h-4 bg-red-500 rounded-full flex items-center justify-center">
                <X className="w-2 h-2 text-white" />
              </button>
            </div>
          )}
        </div>

        <div>
          <label className="text-xs text-gray-400 mb-1 block">Password Protection (optional)</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Require password to view address"
            className="input-field text-sm"
          />
          <p className="text-[10px] text-gray-600 mt-1">If set, viewers must enter this password to see the Bitcoin address</p>
        </div>

        {/* Expiration selector */}
        <div>
          <label className="text-xs text-gray-400 mb-1 block">Expiration</label>
          <select
            value={expirationSeconds}
            onChange={(e) => setExpirationSeconds(Number(e.target.value))}
            className="input-field text-sm"
          >
            {EXPIRATION_OPTIONS.map((opt) => (
              <option key={opt.label} value={opt.seconds}>
                {opt.label}{opt.seconds === 7 * 24 * 60 * 60 ? ' (default)' : ''}
              </option>
            ))}
          </select>
        </div>

        {/* Recurring invoice */}
        <div className="space-y-3">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={isRecurring}
              onChange={(e) => setIsRecurring(e.target.checked)}
              className="w-4 h-4 rounded border-surface-200/20 bg-surface-700 text-bitcoin focus:ring-bitcoin/50"
            />
            <Repeat className="w-3.5 h-3.5 text-gray-400" />
            <span className="text-xs text-gray-300">Make this a recurring invoice</span>
          </label>

          {isRecurring && (
            <div className="pl-6 space-y-3 border-l-2 border-surface-200/10">
              <div>
                <label className="text-[10px] text-gray-500 mb-1 block">Frequency</label>
                <div className="flex gap-2">
                  <div className="flex-1 flex items-center gap-2">
                    <span className="text-xs text-gray-400 whitespace-nowrap">Every</span>
                    <input
                      type="number"
                      value={frequencyValue}
                      onChange={(e) => setFrequencyValue(e.target.value)}
                      className="input-field text-sm w-20"
                      min="1"
                    />
                  </div>
                  <select
                    value={frequencyUnit}
                    onChange={(e) => {
                      const unit = e.target.value as FrequencyUnit;
                      setFrequencyUnit(unit);
                      if (unit === 'blocks' && frequencyValue === '30') {
                        setFrequencyValue('4320');
                      } else if (unit === 'days' && frequencyValue === '4320') {
                        setFrequencyValue('30');
                      }
                    }}
                    className="input-field text-sm w-24"
                  >
                    <option value="days">days</option>
                    <option value="blocks">blocks</option>
                  </select>
                </div>
                {frequencyUnit === 'blocks' && (
                  <p className="text-[10px] text-gray-600 mt-1">~4320 blocks = ~30 days</p>
                )}
              </div>

              <div>
                <label className="text-[10px] text-gray-500 mb-1 block">Total occurrences</label>
                <input
                  type="text"
                  value={occurrences}
                  onChange={(e) => setOccurrences(e.target.value)}
                  placeholder="Leave empty for unlimited"
                  className="input-field text-sm"
                />
                <p className="text-[10px] text-gray-600 mt-1">Number of payments, or leave blank for unlimited</p>
              </div>
            </div>
          )}
        </div>

        {/* OP_RETURN toggle */}
        <div className="space-y-1">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={opReturnEnabled}
              onChange={(e) => setOpReturnEnabled(e.target.checked)}
              className="w-4 h-4 rounded border-surface-200/20 bg-surface-700 text-bitcoin focus:ring-bitcoin/50"
            />
            <span className="text-xs text-gray-300">Embed invoice hash on-chain (OP_RETURN)</span>
          </label>
          <p className="text-[10px] text-gray-600 pl-6">
            When paid, the transaction will contain SHA256(invoice_event_id) in an OP_RETURN output, proving which invoice was settled.
          </p>
        </div>

        {error && <p className="text-red-400 text-sm">{error}</p>}

        <button
          type="submit"
          disabled={loading || recipients.length === 0}
          className="btn-primary w-full flex items-center justify-center gap-2 min-h-[44px]"
        >
          {loading ? (
            <><Loader2 className="w-4 h-4 animate-spin" /> Creating Invoice...</>
          ) : (
            <><Send className="w-4 h-4" /> Create &amp; Send Invoice</>
          )}
        </button>

        <p className="text-[10px] text-gray-600 text-center">
          Creates a kind 9733 onchain invoice event and sends a DM notification to the recipient{recipients.length > 1 ? 's' : ''}
        </p>
      </form>
    </div>
  );
}
