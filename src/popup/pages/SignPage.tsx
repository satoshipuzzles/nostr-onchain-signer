import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import {
  Loader2, Check, Copy, ExternalLink, Shield,
  CheckCircle2, Download, AlertTriangle, Clock, LogIn, XCircle,
  Radio, PartyPopper,
} from 'lucide-react';
import { CUSTOM_KIND, type SigningRequestContent, type SigningResponseContent } from '@/lib/nostr/kinds';
import { getCachedProfile } from '@/lib/nostr/cache';
import { safeImageUrl } from '@/lib/utils';
import type { ProfileMetadata } from '@/lib/nostr/social';
import { isSigningExpired } from '@/lib/nostr/signing-inbox';
import { queryPublicEvents, publishPublicEvent, appOrigin } from '@/lib/nostr/public-relay';
import { broadcastPsbts } from '@/lib/bitcoin/psbt-broadcast';
import { formatSats } from '@/lib/bitcoin/mempool';
import { QRCode } from '@/popup/components/QRCode';
import { fireConfetti } from '@/lib/ui/publish-feedback';

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

/** Get the connected pubkey: app session (extension/PWA) first, then window.nostr */
async function getConnectedPubkey(): Promise<string | null> {
  try {
    if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
      const resp = await chrome.runtime.sendMessage({
        type: 'nip07:getPublicKey',
        id: `sign_pk_${Date.now()}`,
      });
      if (resp?.result && typeof resp.result === 'string') return resp.result;
    }
  } catch { /* fall through */ }

  try {
    const nostr = (window as any).nostr;
    if (nostr?.getPublicKey) return await nostr.getPublicKey();
  } catch { /* fall through */ }

  return null;
}

/** Sign a Nostr event: app session first, then window.nostr */
async function signNostrEvent(event: object): Promise<NostrEvent | null> {
  try {
    if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
      const resp = await chrome.runtime.sendMessage({
        type: 'nip07:signEvent',
        payload: { event },
        id: `sign_evt_${Date.now()}`,
      });
      if (!resp?.error && resp?.result?.id) return resp.result as NostrEvent;
    }
  } catch { /* fall through */ }

  try {
    const nostr = (window as any).nostr;
    if (nostr?.signEvent) {
      const signed = await nostr.signEvent(event);
      if (signed?.id) return signed as NostrEvent;
    }
  } catch { /* fall through */ }

  return null;
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
  const [broadcasting, setBroadcasting] = useState(false);
  const [broadcastTxid, setBroadcastTxid] = useState('');
  const [broadcastError, setBroadcastError] = useState('');
  const [coSignerPubkeys, setCoSignerPubkeys] = useState<string[]>([]);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (roundId) fetchSigningRequest(roundId);
    // Auto-connect using the app session if available (no click needed)
    getConnectedPubkey().then((pk) => { if (pk) setUserPubkey(pk); });
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [roundId]);

  useEffect(() => {
    if (userPubkey && signers.some((s) => s.pubkey === userPubkey && s.signed)) {
      setSigned(true);
    }
  }, [userPubkey, signers]);

  async function fetchSigningRequest(rid: string) {
    setLoading(true);
    setError('');

    const events = await queryPublicEvents({
      kinds: [CUSTOM_KIND.SIGNING_REQUEST],
      '#r': [rid],
      limit: 20,
    });

    // CRITICAL: verify the events actually belong to this round. Some relays
    // ignore the #r filter and return unrelated kind-9800 events, which used
    // to make this page show a random transaction.
    const matching = events.filter((e) => {
      if (!e.tags.some((t) => t[0] === 'r' && t[1] === rid)) return false;
      try {
        const c = JSON.parse(e.content);
        return c.round_id === rid;
      } catch {
        return false;
      }
    });

    if (matching.length === 0) {
      setError('Signing request not found on relays. The initiator may need to re-share the link, or try again in a moment.');
      setLoading(false);
      return;
    }

    const foundEvent = matching.sort((a, b) => b.created_at - a.created_at)[0];
    setRequestEvent(foundEvent);

    let parsed: SigningRequestContent;
    try {
      parsed = JSON.parse(foundEvent.content);
      if (!parsed.psbt_hex || !parsed.round_id || !parsed.multisig_address) {
        setError('Invalid signing request data');
        setLoading(false);
        return;
      }
    } catch {
      setError('Failed to parse signing request');
      setLoading(false);
      return;
    }
    setRequest(parsed);

    // Eligibility list: signer_pubkeys from content (authoritative), plus
    // p tags from ALL matching events (per-signer requests), plus the author.
    // Previously only the newest event's p tags were used — the public anchor
    // event has none, so co-signers randomly saw "Not a co-signer".
    const allPubkeys = new Set<string>([foundEvent.pubkey]);
    for (const pk of parsed.signer_pubkeys ?? []) allPubkeys.add(pk);
    for (const evt of matching) {
      evt.tags.filter((t) => t[0] === 'p' && t[1]).forEach((t) => allPubkeys.add(t[1]));
    }
    setCoSignerPubkeys(Array.from(allPubkeys));

    await loadResponses(rid, parsed, foundEvent);
    setLoading(false);

    // Poll for new signatures every 10s so progress updates live
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(() => {
      loadResponses(rid, parsed, foundEvent).catch(() => {});
    }, 10_000);
  }

  const loadResponses = useCallback(async (rid: string, req: SigningRequestContent, event: NostrEvent) => {
    const collected: SignerInfo[] = [];
    const psbts: string[] = [];

    if (req.signed_count > 0) {
      collected.push({ pubkey: event.pubkey, signed: true, psbtHex: req.psbt_hex });
    }

    const responseEvents = await queryPublicEvents({
      kinds: [CUSTOM_KIND.SIGNING_RESPONSE],
      '#r': [rid],
      limit: 50,
    });

    for (const evt of responseEvents) {
      try {
        const content: SigningResponseContent = JSON.parse(evt.content);
        // Verify round id in content — same broken-relay protection as above
        if (content.round_id !== rid || !content.accepted) continue;
        if (collected.some((s) => s.pubkey === evt.pubkey)) continue;
        collected.push({ pubkey: evt.pubkey, signed: true, psbtHex: content.psbt_hex });
        if (content.psbt_hex) psbts.push(content.psbt_hex);
      } catch { /* malformed */ }
    }

    setSigners(collected);
    setSignedPsbts(psbts);
  }, []);

  async function handleConnect() {
    setConnecting(true);
    setError('');
    try {
      const pk = await getConnectedPubkey();
      if (!pk) {
        setError('No signer found. Log into the Nostr Onchain app, or install a NIP-07 extension (Alby, nos2x).');
        return;
      }
      setUserPubkey(pk);
    } catch (err) {
      console.error('Connect failed:', err);
    } finally {
      setConnecting(false);
    }
  }

  function getSignEligibility(): 'eligible' | 'not_cosigner' | 'already_signed' {
    if (!userPubkey || !requestEvent) return 'eligible';
    if (signed) return 'already_signed';
    if (signers.some((s) => s.pubkey === userPubkey && s.signed)) return 'already_signed';
    if (!coSignerPubkeys.includes(userPubkey)) return 'not_cosigner';
    return 'eligible';
  }

  async function handleSign() {
    if (!requestEvent || !request || !roundId) return;

    setSigning(true);
    try {
      let pubkey = userPubkey;
      if (!pubkey) {
        pubkey = (await getConnectedPubkey()) ?? '';
        if (!pubkey) throw new Error('Connect a Nostr signer first');
        setUserPubkey(pubkey);
      }

      // Partial-sign the PSBT: app vault first, then the user's existing
      // NIP-07 signer via signSchnorr (works like signing a Nostr event —
      // no nsec needed), then any injected window.bitcoin provider.
      const { partialSignPsbt } = await import('@/lib/bitcoin/psbt-partial-sign');
      const signResult = await partialSignPsbt(request.psbt_hex, pubkey);
      const signedPsbt = signResult.psbtHex;

      const responseEvent = {
        kind: CUSTOM_KIND.SIGNING_RESPONSE,
        content: JSON.stringify({
          round_id: request.round_id,
          psbt_hex: signedPsbt,
          accepted: true,
          message: 'Signed via signing page',
        } satisfies SigningResponseContent),
        tags: [
          ['p', requestEvent.pubkey],
          ['r', request.round_id],
          ['e', requestEvent.id],
        ],
        created_at: Math.floor(Date.now() / 1000),
      };

      const signedEvent = await signNostrEvent(responseEvent);
      if (!signedEvent?.id) throw new Error('Signing was cancelled');

      const pubResult = await publishPublicEvent(signedEvent as any);
      if (!pubResult.ok) throw new Error(pubResult.error || 'Failed to publish signature');

      setSigned(true);
      setSigners((prev) => [...prev, { pubkey, signed: true, psbtHex: signedPsbt }]);
      setSignedPsbts((prev) => [...prev, signedPsbt]);
      fireConfetti(1800);

      // If threshold reached, notify the initiator with the broadcast link
      const newSignedCount = signers.filter((s) => s.signed).length + 1;
      if (newSignedCount >= (request.threshold ?? 2) && pubkey !== requestEvent.pubkey) {
        try {
          const { sendDM } = await import('@/lib/nostr/dm');
          const url = `${window.location.origin}/sign/${roundId}`;
          await sendDM(
            pubkey,
            requestEvent.pubkey,
            `✅ Your multisig transaction "${request.memo || request.round_id.slice(0, 8)}" has all ${request.threshold} signatures and is ready to broadcast!\n\nOpen and hit Broadcast: ${url}`,
          );
        } catch { /* best-effort */ }
      }
    } catch (err) {
      alert(`Signing failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setSigning(false);
    }
  }

  async function handleBroadcast() {
    if (!request) return;
    setBroadcasting(true);
    setBroadcastError('');
    try {
      const allPsbts = [request.psbt_hex, ...signedPsbts];
      const txid = await broadcastPsbts(allPsbts);
      setBroadcastTxid(txid);
      fireConfetti(3000);
    } catch (err) {
      setBroadcastError(err instanceof Error ? err.message : 'Broadcast failed');
    } finally {
      setBroadcasting(false);
    }
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

  const signingUrl = `${appOrigin()}/sign/${roundId}`;
  const signedCount = signers.filter((s) => s.signed).length;
  const threshold = request?.threshold ?? 0;
  const isReady = threshold > 0 && signedCount >= threshold;
  const isExpired = request?.expires_at ? isSigningExpired(request.expires_at) : false;
  const eligibility = getSignEligibility();
  const isInitiator = userPubkey && requestEvent && userPubkey === requestEvent.pubkey;

  const coSignerDisplay: { pubkey: string; signed: boolean }[] = coSignerPubkeys.map((pk) => ({
    pubkey: pk,
    signed: signers.some((s) => s.pubkey === pk && s.signed),
  }));
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

  if (!request || !requestEvent) {
    return (
      <div className="min-h-screen bg-surface-900 flex items-center justify-center p-4">
        <div className="text-center">
          <Loader2 className="w-8 h-8 animate-spin text-bitcoin mx-auto mb-3" />
          <p className="text-gray-400 text-sm">Loading signing request...</p>
        </div>
      </div>
    );
  }

  // Broadcast success takeover
  if (broadcastTxid) {
    return (
      <div className="min-h-screen bg-surface-900 flex items-center justify-center p-4">
        <div className="w-full max-w-md text-center">
          <div className="w-16 h-16 rounded-full bg-green-500/20 flex items-center justify-center mx-auto mb-4">
            <PartyPopper className="w-8 h-8 text-green-400" />
          </div>
          <h1 className="text-xl font-bold text-white mb-2">Transaction Broadcast!</h1>
          <p className="text-gray-400 text-sm mb-4">Your multisig spend is on its way to the Bitcoin network.</p>
          <div className="bg-surface-800 rounded-xl p-3 border border-surface-200/10 mb-4">
            <p className="text-[10px] text-gray-500 mb-1 uppercase tracking-wide">Txid</p>
            <div className="flex items-center gap-2">
              <code className="text-[11px] text-gray-300 font-mono break-all flex-1">{broadcastTxid}</code>
              <button onClick={() => copyToClipboard(broadcastTxid, 'txid')} className="p-1.5 hover:bg-surface-700 rounded-lg">
                {copied === 'txid' ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5 text-gray-500" />}
              </button>
            </div>
          </div>
          <a
            href={`https://mempool.space/tx/${broadcastTxid}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 px-4 py-3 bg-bitcoin text-white rounded-xl text-sm font-medium hover:bg-bitcoin/90 transition-colors"
          >
            <ExternalLink className="w-4 h-4" />
            View on Mempool
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-surface-900 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        {/* Header */}
        <div className="text-center mb-6">
          <div className="w-14 h-14 rounded-full bg-gradient-to-br from-bitcoin/40 to-nostr/30 flex items-center justify-center mx-auto mb-3">
            <Shield className="w-7 h-7 text-white/80" />
          </div>
          <h1 className="text-xl font-bold text-white">Multi-Sig Spend</h1>
          {request.memo && <p className="text-gray-300 text-sm mt-1">{request.memo}</p>}
          {request.amount_sats ? (
            <p className="text-bitcoin text-lg font-bold mt-1">{formatSats(request.amount_sats)} sats</p>
          ) : null}
        </div>

        {/* Big progress */}
        <div className="bg-surface-800 rounded-2xl p-4 border border-surface-200/10 mb-4">
          <div className="flex items-center justify-between mb-3">
            <span className="text-[10px] text-gray-500 uppercase tracking-wider">Signatures</span>
            <span className={`text-sm font-bold ${isReady ? 'text-green-400' : 'text-bitcoin'}`}>
              {signedCount} / {threshold}
            </span>
          </div>
          <div className="w-full h-2 bg-surface-700 rounded-full overflow-hidden mb-3">
            <div
              className={`h-full rounded-full transition-all ${isReady ? 'bg-green-400' : 'bg-bitcoin'}`}
              style={{ width: `${Math.min((signedCount / Math.max(threshold, 1)) * 100, 100)}%` }}
            />
          </div>
          {coSignerDisplay.length > 0 && (
            <div className="space-y-2">
              {coSignerDisplay.map((cs) => (
                <SignerBadge key={cs.pubkey} pubkey={cs.pubkey} signed={cs.signed} />
              ))}
            </div>
          )}
        </div>

        {/* PRIMARY ACTION — one clear next step */}
        {isExpired ? (
          <div className="bg-red-500/10 border border-red-500/20 rounded-2xl p-4 mb-4 flex items-center gap-2">
            <AlertTriangle className="w-5 h-5 text-red-400" />
            <span className="text-sm font-medium text-red-400">This signing request has expired</span>
          </div>
        ) : isReady ? (
          <div className="bg-green-500/10 border border-green-500/20 rounded-2xl p-4 mb-4">
            <div className="flex items-center gap-2 mb-2">
              <CheckCircle2 className="w-5 h-5 text-green-400" />
              <span className="text-sm font-semibold text-green-400">All signatures collected!</span>
            </div>
            <p className="text-xs text-gray-400 mb-3">
              Anyone can now broadcast this transaction to the Bitcoin network.
            </p>
            <button
              onClick={handleBroadcast}
              disabled={broadcasting}
              className="w-full py-3.5 bg-green-500 text-black rounded-xl font-bold text-sm hover:bg-green-400 transition-colors flex items-center justify-center gap-2 mb-2"
            >
              {broadcasting ? (
                <><Loader2 className="w-4 h-4 animate-spin" /> Broadcasting...</>
              ) : (
                <><Radio className="w-4 h-4" /> Broadcast Transaction</>
              )}
            </button>
            {broadcastError && (
              <p className="text-xs text-red-400 mt-1 mb-2">{broadcastError}</p>
            )}
            <div className="flex gap-2">
              <button
                onClick={handleDownloadPsbt}
                className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-surface-700 text-gray-300 hover:bg-surface-600 transition-colors text-xs"
              >
                <Download className="w-3.5 h-3.5" /> PSBT
              </button>
              <button
                onClick={handleCopyPsbt}
                className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-surface-700 text-gray-300 hover:bg-surface-600 transition-colors text-xs"
              >
                {copiedPsbt ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5" />} Copy PSBT
              </button>
            </div>
          </div>
        ) : !userPubkey ? (
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
            <p className="text-[10px] text-gray-600 mt-2">Works with the Nostr Onchain app or any NIP-07 extension</p>
            {error && <p className="text-xs text-red-400 mt-2">{error}</p>}
          </div>
        ) : (
          <div className="bg-surface-800 rounded-2xl p-4 border border-surface-200/10 mb-4">
            <div className="flex items-center gap-2 mb-3">
              <div className="w-2 h-2 rounded-full bg-green-400" />
              <span className="text-xs text-green-400">Connected{isInitiator ? ' (initiator)' : ''}</span>
              <code className="text-[10px] text-gray-500 font-mono ml-auto">{userPubkey.slice(0, 12)}...{userPubkey.slice(-6)}</code>
            </div>

            {eligibility === 'already_signed' && (
              <div className="flex items-center gap-3 py-3 px-4 bg-green-500/10 border border-green-500/20 rounded-xl">
                <CheckCircle2 className="w-5 h-5 text-green-400 flex-shrink-0" />
                <div>
                  <p className="text-sm font-medium text-green-400">You signed ✓</p>
                  <p className="text-[10px] text-gray-400 mt-0.5">
                    Waiting for {Math.max(threshold - signedCount, 0)} more signature{threshold - signedCount !== 1 ? 's' : ''}.
                    Share the link below with co-signers.
                  </p>
                </div>
              </div>
            )}

            {eligibility === 'not_cosigner' && (
              <div className="flex items-center gap-3 py-3 px-4 bg-red-500/10 border border-red-500/20 rounded-xl">
                <XCircle className="w-5 h-5 text-red-400 flex-shrink-0" />
                <div>
                  <p className="text-sm font-medium text-red-400">Not a co-signer</p>
                  <p className="text-[10px] text-gray-400 mt-0.5">
                    Your connected key isn't part of this multi-sig. If you should be, switch to the correct account and reload.
                  </p>
                </div>
              </div>
            )}

            {eligibility === 'eligible' && (
              <button
                onClick={handleSign}
                disabled={signing}
                className="w-full py-3.5 bg-bitcoin text-white rounded-xl font-bold text-sm hover:bg-bitcoin/90 transition-colors flex items-center justify-center gap-2"
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

        {/* Transaction details (compact) */}
        <div className="bg-surface-800 rounded-2xl p-4 border border-surface-200/10 mb-4 space-y-3">
          <span className="text-[10px] text-gray-500 uppercase tracking-wider">Details</span>
          {request.recipient && (
            <div>
              <p className="text-[10px] text-gray-500 mb-0.5">Sending to</p>
              <code className="text-[11px] text-gray-300 font-mono break-all">{request.recipient}</code>
            </div>
          )}
          <div>
            <p className="text-[10px] text-gray-500 mb-0.5">From multi-sig ({request.threshold} of {request.total_signers})</p>
            <div className="flex items-center gap-1">
              <code className="text-[11px] text-gray-300 font-mono break-all flex-1">{request.multisig_address}</code>
              <button
                onClick={() => copyToClipboard(request.multisig_address, 'addr')}
                className="p-1 text-gray-500 hover:text-white flex-shrink-0"
              >
                {copied === 'addr' ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3" />}
              </button>
            </div>
          </div>
          {request.expires_at > 0 && (
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-gray-500">Expires</span>
              <span className={`text-xs ${isExpired ? 'text-red-400' : 'text-gray-300'}`}>
                {new Date(request.expires_at * 1000).toLocaleString()}
              </span>
            </div>
          )}
          <a
            href={`https://mempool.space/address/${request.multisig_address}`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 text-[11px] text-gray-500 hover:text-bitcoin transition-colors"
          >
            <ExternalLink className="w-3 h-3" /> View address on mempool.space
          </a>
        </div>

        {/* Share */}
        <div className="bg-surface-800 rounded-2xl p-4 border border-surface-200/10 mb-4">
          <span className="text-[10px] text-gray-500 uppercase tracking-wider block mb-3">Share with co-signers</span>
          <div className="flex justify-center mb-3">
            <QRCode data={signingUrl} size={160} />
          </div>
          <button
            onClick={() => copyToClipboard(signingUrl, 'url')}
            className="w-full flex items-center gap-2 px-3 py-2.5 bg-surface-700 rounded-lg hover:bg-surface-600 transition-colors"
          >
            <span className="text-xs text-bitcoin truncate flex-1 font-mono text-left">{signingUrl}</span>
            {copied === 'url' ? <Check className="w-3.5 h-3.5 text-green-400 flex-shrink-0" /> : <Copy className="w-3.5 h-3.5 text-gray-400 flex-shrink-0" />}
          </button>
        </div>

        <div className="text-center">
          <p className="text-[10px] text-gray-600">
            Powered by Nostr &middot; Round: {roundId?.slice(0, 12)}...
          </p>
        </div>
      </div>
    </div>
  );
}
