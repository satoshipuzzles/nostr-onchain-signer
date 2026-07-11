import { useState, useEffect, useRef } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { ArrowLeft, Send, MessageCircle, Bitcoin, Loader2, Search, X } from 'lucide-react';
import { getCachedProfile, resolveProfiles, searchProfilesNip50 } from '@/lib/nostr/cache';
import type { ProfileMetadata } from '@/lib/nostr/social';
import { safeImageUrl } from '@/lib/utils';
import { ClickableAvatar } from '@/popup/components/ClickableAvatar';
import { sendDM, decryptDM, unwrapGiftWrapEvent } from '@/lib/nostr/dm';
import { ensureOwnDmRelayList, fetchDmInboxRelays, DEFAULT_DM_RELAYS } from '@/lib/nostr/dm-relays';
import { celebratePublish } from '@/lib/ui/publish-feedback';
import { toast } from 'sonner';
import { getReadRelays, loadRelayList } from '@/lib/nostr/relays';
import { FALLBACK_WRITE_RELAYS } from '@/lib/nostr/publish';
import { parseInvoiceDmPayload, buildSendPathFromInvoice, type InvoiceDmPayload } from '@/lib/nostr/invoice-dm';
import { SkeletonConversationList } from '@/popup/components/Skeleton';

interface Conversation {
  pubkey: string;
  lastMessage: string;
  lastTimestamp: number;
  unread: boolean;
}

interface DM {
  id: string;
  pubkey: string;
  content: string;
  created_at: number;
  isMine: boolean;
  kind: number;
  invoice?: InvoiceDmPayload | null;
}

async function getReadRelayUrls(publicKey?: string | null): Promise<string[]> {
  const relayList = await loadRelayList();
  const configured = getReadRelays(relayList);
  // Include our DM inbox relays (kind 10050) — gift wraps land there
  let dmInbox: string[] = [];
  if (publicKey) {
    try { dmInbox = await fetchDmInboxRelays(publicKey); } catch {}
  }
  return [...new Set([...dmInbox, ...DEFAULT_DM_RELAYS, ...configured, ...FALLBACK_WRITE_RELAYS])].slice(0, 10);
}

function openRelay(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => { ws.close(); reject(new Error('timeout')); }, 5000);
    ws.onopen = () => { clearTimeout(timer); resolve(ws); };
    ws.onerror = () => { clearTimeout(timer); reject(new Error('connection failed')); };
  });
}

function timeAgo(timestamp: number): string {
  const diff = Math.floor(Date.now() / 1000) - timestamp;
  if (diff < 60) return 'now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d`;
  return new Date(timestamp * 1000).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

const URL_REGEX = /(https?:\/\/[^\s<>"']+)/g;

/** Render message text with clickable links. Same-origin links open in-app. */
function LinkifiedText({ text }: { text: string }) {
  const parts = text.split(URL_REGEX);
  return (
    <>
      {parts.map((part, i) => {
        if (URL_REGEX.test(part)) {
          URL_REGEX.lastIndex = 0;
          const isInternal = typeof window !== 'undefined' && part.startsWith(window.location.origin);
          return (
            <a
              key={i}
              href={part}
              target={isInternal ? '_self' : '_blank'}
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="underline decoration-purple-300/60 underline-offset-2 break-all hover:decoration-purple-300 font-medium"
            >
              {part}
            </a>
          );
        }
        URL_REGEX.lastIndex = 0;
        return <span key={i}>{part}</span>;
      })}
    </>
  );
}

export function Messages() {
  const { publicKey } = useAuth();
  const [searchParams] = useSearchParams();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selectedPubkey, setSelectedPubkey] = useState<string | null>(() => {
    const to = searchParams.get('to');
    return to && to.length === 64 ? to : null;
  });
  const [messages, setMessages] = useState<DM[]>([]);
  const [newMessage, setNewMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [profiles, setProfiles] = useState<Record<string, any>>({});
  const [loading, setLoading] = useState(true);
  const [decrypting, setDecrypting] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<ProfileMetadata[]>([]);
  const [searching, setSearching] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Generation counter: ignore results from a thread load that finished
  // after the user already switched to a different conversation
  const threadLoadGenRef = useRef(0);

  // Keep the selected thread in sync with the ?to= param so navigating to
  // /messages?to=<pubkey> works even when Messages is already mounted
  useEffect(() => {
    const to = searchParams.get('to');
    if (to && to.length === 64 && to !== selectedPubkey) {
      setSelectedPubkey(to);
    }
  }, [searchParams]);

  // Debounced people search (same NIP-50 search as Discover)
  useEffect(() => {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    if (!searchQuery.trim()) {
      setSearchResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    searchTimerRef.current = setTimeout(async () => {
      try {
        const results = await searchProfilesNip50(searchQuery.trim(), 12);
        setSearchResults(results);
      } catch {
        setSearchResults([]);
      } finally {
        setSearching(false);
      }
    }, 400);
    return () => { if (searchTimerRef.current) clearTimeout(searchTimerRef.current); };
  }, [searchQuery]);

  useEffect(() => {
    if (publicKey) {
      loadConversations();
      // Publish our kind 10050 DM relay list so Amethyst/0xchat users
      // know where to send us gift-wrapped DMs
      ensureOwnDmRelayList(publicKey).catch(() => {});
    }
  }, [publicKey]);

  useEffect(() => {
    if (selectedPubkey && publicKey) {
      loadMessages(selectedPubkey);
      // Ensure the thread header has a profile even for brand-new conversations
      if (!profiles[selectedPubkey]) {
        getReadRelayUrls(publicKey).then((relays) =>
          resolveProfiles([selectedPubkey], relays.slice(0, 3)),
        ).then((resolved) => {
          const p = resolved.get(selectedPubkey);
          if (p) setProfiles((prev) => ({ ...prev, [selectedPubkey]: p }));
        }).catch(() => {});
      }
    }
  }, [selectedPubkey]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  async function loadConversations() {
    try {
      const cached = await chrome.storage.local.get([`dm_conversations_${publicKey}`, `messages_${publicKey}`]);
      const cachedConvs: Conversation[] = cached[`dm_conversations_${publicKey}`] ?? cached[`messages_${publicKey}`] ?? [];
      if (Array.isArray(cachedConvs) && cachedConvs.length > 0) {
        setConversations(cachedConvs);
        setLoading(false);
        // Load cached profiles in parallel and apply in one state update
        Promise.all(
          cachedConvs.slice(0, 20).map(async (conv) => ({
            pubkey: conv.pubkey,
            profile: await getCachedProfile(conv.pubkey),
          })),
        ).then((entries) => {
          setProfiles((prev) => {
            const next = { ...prev };
            for (const { pubkey, profile } of entries) {
              if (profile) next[pubkey] = profile;
            }
            return next;
          });
        }).catch(() => {});
      } else {
        setLoading(true);
      }

      const convMap = new Map<string, Conversation>();
      // Track the raw last event per NIP-04 conversation so we can decrypt a preview
      const previewSource = new Map<string, { content: string; kind: number; peer: string }>();
      const readRelays = await getReadRelayUrls(publicKey);
      const giftWrapPromises: Promise<void>[] = [];

      // Query all relays in parallel (was sequential — up to 40s total)
      await Promise.allSettled(readRelays.map(async (relayUrl) => {
        const ws = await openRelay(relayUrl);
        const subId = `dms_${Date.now()}_${relayUrl.slice(-6)}`;

        await new Promise<void>((resolve) => {
          const timeout = setTimeout(() => { ws.close(); resolve(); }, 5000);

          ws.onmessage = (ev: MessageEvent) => {
            try {
              const msg = JSON.parse(ev.data);
              if (msg[0] === 'EVENT' && msg[1] === subId) {
                const event = msg[2];

                if (event.kind === 1059) {
                  giftWrapPromises.push(unwrapGiftWrapEvent(event).then((unwrapped) => {
                    if (!unwrapped) return;
                    const { senderPubkey: sender, createdAt, content, rumor } = unwrapped;
                    const otherPubkey = sender === publicKey
                      ? rumor.tags?.find((t: string[]) => t[0] === 'p' && t[1] !== publicKey)?.[1]
                      : sender;
                    if (!otherPubkey) return;
                    const existing = convMap.get(otherPubkey);
                    // Use the rumor's REAL timestamp (wrap timestamps are randomized)
                    if (!existing || createdAt > existing.lastTimestamp) {
                      convMap.set(otherPubkey, {
                        pubkey: otherPubkey,
                        lastMessage: content.slice(0, 80),
                        lastTimestamp: createdAt,
                        unread: sender !== publicKey,
                      });
                    }
                  }).catch(() => {}));
                  return;
                }

                const otherPubkey = event.pubkey === publicKey
                  ? event.tags.find((t: string[]) => t[0] === 'p')?.[1]
                  : event.pubkey;
                if (!otherPubkey) return;

                const existing = convMap.get(otherPubkey);
                if (!existing || event.created_at > existing.lastTimestamp) {
                  convMap.set(otherPubkey, {
                    pubkey: otherPubkey,
                    lastMessage: '(encrypted)',
                    lastTimestamp: event.created_at,
                    unread: event.pubkey !== publicKey,
                  });
                  previewSource.set(otherPubkey, {
                    content: event.content,
                    kind: event.kind,
                    peer: otherPubkey,
                  });
                }
              }
              if (msg[0] === 'EOSE') { clearTimeout(timeout); ws.close(); resolve(); }
            } catch {}
          };

          ws.send(JSON.stringify(['REQ', subId,
            { kinds: [4, 14, 1059], authors: [publicKey!], limit: 50 },
            { kinds: [4, 14, 1059], '#p': [publicKey!], limit: 50 },
          ]));
        });
      }));

      // Wait for pending gift-wrap sender resolutions
      await Promise.allSettled(giftWrapPromises);

      // Decrypt last-message previews for NIP-04 conversations (gift wraps
      // already have plaintext previews from the unwrap above)
      await Promise.allSettled(
        Array.from(convMap.entries()).slice(0, 30).map(async ([pk, conv]) => {
          if (conv.lastMessage !== '(encrypted)') return;
          const src = previewSource.get(pk);
          if (!src) return;
          try {
            const plain = await decryptDM(src.peer, src.content, src.kind);
            if (plain && !plain.startsWith('(unable')) {
              conv.lastMessage = plain.slice(0, 80);
            }
          } catch { /* keep placeholder */ }
        }),
      );

      const sorted = Array.from(convMap.values()).sort((a, b) => b.lastTimestamp - a.lastTimestamp);
      if (sorted.length > 0) setConversations(sorted);
      chrome.storage.local.set({
        [`dm_conversations_${publicKey}`]: sorted,
        [`messages_${publicKey}`]: sorted,
      }).catch(() => {});

      // Batch-resolve ALL conversation profiles (same mechanism as Discover):
      // cache hits are instant, misses are fetched from relays in one query
      const pubkeys = sorted.map((c) => c.pubkey);
      if (pubkeys.length > 0) {
        const readRelayUrls = await getReadRelayUrls(publicKey);
        resolveProfiles(pubkeys, readRelayUrls.slice(0, 3)).then((resolved) => {
          setProfiles((prev) => {
            const next = { ...prev };
            resolved.forEach((p, pk) => { next[pk] = p; });
            return next;
          });
        }).catch(() => {});
      }
    } catch (err) {
      console.error('Failed to load conversations:', err);
    } finally {
      setLoading(false);
    }
  }

  async function loadMessages(peerPubkey: string) {
    const gen = ++threadLoadGenRef.current;
    const isStale = () => threadLoadGenRef.current !== gen;
    setMessages([]);
    setDecrypting(true);

    // Show cached decrypted thread instantly while fresh data loads
    const threadCacheKey = `dm_thread_${publicKey}_${peerPubkey}`;
    try {
      const cached = await chrome.storage.local.get(threadCacheKey);
      const cachedMsgs = cached[threadCacheKey];
      if (Array.isArray(cachedMsgs) && cachedMsgs.length > 0 && !isStale()) {
        setMessages(cachedMsgs);
        setDecrypting(false);
      }
    } catch {}

    try {
      const readRelays = await getReadRelayUrls(publicKey);
      const dms: DM[] = [];
      const seen = new Set<string>();

      // All relays in parallel (was sequential — up to 40s)
      await Promise.allSettled(readRelays.slice(0, 6).map(async (relayUrl) => {
        const ws = await openRelay(relayUrl);
        const subId = `dm_thread_${Date.now()}_${relayUrl.slice(-6)}`;

        await new Promise<void>((resolve) => {
          const timeout = setTimeout(() => { ws.close(); resolve(); }, 6000);

          ws.onmessage = (ev: MessageEvent) => {
            try {
              const msg = JSON.parse(ev.data);
              if (msg[0] === 'EVENT' && msg[1] === subId) {
                const event = msg[2];
                if (!seen.has(event.id)) {
                  seen.add(event.id);
                  dms.push({
                    id: event.id,
                    pubkey: event.pubkey,
                    content: event.content,
                    created_at: event.created_at,
                    isMine: event.pubkey === publicKey,
                    kind: event.kind,
                  });
                }
              }
              if (msg[0] === 'EOSE') { clearTimeout(timeout); ws.close(); resolve(); }
            } catch {}
          };

          ws.send(JSON.stringify(['REQ', subId,
            { kinds: [4, 14], authors: [publicKey!], '#p': [peerPubkey], limit: 100 },
            { kinds: [4, 14], authors: [peerPubkey], '#p': [publicKey!], limit: 100 },
            { kinds: [1059], '#p': [publicKey!], limit: 100 },
          ]));
        });
      }));

      const sorted = dms.sort((a, b) => a.created_at - b.created_at);

      // Decrypt all messages in parallel — local key makes each fast
      const results = await Promise.allSettled(sorted.map(async (dm): Promise<DM | null> => {
        try {
          if (dm.kind === 1059) {
            const unwrapped = await unwrapGiftWrapEvent({
              pubkey: dm.pubkey,
              content: dm.content,
              kind: 1059,
            });
            if (!unwrapped) return null;
            const { senderPubkey: sender, content, createdAt, rumor } = unwrapped;
            const isMine = sender === publicKey;
            // Thread filter: incoming must be FROM peer; outgoing must be TO peer
            if (isMine) {
              const to = rumor.tags?.find((t: string[]) => t[0] === 'p')?.[1];
              if (to !== peerPubkey) return null;
            } else if (sender !== peerPubkey) {
              return null;
            }
            dm.content = content;
            dm.isMine = isMine;
            dm.pubkey = sender;
            dm.created_at = createdAt; // real timestamp from the rumor
          } else {
            const other = dm.isMine ? peerPubkey : dm.pubkey;
            dm.content = await decryptDM(other, dm.content, dm.kind);
          }
          dm.invoice = parseInvoiceDmPayload(dm.content);
          return dm;
        } catch {
          if (dm.content.includes('?iv=') || (dm.content.length > 200 && !/\s/.test(dm.content))) {
            dm.content = '(unable to decrypt)';
          }
          return dm;
        }
      }));

      const decrypted = results
        .filter((r): r is PromiseFulfilledResult<DM | null> => r.status === 'fulfilled')
        .map((r) => r.value)
        .filter((d): d is DM => d !== null)
        .sort((a, b) => a.created_at - b.created_at);

      if (decrypted.length > 0) {
        // Cache the decrypted thread (last 50) for instant display next time
        chrome.storage.local.set({ [threadCacheKey]: decrypted.slice(-50) }).catch(() => {});
        if (!isStale()) setMessages(decrypted);
      }
    } catch (err) {
      console.error('Failed to load messages:', err);
    } finally {
      if (!isStale()) setDecrypting(false);
    }
  }

  async function handleSend() {
    if (!newMessage.trim() || !selectedPubkey || !publicKey) return;
    setSending(true);
    try {
      const result = await sendDM(publicKey, selectedPubkey, newMessage);
      celebratePublish('Sent');
      setMessages(prev => [...prev, {
        id: result.eventId || `local_${Date.now()}`,
        pubkey: publicKey,
        content: newMessage,
        created_at: Math.floor(Date.now() / 1000),
        isMine: true,
        kind: result.kind,
      }]);
      setNewMessage('');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to send DM';
      toast.error(msg);
    } finally {
      setSending(false);
    }
  }

  // ─── Thread View ─────────────────────────────────────────────

  if (selectedPubkey) {
    const profile = profiles[selectedPubkey];
    const displayName = profile?.displayName || profile?.name || selectedPubkey.slice(0, 12) + '...';

    return (
      <div className="fixed inset-0 z-40 bg-black flex flex-col">
        {/* Header */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-white/10 bg-black/80 backdrop-blur-sm">
          <button onClick={() => setSelectedPubkey(null)} className="p-2 -ml-1 hover:bg-white/10 rounded-lg">
            <ArrowLeft className="w-5 h-5" />
          </button>
          <ClickableAvatar
            pubkey={selectedPubkey}
            picture={profile?.picture}
            name={displayName}
            size="md"
          />
          <div className="min-w-0">
            <p className="font-medium text-sm truncate">{displayName}</p>
            {profile?.nip05 && (
              <p className="text-[10px] text-gray-500 truncate">{profile.nip05}</p>
            )}
          </div>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-2">
          {decrypting && messages.length === 0 && (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-5 h-5 animate-spin text-gray-500 mr-2" />
              <p className="text-gray-500 text-sm">Decrypting messages...</p>
            </div>
          )}
          {!decrypting && messages.length === 0 && (
            <p className="text-center text-gray-600 text-sm py-12">No messages yet. Say hello!</p>
          )}
          {messages.map((dm) => (
            <div key={dm.id} className={`flex ${dm.isMine ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[80%] px-3.5 py-2.5 rounded-2xl text-[13px] leading-relaxed select-text ${
                dm.isMine
                  ? 'bg-gradient-to-br from-purple-600 to-purple-700 text-white rounded-br-md'
                  : 'bg-white/[0.08] text-white rounded-bl-md'
              }`}>
                <p className="break-words whitespace-pre-wrap select-text cursor-text">
                  <LinkifiedText text={dm.content} />
                </p>
                {dm.invoice && (
                  <Link
                    to={buildSendPathFromInvoice(dm.invoice)}
                    className="mt-2 inline-flex items-center gap-1.5 px-3 py-2 bg-bitcoin/90 text-white rounded-lg text-xs font-semibold hover:bg-bitcoin transition-colors"
                  >
                    <Bitcoin className="w-3.5 h-3.5" />
                    Pay {dm.invoice.amount_sats ? `${dm.invoice.amount_sats.toLocaleString()} sats` : 'Invoice'}
                  </Link>
                )}
                <p className={`text-[10px] mt-1.5 ${dm.isMine ? 'text-white/50' : 'text-gray-500'}`}>
                  {new Date(dm.created_at * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </p>
              </div>
            </div>
          ))}
          <div ref={messagesEndRef} />
        </div>

        {/* Input */}
        <div className="border-t border-white/10 px-4 py-3 bg-black/80 backdrop-blur-sm"
          style={{ paddingBottom: 'calc(0.75rem + env(safe-area-inset-bottom, 0px))' }}
        >
          <div className="flex items-end gap-2">
            <textarea
              value={newMessage}
              onChange={(e) => setNewMessage(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
              }}
              placeholder="Message..."
              rows={1}
              className="flex-1 bg-white/5 border border-white/10 rounded-2xl px-4 py-2.5 text-sm outline-none focus:border-purple-500/50 resize-none min-h-[44px] max-h-[120px]"
              style={{ fieldSizing: 'content' } as any}
            />
            <button
              onClick={handleSend}
              disabled={!newMessage.trim() || sending}
              className="p-2.5 bg-purple-600 text-white rounded-full disabled:opacity-30 hover:bg-purple-500 transition-colors min-h-[44px] min-w-[44px] flex items-center justify-center flex-shrink-0"
            >
              {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ─── Conversation List ───────────────────────────────────────

  return (
    <div>
      <div className="px-4 py-4 border-b border-white/10">
        <h1 className="text-xl font-bold">Messages</h1>
        <p className="text-xs text-gray-500 mt-0.5">End-to-end encrypted (NIP-17)</p>

        {/* People search — start a DM with anyone */}
        <div className="relative mt-3">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search people to message..."
            className="w-full pl-9 pr-9 py-2.5 bg-white/5 border border-white/10 rounded-xl text-sm outline-none focus:border-purple-500/50"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-white"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>

      {/* Search results */}
      {searchQuery && (
        <div className="border-b border-white/10">
          {searching && (
            <div className="flex items-center gap-2 px-4 py-3 text-gray-500 text-xs">
              <Loader2 className="w-3.5 h-3.5 animate-spin" /> Searching...
            </div>
          )}
          {!searching && searchResults.length === 0 && (
            <p className="px-4 py-3 text-gray-600 text-xs">No users found</p>
          )}
          {searchResults.map((p) => (
            <button
              key={p.pubkey}
              onClick={() => { setSearchQuery(''); setSelectedPubkey(p.pubkey); }}
              className="w-full flex items-center gap-3 px-4 py-3 hover:bg-white/[0.03] transition-colors text-left"
            >
              {p.picture ? (
                <img src={safeImageUrl(p.picture)} alt="" className="w-10 h-10 rounded-full object-cover bg-surface-700 flex-shrink-0" />
              ) : (
                <div className="w-10 h-10 rounded-full bg-gradient-to-br from-purple-600/40 to-blue-600/40 flex items-center justify-center flex-shrink-0 text-sm font-bold text-white/80">
                  {(p.displayName || p.name || p.pubkey).charAt(0).toUpperCase()}
                </div>
              )}
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium truncate">{p.displayName || p.name || p.pubkey.slice(0, 12) + '...'}</p>
                {p.nip05 && <p className="text-[10px] text-gray-500 truncate">{p.nip05}</p>}
              </div>
              <MessageCircle className="w-4 h-4 text-purple-400 flex-shrink-0" />
            </button>
          ))}
        </div>
      )}

      <div>
        {loading && conversations.length === 0 && <SkeletonConversationList count={6} />}

        {!loading && conversations.length === 0 && (
          <div className="flex flex-col items-center justify-center py-16 px-4">
            <div className="w-16 h-16 rounded-full bg-white/5 flex items-center justify-center mb-4">
              <MessageCircle className="w-8 h-8 text-gray-600" />
            </div>
            <p className="text-gray-400 text-sm font-medium">No conversations yet</p>
            <p className="text-gray-600 text-xs text-center mt-1">Messages from signing requests, invoices, and DMs will appear here</p>
          </div>
        )}

        {conversations.map((conv) => {
          const profile = profiles[conv.pubkey];
          const displayName = profile?.displayName || profile?.name || conv.pubkey.slice(0, 12) + '...';

          return (
            <button
              key={conv.pubkey}
              onClick={() => setSelectedPubkey(conv.pubkey)}
              className="w-full flex items-center gap-3 px-4 py-3.5 hover:bg-white/[0.03] active:bg-white/[0.06] transition-colors border-b border-white/5 text-left"
            >
              {/* Avatar */}
              <div className="flex-shrink-0 relative">
                <ClickableAvatar
                  pubkey={conv.pubkey}
                  picture={profile?.picture}
                  name={displayName}
                  size="lg"
                />
                {conv.unread && (
                  <div className="absolute -top-0.5 -right-0.5 w-3 h-3 rounded-full bg-purple-500 border-2 border-black" />
                )}
              </div>

              {/* Content */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-2">
                  <p className={`text-sm truncate ${conv.unread ? 'font-semibold text-white' : 'font-medium text-gray-200'}`}>
                    {displayName}
                  </p>
                  <span className="text-[10px] text-gray-600 flex-shrink-0">
                    {timeAgo(conv.lastTimestamp)}
                  </span>
                </div>
                <p className={`text-xs truncate mt-0.5 ${conv.unread ? 'text-gray-300' : 'text-gray-500'}`}>
                  {conv.lastMessage}
                </p>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
