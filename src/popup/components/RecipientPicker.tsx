import { useState, useRef, useEffect, useCallback } from 'react';
import { Search, User, Wallet, FileText, X, Loader2, ChevronDown } from 'lucide-react';
import { searchMentions, type MentionSearchResult } from '@/lib/nostr/mention-search';
import { pubkeyToTaprootAddress } from '@/lib/bitcoin/address';
import { loadMultisigWallets, type ArchivedMultisig } from '@/lib/bitcoin/wallet-store';
import { safeImageUrl } from '@/lib/utils';
import { pubkeyToNpub } from '@/lib/nostr/keys';

type PickerTab = 'search' | 'wallets' | 'invoices';

interface RecipientPickerProps {
  publicKey: string;
  value: string;
  onChange: (address: string) => void;
  onAmountSuggestion?: (amount: string) => void;
  onInvoiceSelect?: (eventId: string) => void;
}

interface InvoiceItem {
  eventId: string;
  address: string;
  amountSats: number | null;
  memo?: string;
  createdAt: number;
}

export function RecipientPicker({ publicKey, value, onChange, onAmountSuggestion, onInvoiceSelect }: RecipientPickerProps) {
  const [tab, setTab] = useState<PickerTab>('search');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<MentionSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [showDropdown, setShowDropdown] = useState(false);
  const [wallets, setWallets] = useState<ArchivedMultisig[]>([]);
  const [invoices, setInvoices] = useState<InvoiceItem[]>([]);
  const [selectedLabel, setSelectedLabel] = useState('');
  const dropdownRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    loadMultisigWallets().then(setWallets).catch(() => {});
    loadInvoices();
  }, [publicKey]);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setShowDropdown(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  async function loadInvoices() {
    try {
      const cached = await chrome.storage.local.get(`invoices_${publicKey}`);
      const raw: any[] = cached[`invoices_${publicKey}`] ?? [];
      setInvoices(raw.map((inv) => ({
        eventId: inv.eventId || inv.id,
        address: inv.address || '',
        amountSats: inv.amount_sats ?? inv.amountSats ?? null,
        memo: inv.memo || inv.description || '',
        createdAt: inv.created_at || inv.createdAt || 0,
      })).filter((i) => i.address));
    } catch {}
  }

  const handleSearch = useCallback(async (q: string) => {
    if (!q.trim()) { setResults([]); setShowDropdown(false); return; }
    setSearching(true);
    const res = await searchMentions(q, publicKey);
    setResults(res);
    setShowDropdown(res.length > 0);
    setSearching(false);
  }, [publicKey]);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!query.trim()) { setResults([]); setShowDropdown(false); return; }
    debounceRef.current = setTimeout(() => handleSearch(query), 300);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [query, handleSearch]);

  function selectNostrUser(result: MentionSearchResult) {
    const address = pubkeyToTaprootAddress(result.pubkey);
    onChange(address);
    setSelectedLabel(result.displayName || result.nip05 || pubkeyToNpub(result.pubkey).slice(0, 16) + '...');
    setQuery('');
    setShowDropdown(false);
  }

  function selectWallet(wallet: ArchivedMultisig) {
    onChange(wallet.wallet.address);
    setSelectedLabel(wallet.name);
    setShowDropdown(false);
  }

  function selectInvoice(invoice: InvoiceItem) {
    onChange(invoice.address);
    setSelectedLabel(invoice.memo || `Invoice ${invoice.eventId.slice(0, 8)}...`);
    if (invoice.amountSats && onAmountSuggestion) {
      onAmountSuggestion(String(invoice.amountSats));
    }
    if (onInvoiceSelect) {
      onInvoiceSelect(invoice.eventId);
    }
    setShowDropdown(false);
  }

  function clearSelection() {
    setSelectedLabel('');
    onChange('');
  }

  if (selectedLabel && value) {
    return (
      <div className="flex items-center gap-2 px-3 py-2.5 rounded-xl bg-white/5 border border-white/10">
        <User className="w-4 h-4 text-gray-400 flex-shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium truncate">{selectedLabel}</p>
          <p className="text-[10px] text-gray-500 font-mono truncate">{value}</p>
        </div>
        <button onClick={clearSelection} className="p-1 hover:bg-white/10 rounded-lg">
          <X className="w-3.5 h-3.5 text-gray-400" />
        </button>
      </div>
    );
  }

  return (
    <div className="relative" ref={dropdownRef}>
      {/* Tab selector */}
      <div className="flex gap-1 mb-2">
        {([
          { id: 'search' as PickerTab, icon: Search, label: 'Search' },
          { id: 'wallets' as PickerTab, icon: Wallet, label: 'Wallets' },
          { id: 'invoices' as PickerTab, icon: FileText, label: 'Invoices' },
        ]).map(({ id, icon: Icon, label }) => (
          <button
            key={id}
            type="button"
            onClick={() => { setTab(id); setShowDropdown(id !== 'search'); }}
            className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[10px] font-medium transition-colors ${
              tab === id ? 'bg-white/10 text-white' : 'text-gray-500 hover:text-gray-300'
            }`}
          >
            <Icon className="w-3 h-3" />
            {label}
            {id === 'wallets' && wallets.length > 0 && (
              <span className="text-[9px] text-gray-500">({wallets.length})</span>
            )}
          </button>
        ))}
      </div>

      {/* Search input (always visible for manual address entry) */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-500" />
        <input
          ref={inputRef}
          value={tab === 'search' ? query : value}
          onChange={(e) => {
            if (tab === 'search') {
              setQuery(e.target.value);
            } else {
              onChange(e.target.value);
            }
          }}
          onFocus={() => {
            if (tab === 'search' && results.length > 0) setShowDropdown(true);
            if (tab !== 'search') setShowDropdown(true);
          }}
          placeholder={
            tab === 'search' ? 'Name, NIP-05, npub, or bc1p address...'
            : tab === 'wallets' ? 'Select a wallet or paste address...'
            : 'Select an invoice or paste address...'
          }
          className="input-field text-sm pl-9 pr-8"
        />
        {searching && (
          <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 animate-spin text-gray-500" />
        )}
      </div>

      {/* Dropdown */}
      {showDropdown && (
        <div className="absolute z-50 w-full mt-1 bg-gray-900 border border-white/10 rounded-xl shadow-xl max-h-60 overflow-y-auto">
          {tab === 'search' && results.map((r) => (
            <button
              key={r.pubkey}
              type="button"
              onClick={() => selectNostrUser(r)}
              className="w-full px-3 py-2.5 flex items-center gap-3 hover:bg-white/5 transition-colors text-left"
            >
              {r.picture ? (
                <img src={safeImageUrl(r.picture)} alt="" className="w-8 h-8 rounded-full object-cover flex-shrink-0" />
              ) : (
                <div className="w-8 h-8 rounded-full bg-white/10 flex items-center justify-center flex-shrink-0">
                  <User className="w-4 h-4 text-gray-500" />
                </div>
              )}
              <div className="flex-1 min-w-0">
                <p className="text-sm text-white truncate">{r.displayName || pubkeyToNpub(r.pubkey).slice(0, 16) + '...'}</p>
                <p className="text-[10px] text-gray-500 truncate">{r.nip05 || pubkeyToNpub(r.pubkey).slice(0, 24) + '...'}</p>
              </div>
              <span className="text-[9px] text-gray-600 flex-shrink-0">Taproot</span>
            </button>
          ))}

          {tab === 'wallets' && wallets.length === 0 && (
            <p className="px-3 py-4 text-sm text-gray-500 text-center">No multisig wallets found</p>
          )}
          {tab === 'wallets' && wallets.map((w) => (
            <button
              key={w.id}
              type="button"
              onClick={() => selectWallet(w)}
              className="w-full px-3 py-2.5 flex items-center gap-3 hover:bg-white/5 transition-colors text-left"
            >
              <div className="w-8 h-8 rounded-full bg-purple-500/20 flex items-center justify-center flex-shrink-0">
                <Wallet className="w-4 h-4 text-purple-400" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm text-white truncate">{w.name}</p>
                <p className="text-[10px] text-gray-500 font-mono truncate">{w.wallet.address}</p>
              </div>
              <span className="text-[9px] text-gray-600 flex-shrink-0">
                {w.wallet.config.threshold}/{w.wallet.config.pubkeys.length}
              </span>
            </button>
          ))}

          {tab === 'invoices' && invoices.length === 0 && (
            <p className="px-3 py-4 text-sm text-gray-500 text-center">No invoices found</p>
          )}
          {tab === 'invoices' && invoices.map((inv) => (
            <button
              key={inv.eventId}
              type="button"
              onClick={() => selectInvoice(inv)}
              className="w-full px-3 py-2.5 flex items-center gap-3 hover:bg-white/5 transition-colors text-left"
            >
              <div className="w-8 h-8 rounded-full bg-bitcoin/20 flex items-center justify-center flex-shrink-0">
                <FileText className="w-4 h-4 text-bitcoin" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm text-white truncate">{inv.memo || `Invoice`}</p>
                <p className="text-[10px] text-gray-500 font-mono truncate">{inv.address}</p>
              </div>
              {inv.amountSats && (
                <span className="text-xs text-bitcoin font-medium flex-shrink-0">
                  {inv.amountSats.toLocaleString()} sats
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
