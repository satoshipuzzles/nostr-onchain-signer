import { useState, useEffect, useRef } from 'react';
import { useParams } from 'react-router-dom';
import {
  Loader2, Check, Copy, ExternalLink, QrCode, Shield,
  CheckCircle2, Download, AlertTriangle, Clock, X, LogIn, XCircle,
} from 'lucide-react';
import { CUSTOM_KIND, type SigningRequestContent, type SigningResponseContent } from '@/lib/nostr/kinds';
import { getCachedProfile } from '@/lib/nostr/cache';
import { safeImageUrl } from '@/lib/utils';
import type { ProfileMetadata } from '@/lib/nostr/social';

const RELAYS = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.snort.social'];
const VERCEL_URL = 'https://nostr-onchain-signer.vercel.app';

interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

interface SignerInfo {
  pubkey: string;
  signed: boolean;
  psbtHex?: string;
}

function SignerBadge({ pubkey, signed }: { pubkey: string; signed: boolean }) {
  const [profile, setProfile] = useState<ProfileMetadata | null>(null);
  useEffect(() => {
    getCachedProfile(pubkey).then((p) => setProfile(p));
  }, [pubkey]);

  const name = profile?.displayName || profile?.name || pubkey.slice(0, 8) + '...';
  return (
    <div className="flex items-center gap-2">
      {signed ? (
        <Check className="w-3.5 h-3.5 text-green-400 flex-shrink-0" />
      ) : (
        <Clock className="w-3.5 h-3.5 text-gray-500 flex-shrink-0" />
      )}
      {profile?.picture ? (
        <img src={safeImageUrl(profile.picture)} alt="" className="w-7 h-7 rounded-full object-cover flex-shrink-0" />
      ) : (
        <div className="w-7 h-7 rounded-full bg-gradient-to-br from-bitcoin/30 to-nostr/30 flex items-center justify-center flex-shrink-0">
          <span className="text-[10px] font-bold text-white/70">{name.charAt(0).toUpperCase()}</span>
        </div>
      )}
      <div className="min-w-0 flex-1">
        <span className="text-xs text-gray-300 truncate block">{name}</span>
        {profile?.nip05 && <span className="text-[9px] text-nostr/70 truncate block">{profile.nip05}</span>}
      </div>
      <span className={`text-[10px] flex-shrink-0 ${signed ? 'text-green-400' : 'text-gray-500'}`}>
        {signed ? 'Signed' : 'Pending'}
      </span>
    </div>
  );
}

export function SignPage() {
  const { roundId } = useParams<{ roundId: string }>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [requestEvent, setRequestEvent] = useState<NostrEvent | null>(null);
  const [request, setRequest] = useState<SigningRequestContent | null>(null);
  const [signers, setSigners] = useState<SignerInfo[]>([]);
  const [signedPsbts, setSignedPsbts] = useState<string[]>([]);
  const [signing, setSigning] = useState(false);
  const [signed, setSigned] = useState(false);
  const [userPubkey, setUserPubkey] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [copied, setCopied] = useState('');
  const [copiedPsbt, setCopiedPsbt] = useState(false);
  const responseCleanupRef = useRef<(() => void) | null>(null);

  // All co-signer pubkeys extracted from the request event's p tags
  const [coSignerPubkeys, setCoSignerPubkeys] = useState<string[]>([]);

  useEffect(() => {
    if (roundId) fetchSigningRequest(roundId);
    return () => { responseCleanupRef.current?.(); };
  }, [roundId]);

  // Check if the connected user has already signed when we get responses
  useEffect(() => {
    if (userPubkey && signers.some((s) => s.pubkey === userPubkey && s.signed)) {
      setSigned(true);
    }
  }, [userPubkey, signers]);

  async function fetchSigningRequest(rid: string) {
    setLoading(true);
    setError('');

    const results = await Promise.allSettled(
      RELAYS.map((url) => fetchRequestFromRelay(url, rid))
    );

    let foundEvent: NostrEvent | null = null;
    for (const result of results) {
      if (result.status === 'fulfilled' && result.value) {
        foundEvent = result.value;
        break;
      }
    }

    if (!foundEvent) {
      setError('Signing request not found on relays');
      setLoading(false);
      return;
    }

    setRequestEvent(foundEvent);

    // Extract co-signer pubkeys from p tags
    const pTags = foundEvent.tags.filter((t) => t[0] === 'p').map((t) => t[1]);
    // Include the request author as well
    const allPubkeys = Array.from(new Set([foundEvent.pubkey, ...pTags]));
    setCoSignerPubkeys(allPubkeys);

    try {
      const parsed: SigningRequestContent = JSON.parse(foundEvent.content);
      if (!parsed.psbt_hex || !parsed.round_id || !parsed.multisig_address) {
        setError('Invalid signing request data');
        setLoading(false);
        return;
      }
      setRequest(parsed);
      subscribeToResponses(rid, parsed, foundEvent);
    } catch {
      setError('Failed to parse signing request');
    }

    setLoading(false);
  }

  function fetchRequestFromRelay(relayUrl: string, rid: string): Promise<NostrEvent | null> {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => { ws.close(); resolve(null); }, 10000);

      let ws: WebSocket;
      try {
        ws = new WebSocket(relayUrl);
      } catch {
        clearTimeout(timeout);
        resolve(null);
        return;
      }

      const subId = `sign_${Math.random().toString(36).slice(2, 8)}`;

      ws.onopen = () => {
        ws.send(JSON.stringify(['REQ', subId, {
          kinds: [CUSTOM_KIND.SIGNING_REQUEST],
          '#r': [rid],
          limit: 1,
        }]));
      };

      ws.onmessage = (msg) => {
        try {
          const data = JSON.parse(msg.data);
          if (data[0] === 'EVENT' && data[1] === subId && data[2]) {
            clearTimeout(timeout);
            ws.close();
            resolve(data[2] as NostrEvent);
          } else if (data[0] === 'EOSE') {
            clearTimeout(timeout);
            ws.close();
            resolve(null);
          }
        } catch { /* ignore */ }
      };

      ws.onerror = () => { clearTimeout(timeout); resolve(null); };
    });
  }

  function subscribeToResponses(rid: string, req: SigningRequestContent, _event: NostrEvent) {
    const seenIds = new Set<string>();
    const collected: SignerInfo[] = [];
    const psbts: string[] = [];

    const connections: { ws: WebSocket; subId: string }[] = [];

    for (const url of RELAYS) {
      const subId = `resp_${Math.random().toString(36).slice(2, 10)}`;
      let ws: WebSocket;
      try {
        ws = new WebSocket(url);
      } catch { continue; }
      connections.push({ ws, subId });

      ws.onopen = () => {
        ws.send(JSON.stringify(['REQ', subId, {
          kinds: [CUSTOM_KIND.SIGNING_RESPONSE],
          '#r': [rid],
          limit: 50,
        }]));
      };

      ws.onmessage = (msg) => {
        try {
          const data = JSON.parse(msg.data);
          if (data[0] === 'EVENT' && data[1] === subId) {
            const evt = data[2];
            if (seenIds.has(evt.id)) return;
            seenIds.add(evt.id);
            try {
              const content: SigningResponseContent = JSON.parse(evt.content);
              if (content.round_id === rid && content.accepted) {
                const existing = collected.find((s) => s.pubkey === evt.pubkey);
                if (!existing) {
                  collected.push({ pubkey: evt.pubkey, signed: true, psbtHex: content.psbt_hex });
                  if (content.psbt_hex) psbts.push(content.psbt_hex);
                  setSigners([...collected]);
                  setSignedPsbts([...psbts]);
                }
              }
            } catch { /* malformed */ }
          }
        } catch { /* ignore */ }
      };
    }

    responseCleanupRef.current = () => {
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

  async function handleConnect() {
    setConnecting(true);
    try {
      const nostr = (window as any).nostr;
      if (!nostr?.getPublicKey) {
        setError('No NIP-07 extension found. Install Alby, nos2x, or another Nostr signer extension.');
        return;
      }
      const pk = await nostr.getPublicKey();
      setUserPubkey(pk);
    } catch (err) {
      console.error('NIP-07 connect failed:', err);
    } finally {
      setConnecting(false);
    }
  }

  function getSignEligibility(): 'eligible' | 'not_cosigner' | 'already_signed' | 'is_initiator' {
    if (!userPubkey || !requestEvent) return 'eligible';
    if (signed) return 'already_signed';
    if (signers.some((s) => s.pubkey === userPubkey && s.signed)) return 'already_signed';
    // Check if user is a co-signer (in p tags or is the author)
    const isCoSigner = coSignerPubkeys.includes(userPubkey);
    if (!isCoSigner) return 'not_cosigner';
    if (userPubkey === requestEvent.pubkey) return 'is_initiator';
    return 'eligible';
  }

  async function handleSign() {
    if (!requestEvent || !request || !roundId) return;

    setSigning(true);
    try {
      const nostr = (window as any).nostr;
      if (!nostr) throw new Error('NIP-07 extension not found');

      let pubkey = userPubkey;
      if (!pubkey) {
        pubkey = await nostr.getPublicKey();
        setUserPubkey(pubkey);
      }

      const responseEvent = {
        kind: CUSTOM_KIND.SIGNING_RESPONSE,
        content: JSON.stringify({
          round_id: request.round_id,
          psbt_hex: request.psbt_hex,
          accepted: true,
          message: 'Signed via public signing page',
        } satisfies SigningResponseContent),
        tags: [
          ['p', requestEvent.pubkey],
          ['r', request.round_id],
          ['e', requestEvent.id],
        ],
        created_at: Math.floor(Date.now() / 1000),
      };

      const signedEvent = await nostr.signEvent(responseEvent);
      if (!signedEvent) throw new Error('Signing was cancelled');

      await publishToRelays(signedEvent);
      setSigned(true);
    } catch (err) {
      alert(`Signing failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setSigning(false);
    }
  }

  async function publishToRelays(event: NostrEvent): Promise<void> {
    const promises = RELAYS.map((relayUrl) =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(() => { ws.close(); resolve(); }, 8000);
        let ws: WebSocket;
        try { ws = new WebSocket(relayUrl); } catch { clearTimeout(timer); resolve(); return; }
        ws.onopen = () => { ws.send(JSON.stringify(['EVENT', event])); };
        ws.onmessage = (msg) => {
          try {
            const data = JSON.parse(msg.data);
            if (data[0] === 'OK') { clearTimeout(timer); ws.close(); resolve(); }
          } catch { /* ignore */ }
        };
        ws.onerror = () => { clearTimeout(timer); resolve(); };
      })
    );
    await Promise.allSettled(promises);
  }

  function copyToClipboard(text: string, label: string) {
    navigator.clipboard.writeText(text);
    setCopied(label);
    setTimeout(() => setCopied(''), 2000);
  }

  function handleCopyPsbt() {
    const allPsbts = signedPsbts.join('\n---\n');
    navigator.clipboard.writeText(allPsbts || request?.psbt_hex || '');
    setCopiedPsbt(true);
    setTimeout(() => setCopiedPsbt(false), 2000);
  }

  function handleDownloadPsbt() {
    const content = signedPsbts.length > 0 ? signedPsbts.join('\n') : request?.psbt_hex || '';
    const blob = new Blob([content], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `signing-round-${roundId?.slice(0, 8)}.psbt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  const signingUrl = `${VERCEL_URL}/sign/${roundId}`;
  const qrCodeUrl = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(signingUrl)}`;
  const signedCount = signers.filter((s) => s.signed).length + (request?.signed_count ?? 0);
  const threshold = request?.threshold ?? 0;
  const isReady = threshold > 0 && signedCount >= threshold;
  const isExpired = request?.expires_at ? request.expires_at < Math.floor(Date.now() / 1000) : false;
  const eligibility = getSignEligibility();

  // Build co-signer display list merging p-tag pubkeys with response data
  const coSignerDisplay: { pubkey: string; signed: boolean }[] = coSignerPubkeys.map((pk) => ({
    pubkey: pk,
    signed: signers.some((s) => s.pubkey === pk && s.signed),
  }));
  // Add any signers from responses not in the original co-signer list
  for (const s of signers) {
    if (!coSignerDisplay.some((c) => c.pubkey === s.pubkey)) {
      coSignerDisplay.push({ pubkey: s.pubkey, signed: s.signed });
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-surface-900 flex items-center justify-center p-4">
        <div className="text-center">
          <Loader2 className="w-8 h-8 animate-spin text-bitcoin mx-auto mb-3" />
          <p className="text-gray-400 text-sm">Fetching signing request from relays...</p>
        </div>
      </div>
    );
  }

  if (error && !requestEvent) {
    return (
      <div className="min-h-screen bg-surface-900 flex items-center justify-center p-4">
        <div className="text-center max-w-sm">
          <AlertTriangle className="w-10 h-10 text-red-400 mx-auto mb-3" />
          <p className="text-red-400 text-sm mb-2">{error}</p>
          <p className="text-gray-500 text-xs">Round ID: {roundId}</p>
        </div>
      </div>
    );
  }

  if (!request || !requestEvent) return null;

  return (
    <div className="min-h-screen bg-surface-900 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        {/* Header */}
        <div className="text-center mb-6">
          <div className="w-14 h-14 rounded-full bg-gradient-to-br from-bitcoin/40 to-nostr/30 flex items-center justify-center mx-auto mb-3">
            <Shield className="w-7 h-7 text-white/80" />
          </div>
          <h1 className="text-xl font-bold text-white">Multi-Sig Signing Request</h1>
          <p className="text-gray-400 text-xs mt-1">Review and sign this transaction</p>
        </div>

        {/* Ready to Broadcast Banner */}
        {isReady && (
          <div className="bg-green-500/10 border border-green-500/20 rounded-2xl p-4 mb-4">
            <div className="flex items-center gap-2 mb-2">
              <CheckCircle2 className="w-5 h-5 text-green-400" />
              <span className="text-sm font-semibold text-green-400">Ready to Broadcast</span>
            </div>
            <p className="text-xs text-gray-400 mb-3">
              Threshold met! {signedCount}/{threshold} signatures collected.
            </p>
            <div className="flex gap-2">
              <button
                onClick={handleDownloadPsbt}
                className="flex-1 flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg bg-green-500/15 text-green-400 border border-green-500/25 hover:bg-green-500/25 transition-colors text-xs font-medium"
              >
                <Download className="w-4 h-4" />
                Download PSBT
              </button>
              <a
                href="https://mempool.space/tx/push"
                target="_blank"
                rel="noopener noreferrer"
                className="flex-1 flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg bg-bitcoin/15 text-bitcoin border border-bitcoin/25 hover:bg-bitcoin/25 transition-colors text-xs font-medium"
              >
                <ExternalLink className="w-4 h-4" />
                Broadcast
              </a>
            </div>
            <div className="mt-3 pt-3 border-t border-green-500/10">
              <p className="text-[10px] text-gray-500 mb-1">Combined PSBT</p>
              <div className="flex items-center gap-2">
                <code className="text-[10px] text-gray-400 font-mono truncate flex-1">
                  {(signedPsbts[0] || request.psbt_hex).slice(0, 48)}...
                </code>
                <button
                  onClick={handleCopyPsbt}
                  className="p-1.5 rounded-lg hover:bg-green-500/15 text-gray-500 hover:text-green-400 transition-colors"
                >
                  {copiedPsbt ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5" />}
                </button>
              </div>
              <a
                href="https://mempool.space/api/tx"
                target="_blank"
                rel="noopener noreferrer"
                className="text-[10px] text-bitcoin hover:underline mt-1 block"
              >
                POST raw tx &rarr; mempool.space/api/tx
              </a>
            </div>
          </div>
        )}

        {/* Expired Banner */}
        {isExpired && (
          <div className="bg-red-500/10 border border-red-500/20 rounded-2xl p-4 mb-4">
            <div className="flex items-center gap-2">
              <AlertTriangle className="w-5 h-5 text-red-400" />
              <span className="text-sm font-medium text-red-400">This signing request has expired</span>
            </div>
          </div>
        )}

        {/* Signature Status */}
        <div className="bg-surface-800 rounded-2xl p-4 border border-surface-200/10 mb-4">
          <div className="flex items-center justify-between mb-3">
            <span className="text-[10px] text-gray-500 uppercase tracking-wider">Signatures</span>
            <span className={`text-sm font-bold ${isReady ? 'text-green-400' : 'text-bitcoin'}`}>
              {signedCount} / {threshold}
            </span>
          </div>

          {/* Progress bar */}
          <div className="w-full h-2 bg-surface-700 rounded-full overflow-hidden mb-3">
            <div
              className={`h-full rounded-full transition-all ${isReady ? 'bg-green-400' : 'bg-bitcoin'}`}
              style={{ width: `${Math.min((signedCount / threshold) * 100, 100)}%` }}
            />
          </div>

          {/* Co-signers list with profile pictures */}
          {coSignerDisplay.length > 0 && (
            <div className="space-y-2">
              {coSignerDisplay.map((cs) => (
                <SignerBadge key={cs.pubkey} pubkey={cs.pubkey} signed={cs.signed} />
              ))}
            </div>
          )}
          {coSignerDisplay.length === 0 && signedCount > 0 && (
            <p className="text-xs text-gray-500">
              {request.signed_count} signature(s) collected before this page was opened
            </p>
          )}
        </div>

        {/* Transaction Details */}
        <div className="bg-surface-800 rounded-2xl p-4 border border-surface-200/10 mb-4 space-y-3">
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
              <p className="text-[10px] text-gray-500 mb-0.5">Total Signers</p>
              <p className="text-sm text-white">{request.total_signers}</p>
            </div>
          </div>

          <div>
            <p className="text-[10px] text-gray-500 mb-0.5">Multi-Sig Address</p>
            <div className="flex items-center gap-1">
              <code className="text-[11px] text-gray-300 font-mono break-all flex-1">
                {request.multisig_address}
              </code>
              <button
                onClick={() => copyToClipboard(request.multisig_address, 'addr')}
                className="p-1 text-gray-500 hover:text-white flex-shrink-0"
              >
                {copied === 'addr' ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3" />}
              </button>
            </div>
          </div>

          <div>
            <p className="text-[10px] text-gray-500 mb-0.5">Round ID</p>
            <code className="text-[11px] text-gray-300 font-mono break-all">{request.round_id}</code>
          </div>

          {request.expires_at > 0 && (
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-gray-500">Expires</span>
              <span className={`text-xs ${isExpired ? 'text-red-400' : 'text-gray-300'}`}>
                {new Date(request.expires_at * 1000).toLocaleString()}
              </span>
            </div>
          )}
        </div>

        {/* View on Mempool */}
        <a
          href={`https://mempool.space/address/${request.multisig_address}`}
          target="_blank"
          rel="noopener noreferrer"
          className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-surface-800 border border-surface-200/10 rounded-2xl text-gray-300 hover:text-white hover:bg-surface-700 transition-colors text-sm mb-4"
        >
          <ExternalLink className="w-4 h-4" />
          View on Mempool
        </a>

        {/* Connect / Sign Section */}
        {!userPubkey ? (
          <div className="bg-surface-800 rounded-2xl p-5 border border-surface-200/10 mb-4 text-center">
            <p className="text-sm text-gray-400 mb-3">Connect your Nostr identity to sign this transaction</p>
            <button
              onClick={handleConnect}
              disabled={connecting}
              className="w-full py-3.5 bg-gradient-to-r from-bitcoin to-bitcoin/80 text-white rounded-xl font-medium text-sm hover:opacity-90 transition-all flex items-center justify-center gap-2"
            >
              {connecting ? (
                <><Loader2 className="w-4 h-4 animate-spin" /> Connecting...</>
              ) : (
                <><LogIn className="w-4 h-4" /> Connect with Nostr</>
              )}
            </button>
            <p className="text-[10px] text-gray-600 mt-2">Requires a NIP-07 browser extension (Alby, nos2x, etc.)</p>
            {error && <p className="text-xs text-red-400 mt-2">{error}</p>}
          </div>
        ) : (
          <div className="bg-surface-800 rounded-2xl p-4 border border-surface-200/10 mb-4">
            <div className="flex items-center gap-2 mb-3">
              <div className="w-2 h-2 rounded-full bg-green-400" />
              <span className="text-xs text-green-400">Connected</span>
              <code className="text-[10px] text-gray-500 font-mono ml-auto">{userPubkey.slice(0, 12)}...{userPubkey.slice(-6)}</code>
            </div>

            {/* Already Signed */}
            {eligibility === 'already_signed' && (
              <div className="flex items-center gap-3 py-3 px-4 bg-green-500/10 border border-green-500/20 rounded-xl">
                <CheckCircle2 className="w-5 h-5 text-green-400 flex-shrink-0" />
                <div>
                  <p className="text-sm font-medium text-green-400">Already Signed</p>
                  <p className="text-[10px] text-gray-400 mt-0.5">Your signature has been published</p>
                </div>
              </div>
            )}

            {/* Not a co-signer */}
            {eligibility === 'not_cosigner' && (
              <div className="flex items-center gap-3 py-3 px-4 bg-red-500/10 border border-red-500/20 rounded-xl">
                <XCircle className="w-5 h-5 text-red-400 flex-shrink-0" />
                <div>
                  <p className="text-sm font-medium text-red-400">Not a co-signer</p>
                  <p className="text-[10px] text-gray-400 mt-0.5">Your key is not part of this multi-sig</p>
                </div>
              </div>
            )}

            {/* Initiator */}
            {eligibility === 'is_initiator' && !signed && (
              <button
                onClick={handleSign}
                disabled={signing || isExpired}
                className="w-full py-3 bg-bitcoin text-white rounded-xl font-medium text-sm hover:bg-bitcoin/90 transition-colors flex items-center justify-center gap-2"
              >
                {signing ? (
                  <><Loader2 className="w-4 h-4 animate-spin" /> Signing &amp; Publishing...</>
                ) : (
                  <><Check className="w-4 h-4" /> Sign Transaction</>
                )}
              </button>
            )}

            {/* Eligible co-signer */}
            {eligibility === 'eligible' && !isExpired && (
              <button
                onClick={handleSign}
                disabled={signing}
                className="w-full py-3 bg-bitcoin text-white rounded-xl font-medium text-sm hover:bg-bitcoin/90 transition-colors flex items-center justify-center gap-2"
              >
                {signing ? (
                  <><Loader2 className="w-4 h-4 animate-spin" /> Signing &amp; Publishing...</>
                ) : (
                  <><Check className="w-4 h-4" /> Sign Transaction</>
                )}
              </button>
            )}
          </div>
        )}

        {/* QR Code */}
        <div className="bg-surface-800 rounded-2xl p-4 border border-surface-200/10 mb-4">
          <div className="flex items-center gap-2 mb-3">
            <QrCode className="w-3.5 h-3.5 text-gray-400" />
            <span className="text-[10px] text-gray-500 uppercase tracking-wider">Share Signing Link</span>
          </div>
          <div className="flex justify-center mb-3">
            <div className="bg-white p-3 rounded-xl">
              <img src={qrCodeUrl} alt="Signing QR Code" width={180} height={180} className="block" />
            </div>
          </div>
          <button
            onClick={() => copyToClipboard(signingUrl, 'url')}
            className="w-full flex items-center gap-2 px-3 py-2 bg-surface-700 rounded-lg hover:bg-surface-600 transition-colors"
          >
            <span className="text-xs text-bitcoin truncate flex-1 font-mono text-left">{signingUrl}</span>
            {copied === 'url' ? <Check className="w-3.5 h-3.5 text-green-400 flex-shrink-0" /> : <Copy className="w-3.5 h-3.5 text-gray-400 flex-shrink-0" />}
          </button>
        </div>

        {/* Footer */}
        <div className="text-center">
          <p className="text-[10px] text-gray-600">
            Powered by Nostr &middot; Event: {requestEvent.id.slice(0, 16)}...
          </p>
        </div>
      </div>
    </div>
  );
}
