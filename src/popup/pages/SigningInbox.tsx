import { useState, useEffect, useRef, useCallback } from 'react';
import {
  subscribeSigningInbox,
  markRequestStatus,
  type SigningRequest,
} from '@/lib/nostr/signing-inbox';
import { loadRelayList, getReadRelays } from '@/lib/nostr/relays';
import { getCachedProfile } from '@/lib/nostr/cache';
import { type ProfileMetadata } from '@/lib/nostr/social';
import { loadSigningRounds, type SigningRound } from '@/lib/bitcoin/signing-round';
import { loadPendingRequests, type PendingSignatureRequest } from '@/lib/bitcoin/wallet-store';
import { pubkeyToNpub } from '@/lib/nostr/keys';
import {
  ArrowLeft, Inbox, Loader2, Check, X, Clock,
  Shield, ChevronRight, AlertTriangle, Copy, Link, FileText,
  Send,
} from 'lucide-react';

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

export function SigningInbox({ publicKey, onBack }: Props) {
  const [requests, setRequests] = useState<SigningRequest[]>([]);
  const [outbound, setOutbound] = useState<PendingSignatureRequest[]>([]);
  const [profiles, setProfiles] = useState<Map<string, ProfileMetadata>>(new Map());
  const [loading, setLoading] = useState(true);
  const [selectedRequest, setSelectedRequest] = useState<SigningRequest | null>(null);
  const [activeTab, setActiveTab] = useState<'incoming' | 'outbound' | 'invoices'>('incoming');
  const [copied, setCopied] = useState('');
  const cleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    loadInbox();
    loadOutbound();
    return () => {
      if (cleanupRef.current) {
        cleanupRef.current();
      }
    };
  }, [publicKey]);

  async function loadOutbound() {
    try {
      const pending = await loadPendingRequests();
      setOutbound(pending.sort((a, b) => b.createdAt - a.createdAt));
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

    setTimeout(() => setLoading(false), 15000);
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

  const pendingCount = requests.filter((r) => r.status === 'pending').length;
  const outboundPending = outbound.filter((r) => r.status === 'pending').length;

  if (selectedRequest) {
    return (
      <RequestDetail
        request={selectedRequest}
        profile={profiles.get(selectedRequest.senderPubkey)}
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
          Sent {outboundPending > 0 && <span className="text-[9px] bg-nostr/80 text-white px-1 rounded-full">{outboundPending}</span>}
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
          Invoices
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-4 pb-20">
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

              return (
                <div key={request.eventId} className="card mb-3">
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
                        <span>{request.signed_count}/{request.threshold} signed</span>
                        <span>{request.total_signers} signers</span>
                      </div>

                      <div className="flex items-center gap-2">
                        <StatusBadge status={request.status} />

                        {/* Copy link button */}
                        <button
                          onClick={() => copyToClipboard(
                            `nostr:${request.eventId}`,
                            request.eventId
                          )}
                          className="p-1 rounded hover:bg-surface-700 text-gray-500 hover:text-white transition-colors"
                          title="Copy request link"
                        >
                          {copied === request.eventId ? <Check className="w-3 h-3 text-green-400" /> : <Link className="w-3 h-3" />}
                        </button>

                        {request.status === 'pending' && (
                          <div className="flex items-center gap-1.5 ml-auto">
                            <button
                              onClick={() => handleDecline(request)}
                              className="px-2.5 py-1 rounded-lg text-[11px] font-medium bg-red-500/10 text-red-400 border border-red-500/20 hover:bg-red-500/20 transition-colors"
                            >
                              Decline
                            </button>
                            <button
                              onClick={() => handleAccept(request)}
                              className="px-2.5 py-1 rounded-lg text-[11px] font-medium bg-bitcoin/15 text-bitcoin border border-bitcoin/30 hover:bg-bitcoin/25 transition-colors"
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
            {outbound.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12">
                <Send className="w-12 h-12 text-gray-600 mb-3" />
                <p className="text-sm text-gray-400">No outgoing requests</p>
                <p className="text-xs text-gray-600 mt-1">
                  When you request signatures from co-signers, they appear here
                </p>
              </div>
            ) : (
              outbound.map((req) => (
                <div key={req.id} className="card mb-3">
                  <div className="flex items-center gap-3">
                    <div className="w-9 h-9 rounded-full bg-nostr/20 flex items-center justify-center flex-shrink-0">
                      <Send className="w-4 h-4 text-nostr" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{req.memo || 'Signature request'}</p>
                      <div className="flex items-center gap-2 text-[10px] text-gray-500">
                        <span>{req.amount ? `${req.amount.toLocaleString()} sats` : ''}</span>
                        <span>{new Date(req.createdAt).toLocaleDateString()}</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full ${
                        req.status === 'pending' ? 'bg-bitcoin/15 text-bitcoin' :
                        req.status === 'signed' ? 'bg-green-500/15 text-green-400' :
                        'bg-gray-500/15 text-gray-400'
                      }`}>
                        {req.status}
                      </span>
                      <button
                        onClick={() => copyToClipboard(req.roundId, req.id)}
                        className="p-1.5 rounded hover:bg-surface-700 text-gray-500 hover:text-white transition-colors"
                        title="Copy round ID"
                      >
                        {copied === req.id ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3" />}
                      </button>
                    </div>
                  </div>
                </div>
              ))
            )}
          </>
        )}

        {activeTab === 'invoices' && (
          <div className="flex flex-col items-center justify-center py-12">
            <FileText className="w-12 h-12 text-gray-600 mb-3" />
            <p className="text-sm text-gray-400">No invoices yet</p>
            <p className="text-xs text-gray-600 mt-1 text-center max-w-[240px]">
              On-chain invoices (kind 9733) from others requesting payment will appear here
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function RequestDetail({
  request,
  profile,
  onBack,
  onSigned,
}: {
  request: SigningRequest;
  profile?: ProfileMetadata | null;
  onBack: () => void;
  onSigned: () => void;
}) {
  const displayName = profile?.displayName || profile?.name || request.senderPubkey.slice(0, 12);

  async function handleSign() {
    await markRequestStatus(request.eventId, 'signed');
    onSigned();
  }

  return (
    <div className="h-full flex flex-col">
      <div className="page-header px-4">
        <button onClick={onBack} className="btn-back">
          <ArrowLeft className="w-5 h-5" />
        </button>
        <h1>Request Detail</h1>
      </div>

      <div className="flex-1 overflow-y-auto px-4 pb-4">
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
              <p className="text-sm text-white">{request.signed_count} / {request.threshold}</p>
            </div>
          </div>

          <div>
            <p className="text-[10px] text-gray-500 mb-0.5">Multisig Address</p>
            <code className="text-[11px] text-gray-300 font-mono break-all">{request.multisig_address}</code>
          </div>

          <div>
            <p className="text-[10px] text-gray-500 mb-0.5">Round ID</p>
            <code className="text-[11px] text-gray-300 font-mono break-all">{request.round_id}</code>
          </div>

          <div>
            <p className="text-[10px] text-gray-500 mb-0.5">Expires</p>
            <p className="text-sm text-white">
              {new Date(request.expires_at * 1000).toLocaleString()}
            </p>
          </div>
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
        {request.status === 'pending' && (
          <button onClick={handleSign} className="btn-primary w-full flex items-center justify-center gap-2">
            <Check className="w-4 h-4" />
            Sign Transaction
          </button>
        )}
      </div>
    </div>
  );
}
