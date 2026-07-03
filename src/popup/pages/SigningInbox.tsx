import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  subscribeSigningInbox,
  markRequestStatus,
  type SigningRequest,
} from '@/lib/nostr/signing-inbox';
import { CUSTOM_KIND, parseOnchainInvoice, type OnchainInvoiceContent } from '@/lib/nostr/kinds';
import { loadRelayList, getReadRelays } from '@/lib/nostr/relays';
import { getCachedProfile } from '@/lib/nostr/cache';
import { type ProfileMetadata } from '@/lib/nostr/social';
import { encryptDM } from '@/lib/nostr/dm';
import { loadSigningRounds, type SigningRound } from '@/lib/bitcoin/signing-round';
import { checkInvoiceStatus, type InvoiceStatus } from '@/lib/bitcoin/invoice-tracker';
import { formatSats } from '@/lib/bitcoin/mempool';

import { createMessageId } from '@/shared/messages';
import { InvoiceCreator } from '@/popup/components/InvoiceCreator';
import {
  ArrowLeft, Inbox, Loader2, Check, X, Clock,
  Shield, AlertTriangle, Copy, Link, FileText,
  Send, QrCode, Download, ExternalLink, CheckCircle2,
  Plus, ChevronDown, ChevronUp, RefreshCw, Image, Bell,
} from 'lucide-react';

const VERCEL_URL = 'https://nostr-onchain-signer.vercel.app';

function signingUrl(roundId: string): string {
  return `${VERCEL_URL}/sign/${roundId}`;
}

function parseRoundMeta(psbtHex: string): { amount?: number; recipient?: string } {
  try {
    const parsed = JSON.parse(psbtHex);
    if (parsed.intent === 'send') {
      return { amount: parsed.amount, recipient: parsed.to };
    }
  } catch { /* not JSON, likely a real PSBT */ }
  return {};
}

interface Props {
  publicKey: string;
  onBack: () => void;
}

function formatTimeAgo(timestamp: number): string {
  const now = Math.floor(Date.now() / 1000);
  const diff = now - timestamp;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(timestamp * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function StatusBadge({ status }: { status: SigningRequest['status'] }) {
  switch (status) {
    case 'pending':
      return (
        <span className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-bitcoin/15 text-bitcoin border border-bitcoin/20">
          <Clock className="w-2.5 h-2.5" />
          Pending
        </span>
      );
    case 'signed':
      return (
        <span className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-green-500/15 text-green-400 border border-green-500/20">
          <Check className="w-2.5 h-2.5" />
          Signed
        </span>
      );
    case 'declined':
      return (
        <span className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-red-500/15 text-red-400 border border-red-500/20">
          <X className="w-2.5 h-2.5" />
          Declined
        </span>
      );
    case 'expired':
      return (
        <span className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-gray-500/15 text-gray-400 border border-gray-500/20">
          <AlertTriangle className="w-2.5 h-2.5" />
          Expired
        </span>
      );
  }
}

// ─── Invoice types ─────────────────────────────────────────────

interface InvoiceItem {
  eventId: string;
  pubkey: string;
  createdAt: number;
  direction: 'sent' | 'received';
  invoice: OnchainInvoiceContent;
}

interface CachedInvoice {
  eventId: string;
  address: string;
  amountSats?: number;
  memo?: string;
  expiresAt?: number;
  createdAt: number;
  recipientPubkey: string;
  creatorPubkey: string;
  status?: InvoiceStatus;
  lastChecked?: number;
}

function invoiceStorageKey(pubkey: string): string {
  return `my_invoices_${pubkey}`;
}

async function loadCachedInvoices(pubkey: string): Promise<CachedInvoice[]> {
  try {
    const result = await chrome.storage.local.get(invoiceStorageKey(pubkey));
    return result[invoiceStorageKey(pubkey)] || [];
  } catch {
    return [];
  }
}

async function saveCachedInvoices(pubkey: string, invoices: CachedInvoice[]): Promise<void> {
  try {
    await chrome.storage.local.set({ [invoiceStorageKey(pubkey)]: invoices });
  } catch { /* ignore */ }
}

function InvoiceStatusBadge({ status }: { status?: InvoiceStatus }) {
  switch (status) {
    case 'paid':
      return (
        <span className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-green-500/15 text-green-400 border border-green-500/20">
          <Check className="w-2.5 h-2.5" />
          Paid
        </span>
      );
    case 'partially_paid':
      return (
        <span className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-orange-500/15 text-orange-400 border border-orange-500/20">
          <Clock className="w-2.5 h-2.5" />
          Partial
        </span>
      );
    case 'expired':
      return (
        <span className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-red-500/15 text-red-400 border border-red-500/20">
          <X className="w-2.5 h-2.5" />
          Expired
        </span>
      );
    default:
      return (
        <span className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-bitcoin/15 text-bitcoin border border-bitcoin/20">
          <Clock className="w-2.5 h-2.5" />
          Pending
        </span>
      );
  }
}

// ─── 9801 response subscription ────────────────────────────────

function subscribeSigningResponses(
  relayUrls: string[],
  userPubkey: string,
  onResponse: (roundId: string, responderPubkey: string, psbtHex?: string) => void
): () => void {
  const connections: { ws: WebSocket; subId: string }[] = [];
  const seenIds = new Set<string>();

  for (const url of relayUrls) {
    const subId = `resp_${Math.random().toString(36).slice(2, 10)}`;
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      continue;
    }
    connections.push({ ws, subId });

    ws.onopen = () => {
      ws.send(JSON.stringify(['REQ', subId, {
        kinds: [CUSTOM_KIND.SIGNING_RESPONSE],
        '#p': [userPubkey],
        limit: 50,
      }]));
    };

    ws.onmessage = (msg) => {
      try {
        const data = JSON.parse(msg.data);
        if (data[0] === 'EVENT' && data[1] === subId) {
          const event = data[2];
          if (seenIds.has(event.id)) return;
          seenIds.add(event.id);
          try {
            const content = JSON.parse(event.content);
            if (content.round_id && content.accepted) {
              onResponse(content.round_id, event.pubkey, content.psbt_hex);
            }
          } catch { /* ignore malformed */ }
        }
      } catch { /* ignore */ }
    };
  }

  return () => {
    for (const conn of connections) {
      try {
        if (conn.ws.readyState === WebSocket.OPEN) {
          conn.ws.send(JSON.stringify(['CLOSE', conn.subId]));
        }
        conn.ws.close();
      } catch { /* ignore */ }
    }
    connections.length = 0;
  };
}

// ─── Invoice subscription ──────────────────────────────────────

function subscribeInvoices(
  relayUrls: string[],
  userPubkey: string,
  onInvoice: (item: InvoiceItem) => void,
  onEose?: () => void
): () => void {
  const connections: { ws: WebSocket; subId: string }[] = [];
  const seenIds = new Set<string>();
  let eoseCount = 0;
  let eoseFired = false;

  for (const url of relayUrls) {
    const subId = `inv_${Math.random().toString(36).slice(2, 10)}`;
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      continue;
    }
    connections.push({ ws, subId });

    ws.onopen = () => {
      ws.send(JSON.stringify(['REQ', subId, {
        kinds: [CUSTOM_KIND.ONCHAIN_INVOICE],
        '#p': [userPubkey],
        limit: 50,
      }]));
      ws.send(JSON.stringify(['REQ', `${subId}_out`, {
        kinds: [CUSTOM_KIND.ONCHAIN_INVOICE],
        authors: [userPubkey],
        limit: 50,
      }]));
    };

    ws.onmessage = (msg) => {
      try {
        const data = JSON.parse(msg.data);
        if (data[0] === 'EVENT' && (data[1] === subId || data[1] === `${subId}_out`)) {
          const event = data[2];
          if (seenIds.has(event.id)) return;
          seenIds.add(event.id);
          const parsed = parseOnchainInvoice(event.content);
          if (parsed) {
            onInvoice({
              eventId: event.id,
              pubkey: event.pubkey,
              createdAt: event.created_at,
              direction: event.pubkey === userPubkey ? 'sent' : 'received',
              invoice: parsed,
            });
          }
        } else if (data[0] === 'EOSE') {
          eoseCount++;
          if (!eoseFired && eoseCount >= Math.min(relayUrls.length, 2)) {
            eoseFired = true;
            onEose?.();
          }
        }
      } catch { /* ignore */ }
    };
  }

  return () => {
    for (const conn of connections) {
      try {
        if (conn.ws.readyState === WebSocket.OPEN) {
          conn.ws.send(JSON.stringify(['CLOSE', conn.subId]));
          conn.ws.send(JSON.stringify(['CLOSE', `${conn.subId}_out`]));
        }
        conn.ws.close();
      } catch { /* ignore */ }
    }
    connections.length = 0;
  };
}

// ─── useSigningCount hook ──────────────────────────────────────

export function useSigningCount(publicKey: string): number {
  const [count, setCount] = useState(0);

  useEffect(() => {
    if (!publicKey) return;

    let cleanup: (() => void) | null = null;
    let pending = 0;

    (async () => {
      const relayList = await loadRelayList();
      const relays = getReadRelays(relayList);
      const relayUrls = relays.length > 0
        ? relays
        : ['wss://relay.damus.io', 'wss://nos.lol'];

      cleanup = subscribeSigningInbox(
        relayUrls,
        publicKey,
        (req) => {
          if (req.status === 'pending') {
            pending++;
            setCount(pending);
          }
        },
        () => {
          setCount(pending);
        }
      );
    })();

    return () => {
      if (cleanup) cleanup();
    };
  }, [publicKey]);

  return count;
}

// ─── Main Component ────────────────────────────────────────────

export function SigningInbox({ publicKey, onBack }: Props) {
  const navigate = useNavigate();
  const [requests, setRequests] = useState<SigningRequest[]>([]);
  const [rounds, setRounds] = useState<SigningRound[]>([]);
  const [roundResponses, setRoundResponses] = useState<Map<string, { pubkey: string; psbtHex?: string }[]>>(new Map());
  const [invoices, setInvoices] = useState<InvoiceItem[]>([]);
  const [profiles, setProfiles] = useState<Map<string, ProfileMetadata>>(new Map());
  const [loading, setLoading] = useState(true);
  const [invoicesLoading, setInvoicesLoading] = useState(true);
  const [selectedRequest, setSelectedRequest] = useState<SigningRequest | null>(null);
  const [activeTab, setActiveTab] = useState<'incoming' | 'outbound' | 'invoices'>('incoming');
  const [invoiceSubTab, setInvoiceSubTab] = useState<'all' | 'sent' | 'received'>('all');
  const [invoiceStatuses, setInvoiceStatuses] = useState<Map<string, { status: InvoiceStatus; confirmedSats: number; unconfirmedSats: number }>>(new Map());
  const [checkingStatuses, setCheckingStatuses] = useState(false);
  const [copied, setCopied] = useState('');
  const [showInvoiceCreator, setShowInvoiceCreator] = useState(false);
  const [expandedOutbound, setExpandedOutbound] = useState<string | null>(null);
  const [nudging, setNudging] = useState<string | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const responseCleanupRef = useRef<(() => void) | null>(null);
  const invoiceCleanupRef = useRef<(() => void) | null>(null);
  const requestsRef = useRef(requests);
  requestsRef.current = requests;

  useEffect(() => {
    loadInbox();
    loadOutbound();
    loadInvoices();
    return () => {
      cleanupRef.current?.();
      responseCleanupRef.current?.();
      invoiceCleanupRef.current?.();
    };
  }, [publicKey]);

  async function loadOutbound() {
    try {
      const allRounds = await loadSigningRounds();
      const sorted = allRounds.sort((a, b) => b.createdAt - a.createdAt);
      setRounds(sorted);
      for (const round of sorted) {
        for (const signer of round.signers) {
          const cached = await getCachedProfile(signer.pubkey);
          if (cached) {
            setProfiles((prev) => {
              const next = new Map(prev);
              next.set(signer.pubkey, cached);
              return next;
            });
          }
        }
      }
    } catch {}
  }

  async function loadInbox() {
    const relayList = await loadRelayList();
    const relays = getReadRelays(relayList);
    const relayUrls = relays.length > 0
      ? relays
      : ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.snort.social'];

    const collected: SigningRequest[] = [];

    cleanupRef.current = subscribeSigningInbox(
      relayUrls,
      publicKey,
      (req) => {
        collected.push(req);
        const sorted = [...collected].sort((a, b) => b.createdAt - a.createdAt);
        setRequests(sorted);
        resolveProfile(req.senderPubkey);
      },
      () => {
        setLoading(false);
      }
    );

    // Feature 3: subscribe to kind 9801 responses for live signed_count updates
    responseCleanupRef.current = subscribeSigningResponses(
      relayUrls,
      publicKey,
      (roundId, responderPubkey, psbtHex) => {
        setRequests((prev) =>
          prev.map((r) => {
            if (r.round_id === roundId) {
              return { ...r, signed_count: r.signed_count + 1 };
            }
            return r;
          })
        );
        setRoundResponses((prev) => {
          const next = new Map(prev);
          const existing = next.get(roundId) || [];
          if (!existing.some((r) => r.pubkey === responderPubkey)) {
            next.set(roundId, [...existing, { pubkey: responderPubkey, psbtHex }]);
          }
          return next;
        });
      }
    );

    setTimeout(() => setLoading(false), 15000);
  }

  async function loadInvoices() {
    const cached = await loadCachedInvoices(publicKey);
    const statusMap = new Map<string, { status: InvoiceStatus; confirmedSats: number; unconfirmedSats: number }>();
    for (const c of cached) {
      if (c.status) {
        statusMap.set(c.eventId, { status: c.status, confirmedSats: 0, unconfirmedSats: 0 });
      }
    }
    if (statusMap.size > 0) setInvoiceStatuses(statusMap);

    const relayList = await loadRelayList();
    const relays = getReadRelays(relayList);
    const relayUrls = relays.length > 0
      ? relays
      : ['wss://relay.damus.io', 'wss://nos.lol'];

    const collected: InvoiceItem[] = [];

    invoiceCleanupRef.current = subscribeInvoices(
      relayUrls,
      publicKey,
      (item) => {
        collected.push(item);
        const sorted = [...collected].sort((a, b) => b.createdAt - a.createdAt);
        setInvoices(sorted);
        resolveProfile(item.pubkey);
      },
      () => {
        setInvoicesLoading(false);
        cacheInvoiceItems(collected);
      }
    );

    setTimeout(() => setInvoicesLoading(false), 15000);
  }

  async function cacheInvoiceItems(items: InvoiceItem[]) {
    const cached: CachedInvoice[] = items.map((item) => {
      const pTag = item.direction === 'sent' ? '' : item.pubkey;
      return {
        eventId: item.eventId,
        address: item.invoice.address,
        amountSats: item.invoice.amount_sats,
        memo: item.invoice.memo,
        expiresAt: item.invoice.expires_at,
        createdAt: item.createdAt,
        recipientPubkey: pTag,
        creatorPubkey: item.pubkey,
        status: invoiceStatuses.get(item.eventId)?.status,
        lastChecked: invoiceStatuses.get(item.eventId) ? Date.now() / 1000 : undefined,
      };
    });
    await saveCachedInvoices(publicKey, cached);
  }

  async function batchCheckStatuses() {
    if (checkingStatuses || invoices.length === 0) return;
    setCheckingStatuses(true);

    const newStatuses = new Map(invoiceStatuses);

    for (let i = 0; i < invoices.length; i++) {
      const inv = invoices[i];
      try {
        const result = await checkInvoiceStatus(
          inv.invoice.address,
          inv.invoice.amount_sats,
          inv.invoice.expires_at,
        );
        newStatuses.set(inv.eventId, {
          status: result.status,
          confirmedSats: result.confirmedSats,
          unconfirmedSats: result.unconfirmedSats,
        });
        setInvoiceStatuses(new Map(newStatuses));
      } catch { /* skip this one */ }

      if (i < invoices.length - 1) {
        await new Promise((r) => setTimeout(r, 500));
      }
    }

    setCheckingStatuses(false);

    const cachedItems: CachedInvoice[] = invoices.map((item) => ({
      eventId: item.eventId,
      address: item.invoice.address,
      amountSats: item.invoice.amount_sats,
      memo: item.invoice.memo,
      expiresAt: item.invoice.expires_at,
      createdAt: item.createdAt,
      recipientPubkey: item.direction === 'sent' ? '' : item.pubkey,
      creatorPubkey: item.pubkey,
      status: newStatuses.get(item.eventId)?.status,
      lastChecked: Math.floor(Date.now() / 1000),
    }));
    await saveCachedInvoices(publicKey, cachedItems);
  }

  async function checkSingleInvoiceStatus(inv: InvoiceItem) {
    try {
      const result = await checkInvoiceStatus(
        inv.invoice.address,
        inv.invoice.amount_sats,
        inv.invoice.expires_at,
      );
      setInvoiceStatuses((prev) => {
        const next = new Map(prev);
        next.set(inv.eventId, {
          status: result.status,
          confirmedSats: result.confirmedSats,
          unconfirmedSats: result.unconfirmedSats,
        });
        return next;
      });
    } catch { /* ignore */ }
  }

  const resolveProfile = useCallback(async (pubkey: string) => {
    if (profiles.has(pubkey)) return;
    const cached = await getCachedProfile(pubkey);
    if (cached) {
      setProfiles((prev) => {
        const next = new Map(prev);
        next.set(pubkey, cached);
        return next;
      });
    }
  }, [profiles]);

  async function handleAccept(request: SigningRequest) {
    setSelectedRequest(request);
  }

  async function handleDecline(request: SigningRequest) {
    await markRequestStatus(request.eventId, 'declined');
    setRequests((prev) =>
      prev.map((r) => r.eventId === request.eventId ? { ...r, status: 'declined' as const } : r)
    );
  }

  function copyToClipboard(text: string, label: string) {
    navigator.clipboard.writeText(text);
    setCopied(label);
    setTimeout(() => setCopied(''), 2000);
  }

  async function handleNudge(round: SigningRound, signerPubkey: string) {
    setNudging(signerPubkey);
    try {
      const link = signingUrl(round.id);
      const dmContent = `Reminder: You have a pending signing request. View and sign: ${link}`;

      let content = dmContent;
      let kind = 4;
      try {
        const result = await encryptDM(signerPubkey, dmContent);
        content = result.content;
        kind = result.kind;
      } catch {
        console.warn('DM encryption failed for nudge');
      }

      const dmEvent = {
        kind,
        content,
        tags: [['p', signerPubkey]],
        created_at: Math.floor(Date.now() / 1000),
        pubkey: publicKey,
      };

      const response = await chrome.runtime.sendMessage({
        type: 'nip07:signEvent',
        payload: { event: dmEvent },
        id: createMessageId(),
      });

      if (!response.error && response.result) {
        const { publishEvent } = await import('@/lib/nostr/discovery');
        await publishEvent(response.result);
      }
    } catch (err) {
      console.error('Nudge failed:', err);
    } finally {
      setNudging(null);
    }
  }

  const pendingCount = requests.filter((r) => r.status === 'pending').length;

  if (showInvoiceCreator) {
    return (
      <InvoiceCreator
        publicKey={publicKey}
        onClose={() => setShowInvoiceCreator(false)}
        onCreated={() => {
          setShowInvoiceCreator(false);
          loadInvoices();
        }}
      />
    );
  }

  if (selectedRequest) {
    return (
      <RequestDetail
        request={selectedRequest}
        profile={profiles.get(selectedRequest.senderPubkey)}
        publicKey={publicKey}
        onBack={() => setSelectedRequest(null)}
        onSigned={() => {
          setRequests((prev) =>
            prev.map((r) => r.eventId === selectedRequest.eventId ? { ...r, status: 'signed' as const } : r)
          );
          setSelectedRequest(null);
        }}
      />
    );
  }

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="page-header px-4">
        <button onClick={onBack} className="btn-back">
          <ArrowLeft className="w-5 h-5" />
        </button>
        <h1>Signing</h1>
        {pendingCount > 0 && (
          <span className="px-2 py-0.5 rounded-full text-[11px] font-bold bg-bitcoin text-black">
            {pendingCount}
          </span>
        )}
      </div>

      {/* Tabs */}
      <div className="flex gap-1 px-4 pb-3">
        <button
          onClick={() => setActiveTab('incoming')}
          className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium transition-colors ${
            activeTab === 'incoming'
              ? 'bg-white/10 text-white'
              : 'text-gray-500 hover:text-gray-300'
          }`}
        >
          <Inbox className="w-3.5 h-3.5" />
          Incoming {pendingCount > 0 && <span className="text-[9px] bg-bitcoin text-black px-1 rounded-full">{pendingCount}</span>}
        </button>
        <button
          onClick={() => setActiveTab('outbound')}
          className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium transition-colors ${
            activeTab === 'outbound'
              ? 'bg-white/10 text-white'
              : 'text-gray-500 hover:text-gray-300'
          }`}
        >
          <Send className="w-3.5 h-3.5" />
          Sent {rounds.length > 0 && <span className="text-[9px] bg-nostr/80 text-white px-1 rounded-full">{rounds.length}</span>}
        </button>
        <button
          onClick={() => setActiveTab('invoices')}
          className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium transition-colors ${
            activeTab === 'invoices'
              ? 'bg-white/10 text-white'
              : 'text-gray-500 hover:text-gray-300'
          }`}
        >
          <FileText className="w-3.5 h-3.5" />
          Invoices {invoices.length > 0 && <span className="text-[9px] bg-nostr/80 text-white px-1 rounded-full">{invoices.length}</span>}
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-4 pb-24">
        {activeTab === 'incoming' && (
          <>
            {loading && (
              <div className="flex flex-col items-center justify-center py-12">
                <Loader2 className="w-8 h-8 text-nostr animate-spin mb-3" />
                <p className="text-sm text-gray-400">Checking for signing requests...</p>
              </div>
            )}

            {!loading && requests.length === 0 && (
              <div className="flex flex-col items-center justify-center py-12">
                <Inbox className="w-12 h-12 text-gray-600 mb-3" />
                <p className="text-sm text-gray-400">No incoming requests</p>
                <p className="text-xs text-gray-600 mt-1">
                  Signature requests from co-signers appear here
                </p>
              </div>
            )}

            {requests.map((request) => {
              const profile = profiles.get(request.senderPubkey);
              const displayName = profile?.displayName || profile?.name || request.senderPubkey.slice(0, 12);
              const isReady = request.signed_count >= request.threshold;

              return (
                <div
                  key={request.eventId}
                  className="card mb-3 cursor-pointer hover:bg-surface-700/50 transition-colors"
                  onClick={() => handleAccept(request)}
                >
                  {/* Feature 5: threshold banner */}
                  {isReady && (
                    <div className="flex items-center gap-2 px-3 py-2 mb-3 rounded-lg bg-green-500/10 border border-green-500/20">
                      <CheckCircle2 className="w-4 h-4 text-green-400 flex-shrink-0" />
                      <span className="text-xs font-medium text-green-400">Ready to Broadcast</span>
                      <div className="ml-auto flex items-center gap-1.5">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            const blob = new Blob([request.psbt_hex], { type: 'application/octet-stream' });
                            const url = URL.createObjectURL(blob);
                            const a = document.createElement('a');
                            a.href = url;
                            a.download = `signing-round-${request.round_id.slice(0, 8)}.psbt`;
                            document.body.appendChild(a);
                            a.click();
                            document.body.removeChild(a);
                            URL.revokeObjectURL(url);
                          }}
                          className="p-1.5 rounded-lg bg-green-500/15 hover:bg-green-500/25 text-green-400 transition-colors min-w-[32px] min-h-[32px] flex items-center justify-center"
                          title="Download PSBT"
                        >
                          <Download className="w-3.5 h-3.5" />
                        </button>
                        <a
                          href="https://mempool.space/tx/push"
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          className="p-1.5 rounded-lg bg-green-500/15 hover:bg-green-500/25 text-green-400 transition-colors min-w-[32px] min-h-[32px] flex items-center justify-center"
                          title="Broadcast on mempool.space"
                        >
                          <ExternalLink className="w-3.5 h-3.5" />
                        </a>
                      </div>
                    </div>
                  )}

                  <div className="flex items-start gap-3">
                    {profile?.picture ? (
                      <img src={profile.picture} alt="" className="w-9 h-9 rounded-full object-cover bg-surface-700 flex-shrink-0" />
                    ) : (
                      <div className="w-9 h-9 rounded-full bg-gradient-to-br from-bitcoin/40 to-nostr/30 flex items-center justify-center flex-shrink-0">
                        <Shield className="w-4 h-4 text-white/70" />
                      </div>
                    )}

                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-sm font-medium text-white truncate">{displayName}</span>
                        <span className="text-[10px] text-gray-500 flex-shrink-0">
                          {formatTimeAgo(request.createdAt)}
                        </span>
                      </div>

                      {request.memo && (
                        <p className="text-xs text-gray-300 mb-1.5 line-clamp-2">{request.memo}</p>
                      )}

                      <div className="flex items-center gap-3 text-[10px] text-gray-500 mb-2">
                        <span className={isReady ? 'text-green-400 font-medium' : ''}>
                          {request.signed_count}/{request.threshold} signed
                        </span>
                        <span>{request.total_signers} signers</span>
                      </div>

                      <div className="flex items-center gap-2">
                        <StatusBadge status={request.status} />

                        {/* Feature 1: copy signing URL */}
                        <button
                          onClick={(e) => { e.stopPropagation(); copyToClipboard(
                            signingUrl(request.round_id),
                            request.eventId
                          ); }}
                          className="p-1 rounded hover:bg-surface-700 text-gray-500 hover:text-white transition-colors min-w-[28px] min-h-[28px] flex items-center justify-center"
                          title="Copy signing link"
                        >
                          {copied === request.eventId ? <Check className="w-3 h-3 text-green-400" /> : <Link className="w-3 h-3" />}
                        </button>

                        {request.status === 'pending' && (
                          <div className="flex items-center gap-1.5 ml-auto">
                            <button
                              onClick={(e) => { e.stopPropagation(); handleDecline(request); }}
                              className="px-2.5 py-1 rounded-lg text-[11px] font-medium bg-red-500/10 text-red-400 border border-red-500/20 hover:bg-red-500/20 transition-colors min-h-[28px]"
                            >
                              Decline
                            </button>
                            <button
                              onClick={(e) => { e.stopPropagation(); handleAccept(request); }}
                              className="px-2.5 py-1 rounded-lg text-[11px] font-medium bg-bitcoin/15 text-bitcoin border border-bitcoin/30 hover:bg-bitcoin/25 transition-colors min-h-[28px]"
                            >
                              Review
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </>
        )}

        {activeTab === 'outbound' && (
          <>
            {rounds.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12">
                <Send className="w-12 h-12 text-gray-600 mb-3" />
                <p className="text-sm text-gray-400">No outgoing signing rounds</p>
                <p className="text-xs text-gray-600 mt-1">
                  When you request signatures from co-signers, they appear here
                </p>
              </div>
            ) : (
              rounds.map((round) => {
                const isExpanded = expandedOutbound === round.id;
                const responses = roundResponses.get(round.id) || [];
                const meta = parseRoundMeta(round.psbtHex);

                const signerStatuses = round.signers.map((signer) => {
                  const resp = responses.find((r) => r.pubkey === signer.pubkey);
                  return {
                    ...signer,
                    status: resp ? ('signed' as const) : signer.status,
                    psbtHex: resp?.psbtHex,
                  };
                });

                const signedCount = signerStatuses.filter((s) => s.status === 'signed').length;
                const isReady = signedCount >= round.threshold;

                return (
                  <div key={round.id} className="card mb-3">
                    <div
                      className="flex items-center gap-3 cursor-pointer"
                      onClick={() => setExpandedOutbound(isExpanded ? null : round.id)}
                    >
                      <div className={`w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 ${
                        isReady ? 'bg-green-500/20' : 'bg-nostr/20'
                      }`}>
                        {isReady ? <CheckCircle2 className="w-4 h-4 text-green-400" /> : <Send className="w-4 h-4 text-nostr" />}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">{round.memo || 'Signature request'}</p>
                        <div className="flex items-center gap-2 text-[10px] text-gray-500">
                          {meta.amount && <span className="text-bitcoin font-medium">{formatSats(meta.amount)}</span>}
                          {meta.recipient && <span className="truncate max-w-[100px]">{meta.recipient.slice(0, 12)}...</span>}
                          <span>{formatTimeAgo(round.createdAt)}</span>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        <span className={`text-[10px] font-medium ${isReady ? 'text-green-400' : 'text-bitcoin'}`}>
                          {signedCount}/{round.threshold}
                        </span>
                        <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full ${
                          isReady ? 'bg-green-500/15 text-green-400' :
                          round.status === 'collecting' ? 'bg-bitcoin/15 text-bitcoin' :
                          round.status === 'broadcast' ? 'bg-green-500/15 text-green-400' :
                          'bg-gray-500/15 text-gray-400'
                        }`}>
                          {isReady ? 'Ready' : round.status}
                        </span>
                        {isExpanded ? <ChevronUp className="w-3.5 h-3.5 text-gray-500" /> : <ChevronDown className="w-3.5 h-3.5 text-gray-500" />}
                      </div>
                    </div>

                    {isExpanded && (
                      <div className="mt-3 pt-3 border-t border-white/5 space-y-3">
                        {/* Threshold progress bar */}
                        <div>
                          <div className="flex items-center justify-between mb-1">
                            <span className="text-[10px] text-gray-500 uppercase tracking-wider">Signatures</span>
                            <span className={`text-xs font-bold ${isReady ? 'text-green-400' : 'text-bitcoin'}`}>
                              {signedCount}/{round.threshold}
                            </span>
                          </div>
                          <div className="w-full h-1.5 bg-surface-700 rounded-full overflow-hidden">
                            <div
                              className={`h-full rounded-full transition-all ${isReady ? 'bg-green-400' : 'bg-bitcoin'}`}
                              style={{ width: `${Math.min((signedCount / round.threshold) * 100, 100)}%` }}
                            />
                          </div>
                        </div>

                        {/* Co-signer list */}
                        <div>
                          <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1.5">Co-signers</p>
                          <div className="space-y-1.5">
                            {signerStatuses.map((signer) => {
                              const profile = profiles.get(signer.pubkey);
                              const signerName = profile?.displayName || profile?.name || signer.displayName || signer.pubkey.slice(0, 12);
                              const isSigned = signer.status === 'signed';
                              const isMe = signer.pubkey === publicKey;

                              return (
                                <div key={signer.pubkey} className="flex items-center gap-2 py-1">
                                  {isSigned ? (
                                    <Check className="w-3.5 h-3.5 text-green-400 flex-shrink-0" />
                                  ) : (
                                    <Clock className="w-3.5 h-3.5 text-gray-500 flex-shrink-0" />
                                  )}
                                  <span className={`text-xs flex-1 truncate ${isSigned ? 'text-green-400' : 'text-gray-300'}`}>
                                    {signerName}{isMe ? ' (you)' : ''}
                                  </span>
                                  <span className={`text-[9px] px-1.5 py-0.5 rounded-full ${
                                    isSigned ? 'bg-green-500/15 text-green-400' : 'bg-gray-500/15 text-gray-400'
                                  }`}>
                                    {isSigned ? 'Signed' : 'Pending'}
                                  </span>
                                  {!isSigned && !isMe && (
                                    <button
                                      onClick={(e) => { e.stopPropagation(); handleNudge(round, signer.pubkey); }}
                                      disabled={nudging === signer.pubkey}
                                      className="flex items-center gap-1 px-2 py-1 rounded-lg text-[10px] font-medium bg-bitcoin/10 text-bitcoin hover:bg-bitcoin/20 transition-colors min-h-[24px]"
                                      title="Send DM reminder"
                                    >
                                      {nudging === signer.pubkey ? (
                                        <Loader2 className="w-3 h-3 animate-spin" />
                                      ) : (
                                        <Bell className="w-3 h-3" />
                                      )}
                                      Nudge
                                    </button>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        </div>

                        {/* Round details */}
                        <div className="grid grid-cols-2 gap-2">
                          {meta.recipient && (
                            <div>
                              <p className="text-[10px] text-gray-500 mb-0.5">Recipient</p>
                              <code className="text-[11px] text-gray-300 font-mono break-all">{meta.recipient}</code>
                            </div>
                          )}
                          <div>
                            <p className="text-[10px] text-gray-500 mb-0.5">Expires</p>
                            <p className="text-xs text-white">
                              {new Date(round.expiresAt * 1000).toLocaleDateString()}
                            </p>
                          </div>
                          <div>
                            <p className="text-[10px] text-gray-500 mb-0.5">Multisig</p>
                            <code className="text-[11px] text-gray-300 font-mono truncate block">
                              {round.multisigAddress.slice(0, 16)}...
                            </code>
                          </div>
                          <div>
                            <p className="text-[10px] text-gray-500 mb-0.5">Threshold</p>
                            <p className="text-xs text-white">{round.threshold} of {round.totalSigners}</p>
                          </div>
                        </div>

                        {/* Actions */}
                        <div className="flex items-center gap-2 pt-1">
                          <button
                            onClick={(e) => { e.stopPropagation(); copyToClipboard(signingUrl(round.id), `link_${round.id}`); }}
                            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-medium bg-surface-700 text-gray-300 hover:bg-surface-600 transition-colors min-h-[28px]"
                          >
                            {copied === `link_${round.id}` ? <Check className="w-3 h-3 text-green-400" /> : <Link className="w-3 h-3" />}
                            Copy Signing Link
                          </button>
                          <button
                            onClick={(e) => { e.stopPropagation(); copyToClipboard(round.psbtHex, `psbt_${round.id}`); }}
                            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-medium bg-surface-700 text-gray-300 hover:bg-surface-600 transition-colors min-h-[28px]"
                          >
                            {copied === `psbt_${round.id}` ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3" />}
                            Copy PSBT
                          </button>
                        </div>

                        {/* Combine & Broadcast section */}
                        {isReady && (
                          <div className="p-3 rounded-lg bg-green-500/5 border border-green-500/20">
                            <div className="flex items-center gap-2 mb-2">
                              <CheckCircle2 className="w-4 h-4 text-green-400" />
                              <span className="text-xs font-semibold text-green-400">Ready to Broadcast</span>
                            </div>
                            <p className="text-[10px] text-gray-400 mb-3">
                              Threshold reached. Combine signed PSBTs and broadcast.
                            </p>

                            {responses.filter((r) => r.psbtHex).length > 0 && (
                              <div className="bg-surface-800 rounded-lg p-2 mb-2">
                                <div className="flex items-center justify-between mb-1">
                                  <p className="text-[9px] text-gray-500 uppercase tracking-wider">
                                    Collected PSBTs ({responses.filter((r) => r.psbtHex).length})
                                  </p>
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      const all = responses.filter((r) => r.psbtHex).map((r) => r.psbtHex!).join('\n---\n');
                                      copyToClipboard(all || round.psbtHex, `allpsbt_${round.id}`);
                                    }}
                                    className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] bg-surface-700 hover:bg-surface-600 text-gray-300 transition-colors"
                                  >
                                    {copied === `allpsbt_${round.id}` ? <Check className="w-2.5 h-2.5 text-green-400" /> : <Copy className="w-2.5 h-2.5" />}
                                    Copy All
                                  </button>
                                </div>
                                <code className="text-[9px] text-gray-400 font-mono break-all block max-h-12 overflow-y-auto">
                                  {responses.filter((r) => r.psbtHex).map((r) => r.psbtHex!.slice(0, 24)).join('... ')}...
                                </code>
                              </div>
                            )}

                            <div className="flex gap-2">
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  const psbts = responses.filter((r) => r.psbtHex).map((r) => r.psbtHex!);
                                  const content = psbts.length > 0 ? psbts.join('\n') : round.psbtHex;
                                  const blob = new Blob([content], { type: 'application/octet-stream' });
                                  const url = URL.createObjectURL(blob);
                                  const a = document.createElement('a');
                                  a.href = url;
                                  a.download = `round-${round.id.slice(0, 8)}.psbt`;
                                  document.body.appendChild(a);
                                  a.click();
                                  document.body.removeChild(a);
                                  URL.revokeObjectURL(url);
                                }}
                                className="flex-1 flex items-center justify-center gap-1.5 px-2 py-2 rounded-lg bg-green-500/15 text-green-400 border border-green-500/25 hover:bg-green-500/25 transition-colors text-[11px] font-medium min-h-[36px]"
                              >
                                <Download className="w-3.5 h-3.5" />
                                Download
                              </button>
                              <a
                                href="https://mempool.space/tx/push"
                                target="_blank"
                                rel="noopener noreferrer"
                                onClick={(e) => e.stopPropagation()}
                                className="flex-1 flex items-center justify-center gap-1.5 px-2 py-2 rounded-lg bg-bitcoin/15 text-bitcoin border border-bitcoin/25 hover:bg-bitcoin/25 transition-colors text-[11px] font-medium min-h-[36px]"
                              >
                                <ExternalLink className="w-3.5 h-3.5" />
                                Broadcast
                              </a>
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </>
        )}

        {activeTab === 'invoices' && (
          <>
            {/* Create Invoice + Check All Statuses */}
            <div className="flex gap-2 mb-4">
              <button
                onClick={() => setShowInvoiceCreator(true)}
                className="btn-primary flex-1 flex items-center justify-center gap-2 min-h-[44px]"
              >
                <Plus className="w-4 h-4" />
                Create Invoice
              </button>
              {invoices.length > 0 && (
                <button
                  onClick={batchCheckStatuses}
                  disabled={checkingStatuses}
                  className="flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl text-xs font-medium bg-surface-700 text-gray-300 hover:bg-surface-600 border border-white/5 transition-colors min-h-[44px]"
                  title="Check all invoice statuses"
                >
                  {checkingStatuses ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <RefreshCw className="w-3.5 h-3.5" />
                  )}
                </button>
              )}
            </div>

            {/* Sent / Received sub-tabs */}
            <div className="flex gap-1 mb-3 bg-surface-800 rounded-lg p-0.5">
              {(['all', 'sent', 'received'] as const).map((tab) => (
                <button
                  key={tab}
                  onClick={() => setInvoiceSubTab(tab)}
                  className={`flex-1 px-2 py-1.5 rounded-md text-[11px] font-medium transition-colors ${
                    invoiceSubTab === tab
                      ? 'bg-white/10 text-white'
                      : 'text-gray-500 hover:text-gray-300'
                  }`}
                >
                  {tab === 'all' ? 'All' : tab === 'sent' ? 'Sent' : 'Received'}
                  {tab !== 'all' && (
                    <span className="ml-1 text-[9px] opacity-60">
                      {invoices.filter((i) => i.direction === tab).length || ''}
                    </span>
                  )}
                </button>
              ))}
            </div>

            {invoicesLoading && invoices.length === 0 && (
              <div className="flex flex-col items-center justify-center py-8">
                <Loader2 className="w-6 h-6 text-nostr animate-spin mb-3" />
                <p className="text-sm text-gray-400">Loading invoices...</p>
              </div>
            )}

            {!invoicesLoading && invoices.length === 0 && (
              <div className="flex flex-col items-center justify-center py-8">
                <FileText className="w-12 h-12 text-gray-600 mb-3" />
                <p className="text-sm text-gray-400">No invoices yet</p>
                <p className="text-xs text-gray-600 mt-1 text-center max-w-[240px]">
                  Create an onchain invoice or receive one from others
                </p>
              </div>
            )}

            {invoices
              .filter((item) => invoiceSubTab === 'all' || item.direction === invoiceSubTab)
              .map((item) => {
                const profile = profiles.get(item.pubkey);
                const displayName = profile?.displayName || profile?.name || item.pubkey.slice(0, 12);
                const statusInfo = invoiceStatuses.get(item.eventId);
                const memoText = item.invoice.memo || '';
                const hasImage = memoText.includes('https://') && (
                  memoText.includes('.png') || memoText.includes('.jpg') ||
                  memoText.includes('.jpeg') || memoText.includes('.webp') ||
                  memoText.includes('.gif') || memoText.includes('nostr.build')
                );
                const memoClean = memoText.replace(/https?:\/\/\S+/g, '').trim();
                const invoiceLink = `https://nostr-onchain-signer.vercel.app/invoice/${item.eventId}`;

                return (
                  <div
                    key={item.eventId}
                    className="bg-surface-700 rounded-xl p-3 mb-3 cursor-pointer hover:bg-surface-600/80 transition-colors"
                    onClick={() => navigate(`/invoice/${item.eventId}`)}
                  >
                    <div className="flex items-start gap-3">
                      {/* Profile pic or direction icon */}
                      {profile?.picture ? (
                        <img src={profile.picture} alt="" className="w-9 h-9 rounded-full object-cover bg-surface-700 flex-shrink-0" />
                      ) : (
                        <div className={`w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 ${
                          item.direction === 'sent'
                            ? 'bg-gradient-to-br from-bitcoin/40 to-bitcoin/20'
                            : 'bg-gradient-to-br from-nostr/40 to-nostr/20'
                        }`}>
                          <FileText className={`w-4 h-4 ${
                            item.direction === 'sent' ? 'text-bitcoin' : 'text-nostr'
                          }`} />
                        </div>
                      )}

                      <div className="flex-1 min-w-0">
                        {/* Name + direction badge */}
                        <div className="flex items-center gap-2 mb-0.5">
                          <span className="text-sm font-medium text-white truncate">{displayName}</span>
                          <span className={`text-[9px] font-medium px-1.5 py-0.5 rounded-full ${
                            item.direction === 'sent' ? 'bg-bitcoin/15 text-bitcoin' : 'bg-nostr/15 text-nostr'
                          }`}>
                            {item.direction === 'sent' ? 'Sent' : 'Received'}
                          </span>
                          {hasImage && <Image className="w-3 h-3 text-gray-500 flex-shrink-0" />}
                        </div>

                        {/* Memo (truncated) */}
                        {memoClean && (
                          <p className="text-xs text-gray-300 mb-1 line-clamp-1">{memoClean}</p>
                        )}

                        {/* Amount + time */}
                        <div className="flex items-center gap-2 text-[10px] text-gray-500 mb-2">
                          {item.invoice.amount_sats ? (
                            <span className="text-bitcoin font-medium">
                              {formatSats(item.invoice.amount_sats)}
                            </span>
                          ) : (
                            <span className="text-gray-400">Any amount</span>
                          )}
                          <span>{formatTimeAgo(item.createdAt)}</span>
                          {statusInfo && statusInfo.confirmedSats > 0 && (
                            <span className="text-green-400">
                              {formatSats(statusInfo.confirmedSats)} received
                            </span>
                          )}
                        </div>

                        {/* Status badge + action buttons */}
                        <div className="flex items-center gap-2">
                          <InvoiceStatusBadge status={statusInfo?.status} />

                          <button
                            onClick={(e) => { e.stopPropagation(); copyToClipboard(invoiceLink, `link_${item.eventId}`); }}
                            className="p-1 rounded hover:bg-surface-600 text-gray-500 hover:text-white transition-colors min-w-[28px] min-h-[28px] flex items-center justify-center"
                            title="Copy invoice link"
                          >
                            {copied === `link_${item.eventId}` ? <Check className="w-3 h-3 text-green-400" /> : <Link className="w-3 h-3" />}
                          </button>

                          <button
                            onClick={(e) => { e.stopPropagation(); checkSingleInvoiceStatus(item); }}
                            className="p-1 rounded hover:bg-surface-600 text-gray-500 hover:text-white transition-colors min-w-[28px] min-h-[28px] flex items-center justify-center"
                            title="Check payment status"
                          >
                            <RefreshCw className="w-3 h-3" />
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
          </>
        )}
      </div>
    </div>
  );
}

// ─── Request Detail ────────────────────────────────────────────

function RequestDetail({
  request,
  profile,
  publicKey,
  onBack,
  onSigned,
}: {
  request: SigningRequest;
  profile?: ProfileMetadata | null;
  publicKey: string;
  onBack: () => void;
  onSigned: () => void;
}) {
  const [signing, setSigning] = useState(false);
  const [alreadySigned, setAlreadySigned] = useState(false);
  const [copied, setCopied] = useState('');
  const [liveSignedCount, setLiveSignedCount] = useState(request.signed_count);
  const [responders, setResponders] = useState<{ pubkey: string; psbtHex?: string }[]>([]);
  const [copiedPsbt, setCopiedPsbt] = useState(false);
  const liveCleanupRef = useRef<(() => void) | null>(null);
  const displayName = profile?.displayName || profile?.name || request.senderPubkey.slice(0, 12);
  const webSignUrl = signingUrl(request.round_id);
  const qrCodeUrl = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(webSignUrl)}`;
  const isReady = liveSignedCount >= request.threshold;

  useEffect(() => {
    (async () => {
      const key = `signed_rounds_${publicKey}`;
      const result = await chrome.storage.local.get(key);
      const signedIds: string[] = result[key] ?? [];
      if (signedIds.includes(request.round_id)) {
        setAlreadySigned(true);
      }
    })();
  }, [publicKey, request.round_id]);

  useEffect(() => {
    let mounted = true;
    const seenPubkeys = new Set<string>();
    const collected: { pubkey: string; psbtHex?: string }[] = [];

    (async () => {
      const relayList = await loadRelayList();
      const relays = getReadRelays(relayList);
      const relayUrls = relays.length > 0
        ? relays
        : ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.snort.social'];

      const connections: { ws: WebSocket; subId: string }[] = [];

      for (const url of relayUrls) {
        const subId = `detail_resp_${Math.random().toString(36).slice(2, 10)}`;
        let ws: WebSocket;
        try { ws = new WebSocket(url); } catch { continue; }
        connections.push({ ws, subId });

        ws.onopen = () => {
          ws.send(JSON.stringify(['REQ', subId, {
            kinds: [CUSTOM_KIND.SIGNING_RESPONSE],
            '#r': [request.round_id],
            limit: 50,
          }]));
        };

        ws.onmessage = (msg) => {
          if (!mounted) return;
          try {
            const data = JSON.parse(msg.data);
            if (data[0] === 'EVENT' && data[1] === subId) {
              const evt = data[2];
              if (seenPubkeys.has(evt.pubkey)) return;
              try {
                const content = JSON.parse(evt.content);
                if (content.round_id === request.round_id && content.accepted) {
                  seenPubkeys.add(evt.pubkey);
                  collected.push({ pubkey: evt.pubkey, psbtHex: content.psbt_hex });
                  setResponders([...collected]);
                  setLiveSignedCount(request.signed_count + collected.length);
                }
              } catch { /* malformed */ }
            }
          } catch { /* ignore */ }
        };
      }

      liveCleanupRef.current = () => {
        mounted = false;
        for (const conn of connections) {
          try {
            if (conn.ws.readyState === WebSocket.OPEN) {
              conn.ws.send(JSON.stringify(['CLOSE', conn.subId]));
            }
            conn.ws.close();
          } catch { /* ignore */ }
        }
        connections.length = 0;
      };
    })();

    return () => { liveCleanupRef.current?.(); };
  }, [request.round_id]);

  function handleCopyAllPsbts() {
    const psbts = responders
      .filter((r) => r.psbtHex)
      .map((r) => r.psbtHex!)
      .join('\n---\n');
    navigator.clipboard.writeText(psbts || request.psbt_hex);
    setCopiedPsbt(true);
    setTimeout(() => setCopiedPsbt(false), 2000);
  }

  function handleDownloadFinalPsbt() {
    const psbts = responders.filter((r) => r.psbtHex).map((r) => r.psbtHex!);
    const content = psbts.length > 0 ? psbts.join('\n') : request.psbt_hex;
    const blob = new Blob([content], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `signing-round-${request.round_id.slice(0, 8)}.psbt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  async function handleSign() {
    setSigning(true);
    try {
      const responseEvent = {
        kind: 9801,
        content: JSON.stringify({
          round_id: request.round_id,
          psbt_hex: request.psbt_hex,
          accepted: true,
          message: 'Signed via Nostr Onchain',
        }),
        tags: [
          ['p', request.senderPubkey],
          ['r', request.round_id],
          ['e', request.eventId],
        ],
        created_at: Math.floor(Date.now() / 1000),
        pubkey: publicKey,
      };

      const signResponse = await chrome.runtime.sendMessage({
        type: 'nip07:signEvent',
        payload: { event: responseEvent },
        id: createMessageId(),
      });

      if (signResponse.error) throw new Error(signResponse.error);

      const { publishEvent } = await import('@/lib/nostr/discovery');
      await publishEvent(signResponse.result);

      const dmContent = `✅ Signed your transaction!\n\nRound: ${request.round_id.slice(0, 12)}...\nMulti-sig: ${request.multisig_address.slice(0, 16)}...\n\nCheck your Nostr Onchain signer for the updated PSBT.`;

      let encryptedDmContent = dmContent;
      let dmKind = 4;
      try {
        const result = await encryptDM(request.senderPubkey, dmContent);
        encryptedDmContent = result.content;
        dmKind = result.kind;
      } catch {
        console.warn('DM encryption failed — sending as plaintext');
      }

      const dmEvent = {
        kind: dmKind,
        content: encryptedDmContent,
        tags: [['p', request.senderPubkey]],
        created_at: Math.floor(Date.now() / 1000),
        pubkey: publicKey,
      };

      const dmSignResponse = await chrome.runtime.sendMessage({
        type: 'nip07:signEvent',
        payload: { event: dmEvent },
        id: createMessageId(),
      });

      if (!dmSignResponse.error && dmSignResponse.result) {
        await publishEvent(dmSignResponse.result);
      }

      await markRequestStatus(request.eventId, 'signed');

      const storageKey = `signed_rounds_${publicKey}`;
      const stored = await chrome.storage.local.get(storageKey);
      const signedIds: string[] = stored[storageKey] ?? [];
      if (!signedIds.includes(request.round_id)) {
        signedIds.push(request.round_id);
        await chrome.storage.local.set({ [storageKey]: signedIds });
      }
      setAlreadySigned(true);

      onSigned();
    } catch (err) {
      console.error('Sign failed:', err);
      alert(`Signing failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setSigning(false);
    }
  }

  function copyLink(text: string, label: string) {
    navigator.clipboard.writeText(text);
    setCopied(label);
    setTimeout(() => setCopied(''), 2000);
  }

  return (
    <div className="h-full flex flex-col">
      <div className="page-header px-4">
        <button onClick={onBack} className="btn-back">
          <ArrowLeft className="w-5 h-5" />
        </button>
        <h1>Request Detail</h1>
      </div>

      <div className="flex-1 overflow-y-auto px-4 pb-24">
        {/* Combine & Broadcast section */}
        {isReady && (
          <div className="card mb-3 border-green-500/30 bg-green-500/5">
            <div className="flex items-center gap-2 mb-3">
              <CheckCircle2 className="w-5 h-5 text-green-400" />
              <span className="text-sm font-semibold text-green-400">Ready to Broadcast</span>
            </div>
            <p className="text-xs text-gray-400 mb-3">
              Threshold reached ({liveSignedCount}/{request.threshold} signatures).
              Combine the signed PSBTs and broadcast to the network.
            </p>

            {/* Signed PSBTs collected */}
            {responders.filter((r) => r.psbtHex).length > 0 && (
              <div className="bg-surface-700 rounded-lg p-3 mb-3">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[10px] text-gray-500 uppercase tracking-wider">
                    Collected Signed PSBTs ({responders.filter((r) => r.psbtHex).length})
                  </span>
                  <button
                    onClick={handleCopyAllPsbts}
                    className="flex items-center gap-1 px-2 py-1 rounded text-[10px] bg-surface-600 hover:bg-surface-500 text-gray-300 transition-colors"
                  >
                    {copiedPsbt ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3" />}
                    {copiedPsbt ? 'Copied' : 'Copy All'}
                  </button>
                </div>
                <code className="text-[10px] text-gray-400 font-mono break-all block max-h-16 overflow-y-auto">
                  {responders.filter((r) => r.psbtHex).map((r) => r.psbtHex!.slice(0, 32)).join('... ')}...
                </code>
              </div>
            )}

            <div className="flex gap-2 mb-3">
              <button
                onClick={handleDownloadFinalPsbt}
                className="flex-1 flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg bg-green-500/15 text-green-400 border border-green-500/25 hover:bg-green-500/25 transition-colors text-xs font-medium min-h-[44px]"
              >
                <Download className="w-4 h-4" />
                Download PSBT
              </button>
              <a
                href="https://mempool.space/tx/push"
                target="_blank"
                rel="noopener noreferrer"
                className="flex-1 flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg bg-bitcoin/15 text-bitcoin border border-bitcoin/25 hover:bg-bitcoin/25 transition-colors text-xs font-medium min-h-[44px]"
              >
                <ExternalLink className="w-4 h-4" />
                Broadcast
              </a>
            </div>

            <a
              href="https://mempool.space/api/tx"
              target="_blank"
              rel="noopener noreferrer"
              className="text-[10px] text-bitcoin hover:underline block"
            >
              Or POST raw tx → mempool.space/api/tx
            </a>
          </div>
        )}

        {/* Live signature counter */}
        <div className="card mb-3">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[10px] text-gray-500 uppercase tracking-wider">Live Signatures</span>
            <span className={`text-sm font-bold ${isReady ? 'text-green-400' : 'text-bitcoin'}`}>
              {liveSignedCount}/{request.threshold}
            </span>
          </div>
          <div className="w-full h-2 bg-surface-700 rounded-full overflow-hidden mb-2">
            <div
              className={`h-full rounded-full transition-all ${isReady ? 'bg-green-400' : 'bg-bitcoin'}`}
              style={{ width: `${Math.min((liveSignedCount / request.threshold) * 100, 100)}%` }}
            />
          </div>
          {responders.length > 0 && (
            <div className="space-y-1.5 mt-2">
              {responders.map((r) => (
                <div key={r.pubkey} className="flex items-center gap-2">
                  <Check className="w-3 h-3 text-green-400 flex-shrink-0" />
                  <code className="text-[10px] text-gray-300 font-mono truncate">
                    {r.pubkey.slice(0, 8)}...{r.pubkey.slice(-8)}
                  </code>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Sender */}
        <div className="card mb-3">
          <div className="flex items-center gap-2 mb-3">
            <div className="w-1.5 h-1.5 rounded-full bg-nostr" />
            <span className="text-[10px] text-gray-500 uppercase tracking-wider">From</span>
          </div>
          <div className="flex items-center gap-2.5">
            {profile?.picture ? (
              <img src={profile.picture} alt="" className="w-8 h-8 rounded-full object-cover bg-surface-700" />
            ) : (
              <div className="w-8 h-8 rounded-full bg-gradient-to-br from-bitcoin/40 to-nostr/30 flex items-center justify-center">
                <Shield className="w-3.5 h-3.5 text-white/70" />
              </div>
            )}
            <span className="text-sm font-medium text-white">{displayName}</span>
          </div>
        </div>

        {/* Details */}
        <div className="card mb-3 space-y-3">
          <div className="flex items-center gap-2 mb-1">
            <div className="w-1.5 h-1.5 rounded-full bg-bitcoin" />
            <span className="text-[10px] text-gray-500 uppercase tracking-wider">Transaction Details</span>
          </div>

          {request.memo && (
            <div>
              <p className="text-[10px] text-gray-500 mb-0.5">Memo</p>
              <p className="text-sm text-white">{request.memo}</p>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <p className="text-[10px] text-gray-500 mb-0.5">Threshold</p>
              <p className="text-sm text-white">{request.threshold} of {request.total_signers}</p>
            </div>
            <div>
              <p className="text-[10px] text-gray-500 mb-0.5">Signed</p>
              <p className={`text-sm ${isReady ? 'text-green-400 font-semibold' : 'text-white'}`}>
                {liveSignedCount} / {request.threshold}
                {isReady && ' ✓'}
              </p>
            </div>
          </div>

          <div>
            <p className="text-[10px] text-gray-500 mb-0.5">Multisig Address</p>
            <div className="flex items-center gap-1">
              <code className="text-[11px] text-gray-300 font-mono break-all flex-1">{request.multisig_address}</code>
              <button onClick={() => copyLink(request.multisig_address, 'addr')} className="p-1 text-gray-500 hover:text-white min-w-[28px] min-h-[28px] flex items-center justify-center">
                {copied === 'addr' ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3" />}
              </button>
            </div>
          </div>

          <div>
            <p className="text-[10px] text-gray-500 mb-0.5">Round ID</p>
            <div className="flex items-center gap-1">
              <code className="text-[11px] text-gray-300 font-mono break-all flex-1">{request.round_id}</code>
              <button onClick={() => copyLink(request.round_id, 'round')} className="p-1 text-gray-500 hover:text-white min-w-[28px] min-h-[28px] flex items-center justify-center">
                {copied === 'round' ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3" />}
              </button>
            </div>
          </div>

          <div>
            <p className="text-[10px] text-gray-500 mb-0.5">Expires</p>
            <p className="text-sm text-white">
              {new Date(request.expires_at * 1000).toLocaleString()}
            </p>
          </div>
        </div>

        {/* Feature 1: Share section with both nostr: and web URL */}
        <div className="card mb-3">
          <div className="flex items-center gap-2 mb-3">
            <Link className="w-3.5 h-3.5 text-gray-400" />
            <span className="text-[10px] text-gray-500 uppercase tracking-wider">Share</span>
          </div>

          <div className="space-y-2">
            <div>
              <p className="text-[10px] text-gray-500 mb-1">Signing URL</p>
              <button
                onClick={() => copyLink(webSignUrl, 'weblink')}
                className="w-full flex items-center gap-2 px-3 py-2 bg-surface-700 rounded-lg hover:bg-surface-600 transition-colors min-h-[40px]"
              >
                <span className="text-xs text-bitcoin truncate flex-1 font-mono text-left">{webSignUrl}</span>
                {copied === 'weblink' ? <Check className="w-3.5 h-3.5 text-green-400 flex-shrink-0" /> : <Copy className="w-3.5 h-3.5 text-gray-400 flex-shrink-0" />}
              </button>
            </div>

            <div>
              <p className="text-[10px] text-gray-500 mb-1">Nostr Reference</p>
              <button
                onClick={() => copyLink(`nostr:${request.eventId}`, 'nostrlink')}
                className="w-full flex items-center gap-2 px-3 py-2 bg-surface-700 rounded-lg hover:bg-surface-600 transition-colors min-h-[40px]"
              >
                <span className="text-xs text-gray-300 truncate flex-1 font-mono text-left">nostr:{request.eventId.slice(0, 24)}...</span>
                {copied === 'nostrlink' ? <Check className="w-3.5 h-3.5 text-green-400 flex-shrink-0" /> : <Copy className="w-3.5 h-3.5 text-gray-400 flex-shrink-0" />}
              </button>
            </div>
          </div>
        </div>

        {/* Feature 4: QR code for signing URL */}
        <div className="card mb-3">
          <div className="flex items-center gap-2 mb-3">
            <QrCode className="w-3.5 h-3.5 text-gray-400" />
            <span className="text-[10px] text-gray-500 uppercase tracking-wider">Scan to Sign</span>
          </div>
          <div className="flex justify-center">
            <div className="bg-white p-3 rounded-xl">
              <img
                src={qrCodeUrl}
                alt="Signing QR Code"
                width={200}
                height={200}
                className="block"
              />
            </div>
          </div>
          <p className="text-[10px] text-gray-600 text-center mt-2">
            Scan from another device to open the signing page
          </p>
        </div>

        {/* PSBT Preview */}
        <div className="card mb-4">
          <div className="flex items-center gap-2 mb-2">
            <div className="w-1.5 h-1.5 rounded-full bg-bitcoin" />
            <span className="text-[10px] text-gray-500 uppercase tracking-wider">PSBT Data</span>
          </div>
          <code className="block text-[10px] text-gray-400 font-mono break-all max-h-24 overflow-y-auto">
            {request.psbt_hex.slice(0, 200)}
            {request.psbt_hex.length > 200 && '...'}
          </code>
          <p className="text-[10px] text-gray-500 mt-1">{request.psbt_hex.length} hex chars</p>
        </div>

        {/* Action */}
        {alreadySigned ? (
          <div className="w-full flex items-center justify-center gap-2 min-h-[44px] px-4 py-2.5 rounded-xl text-sm font-medium bg-green-500/10 text-green-400 border border-green-500/20">
            <CheckCircle2 className="w-4 h-4" />
            You&apos;ve already signed this transaction
          </div>
        ) : request.status === 'pending' && (
          <button
            onClick={handleSign}
            disabled={signing}
            className="btn-primary w-full flex items-center justify-center gap-2 min-h-[44px]"
          >
            {signing ? (
              <><Loader2 className="w-4 h-4 animate-spin" /> Signing &amp; Publishing...</>
            ) : (
              <><Check className="w-4 h-4" /> Sign &amp; Notify via DM</>
            )}
          </button>
        )}
      </div>
    </div>
  );
}
