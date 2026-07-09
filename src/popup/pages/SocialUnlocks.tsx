import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Lock, Unlock, Plus, Copy, Check, ArrowLeft, Users, ExternalLink,
  Search, X, Loader2, ImageIcon, Share2,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { loadRelayList, getReadRelays, getWriteRelays } from '@/lib/nostr/relays';
import { publishEvent } from '@/lib/nostr/discovery';
import {
  createSocialUnlockEvent,
  createUnlockSignEvent,
  createRevealEvent,
  decryptContent,
  parseSocialUnlockContent,
  parseSocialUnlockSignContent,
  parseSocialUnlockRevealContent,
  type SocialUnlockContent,
  type ContentType,
} from '@/lib/nostr/social-unlock';
import { CUSTOM_KIND } from '@/lib/nostr/kinds';
import { createMessageId } from '@/shared/messages';
import { npubToPubkey, pubkeyToNpub, isValidHexPubkey } from '@/lib/nostr/keys';
import { resolveNip05 } from '@/lib/nostr/nip05';
import { uploadImageToNostrBuild } from '@/lib/nostr/image-upload';
import { getCachedProfile } from '@/lib/nostr/cache';
import { safeImageUrl } from '@/lib/utils';
import { ProfileBadge } from '@/popup/components/ProfileBadge';
import type { SignedEvent } from '@/lib/nostr/events';
import type { ProfileMetadata } from '@/lib/nostr/social';

const UNLOCK_BASE_URL = `${typeof window !== 'undefined' ? window.location.origin : 'https://nostr-onchain-signer.vercel.app'}/unlock`;

// ─── Types ──────────────────────────────────────────────────────

interface UnlockItem {
  eventId: string;
  pubkey: string;
  content: SocialUnlockContent;
  signatures: { pubkey: string; message?: string }[];
  revealed?: { decryption_key: string; revealed_at: number };
  createdAt: number;
}

type View = 'list' | 'create' | 'detail' | 'wild';

type SignerMode = 'anyone' | 'followers' | 'selected';

interface SearchResult {
  pubkey: string;
  displayName?: string;
  picture?: string;
  nip05?: string;
}

// ─── Local persistence helpers ──────────────────────────────────

function localCacheKey(pubkey: string) {
  return `my_social_unlocks_${pubkey}`;
}

async function loadCachedUnlocks(pubkey: string): Promise<UnlockItem[]> {
  const result = await chrome.storage.local.get(localCacheKey(pubkey));
  return result[localCacheKey(pubkey)] ?? [];
}

async function saveCachedUnlocks(pubkey: string, items: UnlockItem[]) {
  await chrome.storage.local.set({ [localCacheKey(pubkey)]: items });
}

// ─── Component ──────────────────────────────────────────────────

export function SocialUnlocks() {
  const navigate = useNavigate();
  const { publicKey, confirmAndSign } = useAuth();
  const [view, setView] = useState<View>('list');
  const [unlocks, setUnlocks] = useState<UnlockItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedUnlock, setSelectedUnlock] = useState<UnlockItem | null>(null);

  const [storedKeys, setStoredKeys] = useState<Record<string, string>>({});

  useEffect(() => {
    loadStoredKeys();
    loadCachedThenFetch();
  }, [publicKey]);

  async function loadStoredKeys() {
    const result = await chrome.storage.local.get('social_unlock_keys');
    setStoredKeys(result.social_unlock_keys ?? {});
  }

  async function saveKey(eventId: string, key: string) {
    const updated = { ...storedKeys, [eventId]: key };
    setStoredKeys(updated);
    await chrome.storage.local.set({ social_unlock_keys: updated });
  }

  async function loadCachedThenFetch() {
    setLoading(true);
    try {
      const cached = await loadCachedUnlocks(publicKey);
      if (cached.length > 0) setUnlocks(cached);

      const relayList = await loadRelayList();
      const readRelays = getReadRelays(relayList);
      const items = await fetchSocialUnlocks(readRelays, publicKey);

      // Merge: keep relay items as source of truth, but preserve any
      // locally-created items that haven't propagated yet.
      const relayIds = new Set(items.map((i) => i.eventId));
      const localOnly = cached.filter((c) => !relayIds.has(c.eventId));
      const merged = [...items, ...localOnly].sort((a, b) => b.createdAt - a.createdAt);

      setUnlocks(merged);
      await saveCachedUnlocks(publicKey, merged);
    } catch (err) {
      console.error('Failed to fetch social unlocks:', err);
    } finally {
      setLoading(false);
    }
  }

  async function handleCreated(eventId: string, key: string, newItem: UnlockItem) {
    await saveKey(eventId, key);
    setUnlocks((prev) => {
      const next = [newItem, ...prev];
      saveCachedUnlocks(publicKey, next);
      return next;
    });
  }

  function handleSelectUnlock(item: UnlockItem) {
    setSelectedUnlock(item);
    setView('detail');
  }

  if (view === 'wild') {
    return (
      <WildView
        publicKey={publicKey}
        onBack={() => setView('list')}
        onSelectUnlock={handleSelectUnlock}
      />
    );
  }

  if (view === 'create') {
    return (
      <CreateUnlockView
        publicKey={publicKey}
        confirmAndSign={confirmAndSign}
        onCreated={(eventId, key, newItem) => {
          handleCreated(eventId, key, newItem);
          setView('list');
        }}
        onBack={() => setView('list')}
      />
    );
  }

  if (view === 'detail' && selectedUnlock) {
    return (
      <DetailView
        item={selectedUnlock}
        publicKey={publicKey}
        confirmAndSign={confirmAndSign}
        storedKey={storedKeys[selectedUnlock.eventId]}
        onBack={() => {
          setView('list');
          loadCachedThenFetch();
        }}
        onKeyStored={(eventId, key) => saveKey(eventId, key)}
      />
    );
  }

  return (
    <div className="h-full flex flex-col p-4 md:p-6 pb-24">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <button onClick={() => navigate('/')} className="btn-back">
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div>
            <h1 className="text-lg font-bold">Social Unlocks</h1>
            <p className="text-xs text-gray-500 mt-0.5">Lock content behind collective signatures</p>
          </div>
        </div>
        <button
          onClick={() => setView('create')}
          className="btn-primary flex items-center gap-1.5 text-sm px-3 py-2"
        >
          <Plus className="w-4 h-4" />
          Create
        </button>
      </div>

      {/* Tab bar: My Unlocks / The Wild */}
      <div className="flex gap-2 mb-4">
        <button
          onClick={() => setView('list')}
          className="flex-1 py-2 rounded-xl text-sm font-medium bg-white/10 text-white border border-white/20"
        >
          My Unlocks
        </button>
        <button
          onClick={() => setView('wild')}
          className="flex-1 py-2 rounded-xl text-sm font-medium text-gray-400 hover:text-white hover:bg-white/5 border border-transparent transition-colors"
        >
          The Wild 🌐
        </button>
      </div>

      {loading && unlocks.length === 0 ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="animate-pulse text-gray-500">Loading unlocks...</div>
        </div>
      ) : unlocks.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center text-center px-6">
          <div className="w-16 h-16 rounded-2xl bg-white/5 flex items-center justify-center mb-4">
            <Lock className="w-8 h-8 text-gray-600" />
          </div>
          <p className="text-sm text-gray-400 mb-1">No social unlocks yet</p>
          <p className="text-xs text-gray-600">Create one to lock content behind signatures</p>
        </div>
      ) : (
        <div className="space-y-3 overflow-y-auto flex-1">
          {unlocks.map((item) => (
            <UnlockCard
              key={item.eventId}
              item={item}
              isOwner={item.pubkey === publicKey}
              onClick={() => handleSelectUnlock(item)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Unlock Card ────────────────────────────────────────────────

function UnlockCard({ item, isOwner, onClick }: { item: UnlockItem; isOwner: boolean; onClick: () => void }) {
  const progress = item.signatures.length / item.content.threshold;
  const isUnlocked = item.signatures.length >= item.content.threshold;

  return (
    <button onClick={onClick} className="card w-full text-left hover:border-white/20 transition-all">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <h3 className="text-sm font-semibold truncate">{item.content.title}</h3>
            <StatusBadge isUnlocked={isUnlocked} progress={progress} />
          </div>
          {item.content.description && (
            <p className="text-xs text-gray-500 line-clamp-2 mb-2">{item.content.description}</p>
          )}
          <div className="flex items-center gap-3 text-[10px] text-gray-500">
            <span className="flex items-center gap-1">
              <Users className="w-3 h-3" />
              {item.signatures.length}/{item.content.threshold} signatures
            </span>
            {isOwner && <span className="text-nostr">Created by you</span>}
          </div>
        </div>
        <div className="flex-shrink-0">
          {isUnlocked ? (
            <Unlock className="w-5 h-5 text-green-400" />
          ) : (
            <Lock className="w-5 h-5 text-gray-600" />
          )}
        </div>
      </div>

      <div className="mt-3 h-1.5 bg-white/5 rounded-full overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-500"
          style={{
            width: `${Math.min(progress * 100, 100)}%`,
            background: isUnlocked
              ? 'linear-gradient(90deg, #22c55e, #4ade80)'
              : `linear-gradient(90deg, #6b7280, ${progress > 0.5 ? '#eab308' : '#9ca3af'})`,
          }}
        />
      </div>
    </button>
  );
}

// ─── Status Badge ───────────────────────────────────────────────

function StatusBadge({ isUnlocked, progress }: { isUnlocked: boolean; progress: number }) {
  if (isUnlocked) {
    return (
      <span className="px-1.5 py-0.5 text-[9px] font-medium rounded bg-green-500/20 text-green-400">
        UNLOCKED
      </span>
    );
  }
  if (progress > 0) {
    return (
      <span className="px-1.5 py-0.5 text-[9px] font-medium rounded bg-yellow-500/20 text-yellow-400">
        UNLOCKING
      </span>
    );
  }
  return (
    <span className="px-1.5 py-0.5 text-[9px] font-medium rounded bg-white/10 text-gray-400">
      LOCKED
    </span>
  );
}

// ─── Create Unlock View ─────────────────────────────────────────

interface CreateUnlockViewProps {
  publicKey: string;
  confirmAndSign: (event: { kind: number; content: string; tags: string[][]; created_at: number }) => Promise<SignedEvent>;
  onCreated: (eventId: string, key: string, item: UnlockItem) => void;
  onBack: () => void;
}

function CreateUnlockView({ publicKey, confirmAndSign, onCreated, onBack }: CreateUnlockViewProps) {
  const { following } = useAuth();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [secretContent, setSecretContent] = useState('');
  const [contentType, setContentType] = useState<ContentType>('text');
  const [threshold, setThreshold] = useState(3);
  const [totalSlots, setTotalSlots] = useState(10);
  const [publishing, setPublishing] = useState(false);
  const [createdEventId, setCreatedEventId] = useState<string | null>(null);
  const [createdItem, setCreatedItem] = useState<UnlockItem | null>(null);
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [copiedLink, setCopiedLink] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [shared, setShared] = useState(false);

  // Signer mode
  const [signerMode, setSignerMode] = useState<SignerMode>('anyone');
  const [selectedSigners, setSelectedSigners] = useState<string[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [showDropdown, setShowDropdown] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  // Hashtags
  const [hashtags, setHashtags] = useState<string[]>(['social-unlock']);
  const [tagInput, setTagInput] = useState('');

  // Image upload
  const [uploadedImageUrl, setUploadedImageUrl] = useState('');
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (
        dropdownRef.current && !dropdownRef.current.contains(e.target as Node) &&
        searchInputRef.current && !searchInputRef.current.contains(e.target as Node)
      ) {
        setShowDropdown(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const searchProfiles = useCallback(async (query: string) => {
    if (!query.trim()) {
      setSearchResults([]);
      setShowDropdown(false);
      return;
    }
    setSearchLoading(true);
    const results: SearchResult[] = [];
    const seen = new Set<string>();

    try {
      if (query.startsWith('npub1')) {
        try {
          const pk = npubToPubkey(query);
          if (!seen.has(pk)) { seen.add(pk); results.push({ pubkey: pk }); }
        } catch { /* invalid npub */ }
      } else if (/^[0-9a-f]{64}$/i.test(query)) {
        const pk = query.toLowerCase();
        if (!seen.has(pk)) { seen.add(pk); results.push({ pubkey: pk }); }
      }

      if (query.includes('@') || (query.includes('.') && !query.startsWith('npub'))) {
        const nip05Result = await resolveNip05(query.includes('@') ? query : `_@${query}`);
        if (nip05Result && !seen.has(nip05Result.pubkey)) {
          seen.add(nip05Result.pubkey);
          results.push({ pubkey: nip05Result.pubkey, nip05: query });
        }
      }

      const followingStored = await chrome.storage.local.get(`following_${publicKey}`);
      const followingList: string[] = followingStored[`following_${publicKey}`] ?? [];
      const profileKeys = followingList.map((pk) => `profile_${pk}`);
      const batchSize = 50;
      for (let i = 0; i < profileKeys.length; i += batchSize) {
        const batch = profileKeys.slice(i, i + batchSize);
        const cached = await chrome.storage.local.get(batch);
        for (const key of batch) {
          const profile = cached[key] as ProfileMetadata | undefined;
          if (!profile) continue;
          const pk = profile.pubkey;
          if (seen.has(pk)) continue;
          const lq = query.toLowerCase();
          const matches =
            profile.name?.toLowerCase().includes(lq) ||
            profile.displayName?.toLowerCase().includes(lq) ||
            profile.nip05?.toLowerCase().includes(lq) ||
            pk.startsWith(lq);
          if (matches) {
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

      const cacheResult = await chrome.storage.local.get('profile_cache_v2');
      const profileCache = cacheResult['profile_cache_v2'];
      if (profileCache?.profiles) {
        const lq = query.toLowerCase();
        for (const [pk, entry] of Object.entries(profileCache.profiles) as [string, { profile: ProfileMetadata }][]) {
          if (seen.has(pk)) continue;
          const p = entry.profile;
          if (
            p.name?.toLowerCase().includes(lq) ||
            p.displayName?.toLowerCase().includes(lq) ||
            p.nip05?.toLowerCase().includes(lq)
          ) {
            seen.add(pk);
            results.push({ pubkey: pk, displayName: p.displayName || p.name, picture: p.picture, nip05: p.nip05 });
          }
          if (results.length >= 8) break;
        }
      }
    } catch { /* silent */ }

    setSearchResults(results.slice(0, 8));
    setShowDropdown(results.length > 0);
    setSearchLoading(false);
  }, [publicKey]);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!searchQuery.trim()) { setSearchResults([]); setShowDropdown(false); return; }
    debounceRef.current = setTimeout(() => searchProfiles(searchQuery), 300);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [searchQuery, searchProfiles]);

  function addSigner(pubkey: string) {
    if (!selectedSigners.includes(pubkey)) setSelectedSigners([...selectedSigners, pubkey]);
    setSearchQuery('');
    setSearchResults([]);
    setShowDropdown(false);
  }

  function removeSigner(pubkey: string) {
    setSelectedSigners(selectedSigners.filter((pk) => pk !== pubkey));
  }

  function handleSearchKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      const q = searchQuery.trim();
      if (q.startsWith('npub1')) {
        try { addSigner(npubToPubkey(q)); } catch { /* invalid */ }
      } else if (isValidHexPubkey(q)) {
        addSigner(q);
      } else if (searchResults.length > 0) {
        addSigner(searchResults[0].pubkey);
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
    try {
      const url = await uploadImageToNostrBuild(file);
      setUploadedImageUrl(url);
      if (contentType === 'image') setSecretContent(url);
    } catch (err) {
      console.error('Image upload failed:', err);
    } finally {
      setUploading(false);
      e.target.value = '';
    }
  }

  function buildAllowedPubkeys(): string[] | undefined {
    if (signerMode === 'anyone') return undefined;
    if (signerMode === 'followers') return Array.from(following);
    if (signerMode === 'selected' && selectedSigners.length > 0) return selectedSigners;
    return undefined;
  }

  async function handleCreate() {
    if (!title.trim() || !secretContent.trim() || threshold < 1 || totalSlots < threshold) return;
    setPublishing(true);

    try {
      const finalContent =
        uploadedImageUrl && contentType === 'text'
          ? `${secretContent}\n\n${uploadedImageUrl}`
          : secretContent;

      const allowedPubkeys = buildAllowedPubkeys();

      const { event, decryptionKey } = await createSocialUnlockEvent({
        title: title.trim(),
        description: description.trim() || undefined,
        plaintext: finalContent,
        content_type: uploadedImageUrl && contentType === 'text' ? 'text' : contentType,
        threshold,
        total_slots: totalSlots,
        allowed_pubkeys: allowedPubkeys,
        myPubkey: publicKey,
      });

      const signed = await confirmAndSign(event);
      await publishEvent(signed);

      const newItem: UnlockItem = {
        eventId: signed.id,
        pubkey: publicKey,
        content: JSON.parse(event.content),
        signatures: [],
        createdAt: event.created_at,
      };

      setCreatedEventId(signed.id);
      setCreatedItem(newItem);
      setCreatedKey(decryptionKey);
    } catch (err) {
      console.error('Failed to create social unlock:', err);
    } finally {
      setPublishing(false);
    }
  }

  async function copyLink() {
    if (!createdEventId) return;
    await navigator.clipboard.writeText(`${UNLOCK_BASE_URL}/${createdEventId}`);
    setCopiedLink(true);
    setTimeout(() => setCopiedLink(false), 2000);
  }

  async function copyEventId() {
    if (!createdEventId) return;
    await navigator.clipboard.writeText(createdEventId);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  async function shareToNostr() {
    if (!createdEventId || !createdItem) return;
    setSharing(true);
    try {
      const noteContent = [
        `\u{1F513} I've locked content behind ${threshold} signatures! Help unlock it:`,
        `${UNLOCK_BASE_URL}/${createdEventId}`,
        '',
        `${title.trim()}${description.trim() ? ` - ${description.trim()}` : ''}`,
      ].join('\n');

      const noteEvent = {
        kind: 1,
        content: noteContent,
        tags: [['t', 'social-unlock'], ['e', createdEventId], ...hashtags.filter((t) => t !== 'social-unlock').map((t) => ['t', t])],
        created_at: Math.floor(Date.now() / 1000),
      };

      const signed = await confirmAndSign(noteEvent);
      await publishEvent(signed);
      setShared(true);
    } catch (err) {
      console.error('Failed to share:', err);
    } finally {
      setSharing(false);
    }
  }

  // ── Success view after creation ──
  if (createdEventId && createdItem && createdKey) {
    return (
      <div className="h-full flex flex-col p-4 md:p-6 pb-24">
        <button
          onClick={() => onCreated(createdEventId, createdKey, createdItem)}
          className="btn-back mb-4"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to Unlocks
        </button>

        <div className="flex-1 flex flex-col items-center justify-center text-center px-4">
          <div className="w-16 h-16 rounded-2xl bg-green-500/15 flex items-center justify-center mb-4 animate-[scale-in_0.3s_ease-out]">
            <Check className="w-8 h-8 text-green-400" />
          </div>
          <h2 className="text-lg font-bold mb-2">Social Unlock Created!</h2>
          <p className="text-xs text-gray-500 mb-4">Share the link so others can sign</p>

          {/* Shareable link */}
          <div className="card w-full max-w-sm mb-3">
            <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">Shareable Link</p>
            <div className="flex items-center gap-2">
              <code className="text-xs text-gray-300 truncate flex-1 font-mono">
                {UNLOCK_BASE_URL}/{createdEventId}
              </code>
              <button onClick={copyLink} className="p-1.5 hover:bg-surface-700 rounded-lg">
                {copiedLink ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5 text-gray-500" />}
              </button>
            </div>
          </div>

          {/* Copy Link button */}
          <button
            onClick={copyLink}
            className="btn-primary w-full max-w-sm flex items-center justify-center gap-2 mb-2"
          >
            {copiedLink ? (
              <><Check className="w-4 h-4" /> Link Copied!</>
            ) : (
              <><Copy className="w-4 h-4" /> Copy Link</>
            )}
          </button>

          {/* Share to Nostr button */}
          <button
            onClick={shareToNostr}
            disabled={sharing || shared}
            className="w-full max-w-sm flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium border border-nostr/30 text-nostr hover:bg-nostr/10 transition-colors disabled:opacity-50"
          >
            {shared ? (
              <><Check className="w-4 h-4" /> Shared to Nostr</>
            ) : sharing ? (
              <span className="animate-pulse">Sharing...</span>
            ) : (
              <><Share2 className="w-4 h-4" /> Share to Nostr</>
            )}
          </button>

          {/* Event ID */}
          <div className="card w-full max-w-sm mt-3">
            <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">Event ID</p>
            <div className="flex items-center gap-2">
              <code className="text-xs text-gray-300 truncate flex-1 font-mono">
                {createdEventId}
              </code>
              <button onClick={copyEventId} className="p-1.5 hover:bg-surface-700 rounded-lg">
                {copied ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5 text-gray-500" />}
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col p-4 md:p-6 pb-24">
      <button onClick={onBack} className="btn-back mb-4">
        <ArrowLeft className="w-4 h-4" />
        Back to Unlocks
      </button>

      <h2 className="text-lg font-bold mb-4">Create Social Unlock</h2>

      <div className="space-y-4 flex-1 overflow-y-auto">
        {/* Title */}
        <div>
          <label className="text-xs text-gray-400 mb-1 block">Title</label>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="What's behind the lock?"
            className="input-field"
          />
        </div>

        {/* Description */}
        <div>
          <label className="text-xs text-gray-400 mb-1 block">Description (public teaser)</label>
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Optional teaser text..."
            className="input-field"
          />
        </div>

        {/* Content type selector */}
        <div>
          <label className="text-xs text-gray-400 mb-1 block">Content Type</label>
          <div className="grid grid-cols-3 gap-2">
            {(['text', 'image', 'link'] as ContentType[]).map((type) => (
              <button
                key={type}
                onClick={() => setContentType(type)}
                className={`px-3 py-2 rounded-xl text-xs font-medium transition-colors ${
                  contentType === type
                    ? 'bg-white/10 text-white border border-white/20'
                    : 'bg-white/5 text-gray-400 border border-transparent hover:border-white/10'
                }`}
              >
                {type.charAt(0).toUpperCase() + type.slice(1)}
              </button>
            ))}
          </div>
        </div>

        {/* Secret content */}
        <div>
          <label className="text-xs text-gray-400 mb-1 flex items-center justify-between">
            <span>Secret Content ({contentType === 'image' ? 'Image URL' : contentType === 'link' ? 'URL' : 'Text'})</span>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              className="text-[10px] text-nostr hover:underline flex items-center gap-1"
            >
              {uploading ? <Loader2 className="w-2.5 h-2.5 animate-spin" /> : <ImageIcon className="w-2.5 h-2.5" />}
              Upload Image
            </button>
          </label>
          {contentType === 'text' ? (
            <textarea
              value={secretContent}
              onChange={(e) => setSecretContent(e.target.value)}
              placeholder="The content to reveal once threshold is met..."
              className="input-field min-h-[100px] resize-y"
              rows={4}
            />
          ) : (
            <input
              type="url"
              value={secretContent}
              onChange={(e) => setSecretContent(e.target.value)}
              placeholder={contentType === 'image' ? 'https://example.com/image.png' : 'https://example.com'}
              className="input-field"
            />
          )}
          <input ref={fileInputRef} type="file" accept="image/*" onChange={handleImageUpload} className="hidden" />
          {uploadedImageUrl && (
            <div className="relative w-16 h-16 rounded-lg overflow-hidden bg-surface-700 mt-2">
              <img src={uploadedImageUrl} alt="" className="w-full h-full object-cover" />
              <button
                type="button"
                onClick={() => {
                  setUploadedImageUrl('');
                  if (contentType === 'image') setSecretContent('');
                }}
                className="absolute top-0 right-0 w-4 h-4 bg-red-500 rounded-full flex items-center justify-center"
              >
                <X className="w-2 h-2 text-white" />
              </button>
            </div>
          )}
        </div>

        {/* Threshold & Slots */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-gray-400 mb-1 block">
              Threshold ({threshold})
            </label>
            <input
              type="range"
              min={1}
              max={totalSlots}
              value={threshold}
              onChange={(e) => setThreshold(Number(e.target.value))}
              className="w-full accent-white"
            />
          </div>
          <div>
            <label className="text-xs text-gray-400 mb-1 block">Total Slots</label>
            <input
              type="number"
              min={threshold}
              max={100}
              value={totalSlots}
              onChange={(e) => setTotalSlots(Math.max(threshold, Number(e.target.value)))}
              className="input-field"
            />
          </div>
        </div>

        <p className="text-[10px] text-gray-600">
          {threshold} of {totalSlots} signatures required to unlock
        </p>

        {/* Hashtags for discoverability */}
        <div>
          <label className="text-xs text-gray-400 mb-1 block">Hashtags (for discovery in The Wild)</label>
          <div className="flex flex-wrap gap-1.5 mb-2">
            {hashtags.map((tag) => (
              <span key={tag} className="inline-flex items-center gap-1 px-2 py-1 bg-purple-500/15 rounded-full text-[11px] text-purple-300">
                #{tag}
                {tag !== 'social-unlock' && (
                  <button type="button" onClick={() => setHashtags(hashtags.filter((t) => t !== tag))} className="w-3 h-3 flex items-center justify-center hover:text-white">
                    <X className="w-2.5 h-2.5" />
                  </button>
                )}
              </span>
            ))}
          </div>
          <div className="flex gap-2">
            <input
              value={tagInput}
              onChange={(e) => setTagInput(e.target.value.replace(/[^a-zA-Z0-9-]/g, ''))}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && tagInput.trim()) {
                  e.preventDefault();
                  const tag = tagInput.trim().toLowerCase();
                  if (!hashtags.includes(tag)) setHashtags([...hashtags, tag]);
                  setTagInput('');
                }
              }}
              placeholder="Add a tag..."
              className="input-field text-sm flex-1"
            />
            <button
              type="button"
              onClick={() => {
                if (tagInput.trim()) {
                  const tag = tagInput.trim().toLowerCase();
                  if (!hashtags.includes(tag)) setHashtags([...hashtags, tag]);
                  setTagInput('');
                }
              }}
              className="px-3 py-2 rounded-xl bg-white/5 text-xs text-gray-400 hover:text-white"
            >
              Add
            </button>
          </div>
        </div>

        {/* Who can sign? */}
        <div>
          <label className="text-xs text-gray-400 mb-1 block">Who can sign?</label>
          <div className="grid grid-cols-3 gap-2 mb-2">
            {([
              { value: 'anyone' as SignerMode, label: 'Anyone' },
              { value: 'followers' as SignerMode, label: 'My Followers' },
              { value: 'selected' as SignerMode, label: 'Selected Users' },
            ]).map(({ value, label }) => (
              <button
                key={value}
                onClick={() => setSignerMode(value)}
                className={`px-3 py-2 rounded-xl text-xs font-medium transition-colors ${
                  signerMode === value
                    ? 'bg-white/10 text-white border border-white/20'
                    : 'bg-white/5 text-gray-400 border border-transparent hover:border-white/10'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {signerMode === 'followers' && (
            <p className="text-[10px] text-gray-600">
              Only your {following.size} follower{following.size !== 1 ? 's' : ''} will be able to sign
            </p>
          )}

          {signerMode === 'selected' && (
            <div>
              {/* Selected signer chips */}
              {selectedSigners.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mb-2">
                  {selectedSigners.map((pk) => (
                    <span
                      key={pk}
                      className="inline-flex items-center gap-1 px-2 py-1 bg-surface-600 rounded-full text-xs text-white"
                    >
                      <span className="font-mono text-[10px]">{truncateNpub(pk)}</span>
                      <button
                        type="button"
                        onClick={() => removeSigner(pk)}
                        className="w-3.5 h-3.5 flex items-center justify-center hover:bg-surface-500 rounded-full"
                      >
                        <X className="w-2.5 h-2.5" />
                      </button>
                    </span>
                  ))}
                </div>
              )}

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

                {showDropdown && searchResults.length > 0 && (
                  <div
                    ref={dropdownRef}
                    className="absolute z-50 w-full mt-1 bg-surface-700 border border-surface-200/10 rounded-xl shadow-xl max-h-60 overflow-y-auto"
                  >
                    {searchResults.map((result) => (
                      <button
                        key={result.pubkey}
                        type="button"
                        onClick={() => addSigner(result.pubkey)}
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
          )}
        </div>
      </div>

      {/* Create button */}
      <button
        onClick={handleCreate}
        disabled={!title.trim() || !secretContent.trim() || publishing}
        className="btn-primary w-full flex items-center justify-center gap-2 mt-4"
      >
        {publishing ? (
          <span className="animate-pulse">Publishing...</span>
        ) : (
          <>
            <Lock className="w-4 h-4" />
            Create Social Unlock
          </>
        )}
      </button>
    </div>
  );
}

// ─── Detail View ────────────────────────────────────────────────

interface DetailViewProps {
  item: UnlockItem;
  publicKey: string;
  confirmAndSign: (event: { kind: number; content: string; tags: string[][]; created_at: number }) => Promise<SignedEvent>;
  storedKey?: string;
  onBack: () => void;
  onKeyStored: (eventId: string, key: string) => void;
}

function DetailView({ item, publicKey, confirmAndSign, storedKey, onBack, onKeyStored }: DetailViewProps) {
  const [revealing, setRevealing] = useState(false);
  const [revealedContent, setRevealedContent] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [copiedLink, setCopiedLink] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [shared, setShared] = useState(false);
  const isOwner = item.pubkey === publicKey;
  const hasSigned = item.signatures.some((s) => s.pubkey === publicKey);
  const isUnlocked = item.signatures.length >= item.content.threshold;
  const canSign = !isOwner && !hasSigned && (!item.content.allowed_pubkeys || item.content.allowed_pubkeys.includes(publicKey));
  const canReveal = isOwner && isUnlocked && !item.revealed && storedKey;
  const unlockUrl = `${UNLOCK_BASE_URL}/${item.eventId}`;

  useEffect(() => {
    if (item.revealed) {
      decryptContent(item.content.encrypted_content, item.revealed.decryption_key)
        .then(setRevealedContent)
        .catch(() => setRevealedContent('[Failed to decrypt]'));
    } else if (isOwner && storedKey && isUnlocked) {
      decryptContent(item.content.encrypted_content, storedKey)
        .then(setRevealedContent)
        .catch(() => setRevealedContent('[Failed to decrypt]'));
    }
  }, [item, storedKey]);

  async function handleReveal() {
    if (!storedKey) return;
    setRevealing(true);
    try {
      const event = createRevealEvent({
        unlock_event_id: item.eventId,
        decryption_key: storedKey,
        myPubkey: publicKey,
      });
      const signed = await confirmAndSign(event);
      await publishEvent(signed);
      item.revealed = { decryption_key: storedKey, revealed_at: Math.floor(Date.now() / 1000) };
    } catch (err) {
      console.error('Failed to reveal:', err);
    } finally {
      setRevealing(false);
    }
  }

  async function copyEventId() {
    await navigator.clipboard.writeText(item.eventId);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  async function copyLink() {
    await navigator.clipboard.writeText(unlockUrl);
    setCopiedLink(true);
    setTimeout(() => setCopiedLink(false), 2000);
  }

  async function shareToNostr() {
    setSharing(true);
    try {
      const noteContent = [
        `\u{1F513} I've locked content behind ${item.content.threshold} signatures! Help unlock it:`,
        unlockUrl,
        '',
        `${item.content.title}${item.content.description ? ` - ${item.content.description}` : ''}`,
      ].join('\n');

      const noteEvent = {
        kind: 1,
        content: noteContent,
        tags: [['t', 'social-unlock'], ['e', item.eventId]],
        created_at: Math.floor(Date.now() / 1000),
      };

      const signed = await confirmAndSign(noteEvent);
      await publishEvent(signed);
      setShared(true);
    } catch (err) {
      console.error('Failed to share:', err);
    } finally {
      setSharing(false);
    }
  }

  const progress = item.signatures.length / item.content.threshold;

  function renderRevealedContent() {
    if (!revealedContent) return null;

    const imageUrlMatch = revealedContent.match(/(https?:\/\/\S+\.(?:png|jpg|jpeg|gif|webp))/i);

    return (
      <div className="card mb-4 border-green-500/20 animate-[scale-in_0.3s_ease-out]">
        <div className="flex items-center gap-2 mb-2">
          <Unlock className="w-4 h-4 text-green-400" />
          <span className="text-xs font-medium text-green-400">Content Revealed</span>
        </div>
        {item.content.content_type === 'image' || imageUrlMatch ? (
          <>
            <img
              src={item.content.content_type === 'image' ? revealedContent : imageUrlMatch![1]}
              alt="Revealed"
              className="w-full rounded-lg max-h-60 object-contain bg-black mb-2"
            />
            {item.content.content_type !== 'image' && imageUrlMatch && (
              <p className="text-sm text-gray-200 whitespace-pre-wrap">
                {revealedContent.replace(imageUrlMatch[1], '').trim()}
              </p>
            )}
          </>
        ) : item.content.content_type === 'link' ? (
          <a
            href={revealedContent}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 text-sm text-blue-400 hover:text-blue-300"
          >
            <ExternalLink className="w-4 h-4" />
            {revealedContent}
          </a>
        ) : (
          <p className="text-sm text-gray-200 whitespace-pre-wrap">{revealedContent}</p>
        )}
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col p-4 md:p-6 pb-24">
      <button onClick={onBack} className="btn-back mb-4">
        <ArrowLeft className="w-4 h-4" />
        Back to Unlocks
      </button>

      {/* Header */}
      <div className="mb-4">
        <div className="flex items-center gap-2 mb-1">
          <h2 className="text-lg font-bold">{item.content.title}</h2>
          <StatusBadge isUnlocked={isUnlocked} progress={progress} />
        </div>
        {item.content.description && (
          <p className="text-xs text-gray-400">{item.content.description}</p>
        )}
      </div>

      {/* Progress */}
      <div className="card mb-4">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs text-gray-400">Progress</span>
          <span className="text-xs font-medium">
            {item.signatures.length} / {item.content.threshold} signatures
          </span>
        </div>
        <div className="h-2 bg-white/5 rounded-full overflow-hidden">
          <div
            className="h-full rounded-full transition-all duration-700"
            style={{
              width: `${Math.min(progress * 100, 100)}%`,
              background: isUnlocked
                ? 'linear-gradient(90deg, #22c55e, #4ade80)'
                : `linear-gradient(90deg, #6b7280, ${progress > 0.5 ? '#eab308' : '#9ca3af'})`,
            }}
          />
        </div>
        <p className="text-[10px] text-gray-600 mt-1">
          {item.content.total_slots} total slots &bull; {item.content.content_type} content
        </p>
      </div>

      {/* Eligible signers */}
      {item.content.allowed_pubkeys && item.content.allowed_pubkeys.length > 0 && (
        <div className="card mb-4">
          <p className="text-xs text-gray-400 mb-2">Eligible Signers ({item.content.allowed_pubkeys.length})</p>
          <div className="flex flex-wrap gap-1">
            {item.content.allowed_pubkeys.slice(0, 10).map((pk) => (
              <span key={pk} className="px-2 py-0.5 bg-white/5 rounded-full text-[10px] font-mono text-gray-400">
                {pubkeyToNpub(pk).slice(0, 12)}...
              </span>
            ))}
            {item.content.allowed_pubkeys.length > 10 && (
              <span className="px-2 py-0.5 bg-white/5 rounded-full text-[10px] text-gray-500">
                +{item.content.allowed_pubkeys.length - 10} more
              </span>
            )}
          </div>
        </div>
      )}

      {/* Creator */}
      <div className="card mb-4">
        <p className="text-xs text-gray-400 mb-2">Creator</p>
        <SignerBadge pubkey={item.pubkey} />
      </div>

      {/* Signers list with profile pics */}
      {item.signatures.length > 0 && (
        <div className="card mb-4">
          <p className="text-xs text-gray-400 mb-2">Signers ({item.signatures.length})</p>
          <div className="space-y-2">
            {item.signatures.map((sig, i) => (
              <div key={i} className="flex items-center gap-2">
                <Check className="w-3.5 h-3.5 text-green-400 flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <SignerBadge pubkey={sig.pubkey} />
                </div>
                {sig.message && <span className="text-[10px] text-gray-500 truncate">&mdash; {sig.message}</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Revealed content */}
      {renderRevealedContent()}

      {/* Share link */}
      <div className="card mb-4">
        <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">Share Link</p>
        <div className="flex items-center gap-2 mb-2">
          <code className="text-[10px] text-gray-300 truncate flex-1 font-mono">
            {unlockUrl}
          </code>
          <button onClick={copyLink} className="p-1.5 hover:bg-surface-700 rounded-lg">
            {copiedLink ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3 text-gray-500" />}
          </button>
        </div>
        <div className="flex items-center gap-2">
          <code className="text-[10px] text-gray-500 truncate flex-1 font-mono">
            {item.eventId}
          </code>
          <button onClick={copyEventId} className="p-1.5 hover:bg-surface-700 rounded-lg">
            {copied ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3 text-gray-500" />}
          </button>
        </div>
      </div>

      {/* Actions */}
      <div className="mt-auto space-y-2">
        {isOwner && (
          <button
            onClick={shareToNostr}
            disabled={sharing || shared}
            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium border border-nostr/30 text-nostr hover:bg-nostr/10 transition-colors disabled:opacity-50"
          >
            {shared ? (
              <><Check className="w-4 h-4" /> Shared to Nostr</>
            ) : sharing ? (
              <span className="animate-pulse">Sharing...</span>
            ) : (
              <><Share2 className="w-4 h-4" /> Share to Nostr</>
            )}
          </button>
        )}
        {canSign && (
          <a
            href={`/unlock/${item.eventId}`}
            target="_blank"
            rel="noopener noreferrer"
            className="btn-primary w-full flex items-center justify-center gap-2"
          >
            <ExternalLink className="w-4 h-4" />
            Open Unlock Page
          </a>
        )}
        {canReveal && (
          <button
            onClick={handleReveal}
            disabled={revealing}
            className="btn-primary w-full flex items-center justify-center gap-2"
          >
            {revealing ? (
              <span className="animate-pulse">Publishing reveal...</span>
            ) : (
              <>
                <Unlock className="w-4 h-4" />
                Publish Reveal
              </>
            )}
          </button>
        )}
      </div>
    </div>
  );
}

// ─── The Wild (Discovery) ────────────────────────────────────────

interface WildViewProps {
  publicKey: string;
  onBack: () => void;
  onSelectUnlock: (item: UnlockItem) => void;
}

function WildView({ publicKey, onBack, onSelectUnlock }: WildViewProps) {
  const [wildUnlocks, setWildUnlocks] = useState<UnlockItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTag, setSearchTag] = useState('');
  const [activeTag, setActiveTag] = useState('');
  const [profiles, setProfiles] = useState<Record<string, { displayName?: string; picture?: string }>>({});

  const popularTags = ['social-unlock', 'bitcoin', 'nostr', 'art', 'music', 'alpha', 'giveaway'];

  useEffect(() => {
    fetchWild();
  }, [activeTag]);

  async function fetchWild() {
    setLoading(true);
    try {
      const relayList = await loadRelayList();
      const readRelays = getReadRelays(relayList);
      const items = await fetchWildUnlocks(readRelays, activeTag || undefined);
      setWildUnlocks(items);

      for (const item of items.slice(0, 20)) {
        const profile = await getCachedProfile(item.pubkey);
        if (profile) {
          setProfiles((prev) => ({ ...prev, [item.pubkey]: profile }));
        }
      }
    } catch (err) {
      console.error('Failed to fetch wild unlocks:', err);
    } finally {
      setLoading(false);
    }
  }

  function handleTagSearch(e: React.FormEvent) {
    e.preventDefault();
    setActiveTag(searchTag.trim().toLowerCase().replace(/^#/, ''));
  }

  return (
    <div className="h-full flex flex-col p-4 md:p-6 pb-24">
      <div className="flex items-center gap-3 mb-4">
        <button onClick={onBack} className="btn-back">
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div>
          <h1 className="text-lg font-bold">The Wild</h1>
          <p className="text-xs text-gray-500">Discover social unlocks from the community</p>
        </div>
      </div>

      {/* Search by hashtag */}
      <form onSubmit={handleTagSearch} className="mb-3">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
          <input
            value={searchTag}
            onChange={(e) => setSearchTag(e.target.value)}
            placeholder="Search by hashtag..."
            className="input-field pl-9 text-sm"
          />
        </div>
      </form>

      {/* Popular tags */}
      <div className="flex gap-2 flex-wrap mb-4">
        <button
          onClick={() => setActiveTag('')}
          className={`px-2.5 py-1 rounded-full text-[10px] font-medium transition-colors ${
            !activeTag ? 'bg-white/15 text-white' : 'bg-white/5 text-gray-400 hover:text-white'
          }`}
        >
          All
        </button>
        {popularTags.map((tag) => (
          <button
            key={tag}
            onClick={() => setActiveTag(tag)}
            className={`px-2.5 py-1 rounded-full text-[10px] font-medium transition-colors ${
              activeTag === tag ? 'bg-purple-500/20 text-purple-300' : 'bg-white/5 text-gray-400 hover:text-white'
            }`}
          >
            #{tag}
          </button>
        ))}
      </div>

      {/* Results */}
      {loading ? (
        <div className="flex-1 flex items-center justify-center">
          <Loader2 className="w-5 h-5 animate-spin text-gray-500" />
        </div>
      ) : wildUnlocks.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center text-center px-6">
          <Search className="w-10 h-10 text-gray-700 mb-3" />
          <p className="text-sm text-gray-400">No unlocks found</p>
          <p className="text-xs text-gray-600 mt-1">
            {activeTag ? `No unlocks tagged #${activeTag}` : 'No public unlocks discovered yet'}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 overflow-y-auto flex-1">
          {wildUnlocks.map((item) => {
            const profile = profiles[item.pubkey];
            const progress = item.signatures.length / item.content.threshold;
            const isUnlocked = item.signatures.length >= item.content.threshold;

            return (
              <button
                key={item.eventId}
                onClick={() => onSelectUnlock(item)}
                className="card text-left hover:border-white/20 transition-all"
              >
                {/* Creator header */}
                <div className="flex items-center gap-2 mb-2">
                  {profile?.picture ? (
                    <img src={safeImageUrl(profile.picture)} alt="" className="w-7 h-7 rounded-full object-cover" />
                  ) : (
                    <div className="w-7 h-7 rounded-full bg-white/10" />
                  )}
                  <span className="text-xs text-gray-400 truncate">
                    {profile?.displayName || pubkeyToNpub(item.pubkey).slice(0, 14) + '...'}
                  </span>
                </div>

                {/* Title */}
                <h3 className="text-sm font-semibold mb-1 line-clamp-2">{item.content.title}</h3>
                {item.content.description && (
                  <p className="text-[11px] text-gray-500 line-clamp-2 mb-2">{item.content.description}</p>
                )}

                {/* Progress bar */}
                <div className="h-1.5 bg-white/5 rounded-full overflow-hidden mb-2">
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: `${Math.min(progress * 100, 100)}%`,
                      background: isUnlocked ? '#22c55e' : '#6b7280',
                    }}
                  />
                </div>

                {/* Footer */}
                <div className="flex items-center justify-between">
                  <span className="text-[10px] text-gray-500">
                    <Users className="w-3 h-3 inline mr-1" />
                    {item.signatures.length}/{item.content.threshold}
                  </span>
                  <StatusBadge isUnlocked={isUnlocked} progress={progress} />
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Wild Relay Fetching ─────────────────────────────────────────

async function fetchWildUnlocks(relayUrls: string[], hashtag?: string): Promise<UnlockItem[]> {
  return new Promise((resolve) => {
    const unlockMap = new Map<string, UnlockItem>();
    const sigMap = new Map<string, { pubkey: string; message?: string }[]>();
    let eoseCount = 0;
    const connections: WebSocket[] = [];
    let resolved = false;

    function finalize() {
      if (resolved) return;
      resolved = true;
      for (const ws of connections) { try { ws.close(); } catch {} }
      for (const [eventId, item] of unlockMap) {
        item.signatures = sigMap.get(eventId) ?? [];
      }
      resolve(Array.from(unlockMap.values()).sort((a, b) => b.createdAt - a.createdAt));
    }

    const timeout = setTimeout(finalize, 12000);
    const relays = relayUrls.slice(0, 4);

    for (const url of relays) {
      let ws: WebSocket;
      try { ws = new WebSocket(url); } catch { eoseCount++; continue; }
      connections.push(ws);
      const subId = `wild_${Math.random().toString(36).slice(2, 8)}`;

      ws.onopen = () => {
        const filter: any = {
          kinds: [CUSTOM_KIND.SOCIAL_UNLOCK],
          limit: 100,
        };
        if (hashtag) filter['#t'] = [hashtag];

        ws.send(JSON.stringify(['REQ', subId, filter]));
        ws.send(JSON.stringify(['REQ', `${subId}_signs`, {
          kinds: [CUSTOM_KIND.SOCIAL_UNLOCK_SIGN],
          limit: 500,
        }]));
      };

      ws.onmessage = (msg) => {
        try {
          const data = JSON.parse(msg.data);
          if (data[0] === 'EVENT') {
            const event = data[2];
            if (event.kind === CUSTOM_KIND.SOCIAL_UNLOCK) {
              const content = parseSocialUnlockContent(event.content);
              if (content && !unlockMap.has(event.id)) {
                unlockMap.set(event.id, {
                  eventId: event.id,
                  pubkey: event.pubkey,
                  content,
                  signatures: [],
                  createdAt: event.created_at,
                });
              }
            } else if (event.kind === CUSTOM_KIND.SOCIAL_UNLOCK_SIGN) {
              const signContent = parseSocialUnlockSignContent(event.content);
              if (signContent) {
                const existing = sigMap.get(signContent.unlock_event_id) ?? [];
                if (!existing.some((s) => s.pubkey === event.pubkey)) {
                  existing.push({ pubkey: event.pubkey, message: signContent.message });
                  sigMap.set(signContent.unlock_event_id, existing);
                }
              }
            }
          } else if (data[0] === 'EOSE') {
            eoseCount++;
            if (eoseCount >= relays.length * 2) { clearTimeout(timeout); finalize(); }
          }
        } catch {}
      };

      ws.onerror = () => {
        eoseCount += 2;
        if (eoseCount >= relays.length * 2) { clearTimeout(timeout); finalize(); }
      };
    }

    if (relays.length === 0) { clearTimeout(timeout); resolve([]); }
  });
}

// ─── Signer Badge ───────────────────────────────────────────────

function SignerBadge({ pubkey }: { pubkey: string }) {
  return <ProfileBadge pubkey={pubkey} size="sm" showNip05={true} />;
}

// ─── Relay Fetching ─────────────────────────────────────────────

async function fetchSocialUnlocks(relayUrls: string[], userPubkey: string): Promise<UnlockItem[]> {
  return new Promise((resolve) => {
    const unlockMap = new Map<string, UnlockItem>();
    const sigMap = new Map<string, { pubkey: string; message?: string }[]>();
    const revealMap = new Map<string, { decryption_key: string; revealed_at: number }>();
    let eoseCount = 0;
    const connections: WebSocket[] = [];
    let resolved = false;

    function finalize() {
      if (resolved) return;
      resolved = true;

      for (const ws of connections) {
        try { ws.close(); } catch {}
      }

      for (const [eventId, item] of unlockMap) {
        item.signatures = sigMap.get(eventId) ?? [];
        const reveal = revealMap.get(eventId);
        if (reveal) item.revealed = reveal;
      }

      const items = Array.from(unlockMap.values()).sort((a, b) => b.createdAt - a.createdAt);
      resolve(items);
    }

    const timeout = setTimeout(finalize, 15000);

    for (const url of relayUrls.slice(0, 4)) {
      let ws: WebSocket;
      try {
        ws = new WebSocket(url);
      } catch {
        eoseCount++;
        continue;
      }
      connections.push(ws);

      const subId = `sunlock_${Math.random().toString(36).slice(2, 8)}`;

      ws.onopen = () => {
        ws.send(JSON.stringify(['REQ', subId, {
          kinds: [CUSTOM_KIND.SOCIAL_UNLOCK],
          authors: [userPubkey],
          limit: 50,
        }]));

        ws.send(JSON.stringify(['REQ', `${subId}_signs`, {
          kinds: [CUSTOM_KIND.SOCIAL_UNLOCK_SIGN],
          '#p': [userPubkey],
          limit: 200,
        }]));

        ws.send(JSON.stringify(['REQ', `${subId}_reveals`, {
          kinds: [CUSTOM_KIND.SOCIAL_UNLOCK_REVEAL],
          authors: [userPubkey],
          limit: 50,
        }]));

        ws.send(JSON.stringify(['REQ', `${subId}_tagged`, {
          kinds: [CUSTOM_KIND.SOCIAL_UNLOCK],
          '#t': ['social-unlock'],
          limit: 100,
        }]));
      };

      ws.onmessage = (msg) => {
        try {
          const data = JSON.parse(msg.data);
          if (data[0] === 'EVENT') {
            const event = data[2];

            if (event.kind === CUSTOM_KIND.SOCIAL_UNLOCK) {
              const content = parseSocialUnlockContent(event.content);
              if (content && !unlockMap.has(event.id)) {
                const isOwner = event.pubkey === userPubkey;
                const isAllowed = !content.allowed_pubkeys || content.allowed_pubkeys.includes(userPubkey);
                if (isOwner || isAllowed) {
                  unlockMap.set(event.id, {
                    eventId: event.id,
                    pubkey: event.pubkey,
                    content,
                    signatures: [],
                    createdAt: event.created_at,
                  });
                }
              }
            } else if (event.kind === CUSTOM_KIND.SOCIAL_UNLOCK_SIGN) {
              const signContent = parseSocialUnlockSignContent(event.content);
              if (signContent) {
                const existing = sigMap.get(signContent.unlock_event_id) ?? [];
                if (!existing.some((s) => s.pubkey === event.pubkey)) {
                  existing.push({ pubkey: event.pubkey, message: signContent.message });
                  sigMap.set(signContent.unlock_event_id, existing);
                }
              }
            } else if (event.kind === CUSTOM_KIND.SOCIAL_UNLOCK_REVEAL) {
              const revealContent = parseSocialUnlockRevealContent(event.content);
              if (revealContent) {
                revealMap.set(revealContent.unlock_event_id, {
                  decryption_key: revealContent.decryption_key,
                  revealed_at: revealContent.revealed_at,
                });
              }
            }
          } else if (data[0] === 'EOSE') {
            eoseCount++;
            if (eoseCount >= relayUrls.slice(0, 4).length * 4) {
              clearTimeout(timeout);
              finalize();
            }
          }
        } catch {}
      };

      ws.onerror = () => {
        eoseCount += 4;
        if (eoseCount >= relayUrls.slice(0, 4).length * 4) {
          clearTimeout(timeout);
          finalize();
        }
      };
    }

    if (relayUrls.length === 0) {
      clearTimeout(timeout);
      resolve([]);
    }
  });
}
