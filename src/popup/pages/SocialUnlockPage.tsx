import { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { Lock, Unlock, Users, ExternalLink, Check, LogIn, CheckCircle2, XCircle, Loader2 } from 'lucide-react';
import { loadRelayList, getReadRelays } from '@/lib/nostr/relays';
import {
  decryptContent,
  parseSocialUnlockContent,
  parseSocialUnlockSignContent,
  parseSocialUnlockRevealContent,
  type SocialUnlockContent,
} from '@/lib/nostr/social-unlock';
import { CUSTOM_KIND } from '@/lib/nostr/kinds';
import { getCachedProfile, cacheProfiles } from '@/lib/nostr/cache';
import { safeImageUrl } from '@/lib/utils';
import type { ProfileMetadata } from '@/lib/nostr/social';
import { ClickableAvatar } from '@/popup/components/ClickableAvatar';

interface Signature {
  pubkey: string;
  message?: string;
}

interface RevealData {
  decryption_key: string;
  revealed_at: number;
}

const PROFILE_RELAYS = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.nostr.band', 'wss://purplepag.es'];

function fetchProfileFromRelay(relayUrl: string, pubkey: string): Promise<ProfileMetadata | null> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => { ws.close(); resolve(null); }, 5000);
    let ws: WebSocket;
    try { ws = new WebSocket(relayUrl); } catch { clearTimeout(timeout); resolve(null); return; }
    const subId = Math.random().toString(36).slice(2, 8);

    ws.onopen = () => {
      ws.send(JSON.stringify(['REQ', subId, { kinds: [0], authors: [pubkey], limit: 1 }]));
    };

    ws.onmessage = (msg) => {
      try {
        const data = JSON.parse(msg.data);
        if (data[0] === 'EVENT' && data[2]) {
          clearTimeout(timeout);
          ws.close();
          const content = JSON.parse(data[2].content);
          resolve({
            pubkey,
            name: content.name,
            displayName: content.display_name || content.displayName,
            picture: content.picture,
            banner: content.banner,
            about: content.about,
            nip05: content.nip05,
            lud16: content.lud16,
            website: content.website,
          });
        } else if (data[0] === 'EOSE') {
          clearTimeout(timeout);
          ws.close();
          resolve(null);
        }
      } catch { clearTimeout(timeout); ws.close(); resolve(null); }
    };

    ws.onerror = () => { clearTimeout(timeout); resolve(null); };
  });
}

async function resolveProfile(pubkey: string): Promise<ProfileMetadata | null> {
  const cached = await getCachedProfile(pubkey);
  if (cached && (cached.name || cached.displayName || cached.picture)) return cached;

  for (const relayUrl of PROFILE_RELAYS) {
    try {
      const profile = await fetchProfileFromRelay(relayUrl, pubkey);
      if (profile && (profile.name || profile.displayName || profile.picture)) {
        const map = new Map<string, ProfileMetadata>();
        map.set(pubkey, profile);
        await cacheProfiles(map);
        return profile;
      }
    } catch {}
  }
  return cached ?? null;
}

function useResolvedProfile(pubkey: string) {
  const [profile, setProfile] = useState<ProfileMetadata | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    resolveProfile(pubkey).then((p) => {
      if (!cancelled) {
        setProfile(p);
        setLoading(false);
      }
    });
    return () => { cancelled = true; };
  }, [pubkey]);

  return { profile, loading };
}

function PageSignerBadge({ pubkey }: { pubkey: string }) {
  const { profile, loading } = useResolvedProfile(pubkey);

  if (loading) {
    return (
      <div className="flex items-center gap-3 py-2">
        <div className="w-8 h-8 rounded-full bg-surface-700 animate-pulse" />
        <div className="flex-1 min-w-0">
          <div className="h-4 w-24 bg-surface-700 rounded animate-pulse" />
        </div>
        <span className="text-xs text-green-400">✓ Signed</span>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-3 py-2">
      <ClickableAvatar pubkey={pubkey} picture={profile?.picture} name={profile?.displayName || profile?.name} size="md" />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium truncate">{profile?.displayName || profile?.name || pubkey.slice(0, 12) + '...'}</p>
        {profile?.nip05 && <p className="text-xs text-nostr/70 truncate">{profile.nip05}</p>}
      </div>
      <span className="text-xs text-green-400">✓ Signed</span>
    </div>
  );
}

function CreatorProfile({ pubkey }: { pubkey: string }) {
  const { profile, loading } = useResolvedProfile(pubkey);

  if (loading) {
    return (
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-full bg-surface-700 animate-pulse flex-shrink-0" />
        <div className="min-w-0">
          <div className="h-4 w-28 bg-surface-700 rounded animate-pulse mb-1" />
          <div className="h-3 w-20 bg-surface-700 rounded animate-pulse" />
        </div>
      </div>
    );
  }

  const name = profile?.displayName || profile?.name || pubkey.slice(0, 8) + '...';
  return (
    <div className="flex items-center gap-3">
      <ClickableAvatar pubkey={pubkey} picture={profile?.picture} name={name} size="xl" />
      <div className="min-w-0">
        <p className="text-sm font-medium truncate">{name}</p>
        {profile?.nip05 && <p className="text-[10px] text-nostr/70 truncate">{profile.nip05}</p>}
      </div>
    </div>
  );
}

const DEFAULT_RELAYS = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.snort.social'];

export function SocialUnlockPage() {
  const { eventId } = useParams<{ eventId: string }>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [content, setContent] = useState<SocialUnlockContent | null>(null);
  const [creatorPubkey, setCreatorPubkey] = useState<string>('');
  const [signatures, setSignatures] = useState<Signature[]>([]);
  const [reveal, setReveal] = useState<RevealData | null>(null);
  const [revealedContent, setRevealedContent] = useState<string | null>(null);
  const [connectedPubkey, setConnectedPubkey] = useState<string | null>(null);
  const [signing, setSigning] = useState(false);
  const [hasSigned, setHasSigned] = useState(false);
  const [signSuccess, setSignSuccess] = useState(false);
  const [signError, setSignError] = useState<string | null>(null);

  useEffect(() => {
    if (eventId) fetchUnlockEvent(eventId);
  }, [eventId]);

  useEffect(() => {
    if (reveal && content) {
      decryptContent(content.encrypted_content, reveal.decryption_key)
        .then(setRevealedContent)
        .catch(() => setRevealedContent('[Failed to decrypt]'));
    }
  }, [reveal, content]);

  useEffect(() => {
    if (connectedPubkey && signatures.length > 0) {
      setHasSigned(signatures.some((s) => s.pubkey === connectedPubkey));
    }
  }, [connectedPubkey, signatures]);

  async function fetchUnlockEvent(id: string) {
    setLoading(true);
    setError(null);

    try {
      const relayList = await loadRelayList();
      const readRelays = getReadRelays(relayList);

      if (readRelays.length === 0) {
        readRelays.push(...DEFAULT_RELAYS);
      }

      const result = await fetchFromRelays(readRelays, id);
      if (!result) {
        setError('Event not found on relays');
        return;
      }

      setContent(result.content);
      setCreatorPubkey(result.pubkey);
      setSignatures(result.signatures);
      if (result.reveal) setReveal(result.reveal);
    } catch (err) {
      setError('Failed to fetch event');
    } finally {
      setLoading(false);
    }
  }

  async function handleConnect() {
    try {
      if ((window as any).nostr?.getPublicKey) {
        const pk = await (window as any).nostr.getPublicKey();
        setConnectedPubkey(pk);
      } else {
        setSignError('No NIP-07 extension found. Install Alby, nos2x, or another Nostr signer extension.');
      }
    } catch (err) {
      console.error('NIP-07 connect failed:', err);
      setSignError('Failed to connect. Please try again.');
    }
  }

  function getEligibility(): 'eligible' | 'not_eligible' | 'already_signed' | 'is_creator' {
    if (!connectedPubkey || !content) return 'eligible';
    if (connectedPubkey === creatorPubkey) return 'is_creator';
    if (hasSigned || signSuccess) return 'already_signed';
    if (content.allowed_pubkeys && content.allowed_pubkeys.length > 0) {
      if (!content.allowed_pubkeys.includes(connectedPubkey)) return 'not_eligible';
    }
    return 'eligible';
  }

  async function handleSign() {
    if (!eventId || !connectedPubkey || !content) return;
    setSigning(true);
    setSignError(null);

    try {
      const nostr = (window as any).nostr;
      if (!nostr) throw new Error('NIP-07 extension not found');

      const signContent = JSON.stringify({
        unlock_event_id: eventId,
        message: 'Signed via public unlock page',
      });

      const event = {
        kind: CUSTOM_KIND.SOCIAL_UNLOCK_SIGN,
        content: signContent,
        tags: [
          ['e', eventId],
          ['p', creatorPubkey],
        ],
        created_at: Math.floor(Date.now() / 1000),
      };

      const signedEvent = await nostr.signEvent(event);
      if (!signedEvent) throw new Error('Signing was cancelled');

      await publishToRelays(signedEvent);

      setSignatures((prev) => {
        if (prev.some((s) => s.pubkey === connectedPubkey)) return prev;
        return [...prev, { pubkey: connectedPubkey, message: 'Signed via public unlock page' }];
      });
      setHasSigned(true);
      setSignSuccess(true);
    } catch (err) {
      setSignError(err instanceof Error ? err.message : 'Signing failed');
    } finally {
      setSigning(false);
    }
  }

  async function publishToRelays(event: any): Promise<void> {
    const relayList = await loadRelayList();
    const writeRelays = getReadRelays(relayList);
    const relayUrls = writeRelays.length > 0 ? writeRelays.slice(0, 3) : DEFAULT_RELAYS;

    const promises = relayUrls.map((relayUrl) =>
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

  if (loading) {
    return (
      <div className="min-h-screen bg-black flex items-center justify-center">
        <div className="text-center">
          <Loader2 className="w-8 h-8 animate-spin text-nostr mx-auto mb-3" />
          <p className="text-gray-500 text-sm">Loading social unlock...</p>
        </div>
      </div>
    );
  }

  if (error || !content) {
    return (
      <div className="min-h-screen bg-black flex flex-col items-center justify-center p-6 text-center">
        <Lock className="w-12 h-12 text-gray-600 mb-4" />
        <p className="text-sm text-gray-400">{error || 'Content not found'}</p>
      </div>
    );
  }

  const progress = signatures.length / content.threshold;
  const isUnlocked = signatures.length >= content.threshold;
  const eligibility = getEligibility();

  return (
    <div className="min-h-screen bg-black text-white p-4 md:p-8 pb-24">
      <div className="max-w-lg mx-auto">
        {/* Hero Header */}
        <div className="text-center mb-6">
          <div className={`w-16 h-16 rounded-2xl mx-auto mb-4 flex items-center justify-center ${
            isUnlocked ? 'bg-green-500/15' : 'bg-white/5'
          }`}>
            {isUnlocked ? (
              <Unlock className="w-8 h-8 text-green-400" />
            ) : (
              <Lock className="w-8 h-8 text-gray-500" />
            )}
          </div>
          <h1 className="text-xl font-bold mb-1">{content.title}</h1>
          {content.description && (
            <p className="text-sm text-gray-400">{content.description}</p>
          )}
        </div>

        {/* Progress */}
        <div className="card mb-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs text-gray-400 flex items-center gap-1.5">
              <Users className="w-3.5 h-3.5" />
              Signatures
            </span>
            <span className={`text-sm font-medium ${isUnlocked ? 'text-green-400' : ''}`}>
              {signatures.length} / {content.threshold}
            </span>
          </div>
          <div className="h-2.5 bg-white/5 rounded-full overflow-hidden">
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
          <div className="flex items-center justify-between mt-1.5">
            <span className="text-[10px] text-gray-600">{content.total_slots} total slots</span>
            <span className="text-[10px] text-gray-600">{content.content_type} content</span>
          </div>
        </div>

        {/* Creator */}
        {creatorPubkey && (
          <div className="card mb-4">
            <p className="text-xs text-gray-400 mb-2">Creator</p>
            <CreatorProfile pubkey={creatorPubkey} />
          </div>
        )}

        {/* Signers */}
        {signatures.length > 0 && (
          <div className="card mb-4">
            <p className="text-xs text-gray-400 mb-2">Signers ({signatures.length})</p>
            <div className="space-y-1 max-h-48 overflow-y-auto">
              {signatures.map((sig, i) => (
                <PageSignerBadge key={i} pubkey={sig.pubkey} />
              ))}
            </div>
          </div>
        )}

        {/* Revealed content or locked state */}
        {isUnlocked && revealedContent ? (
          <div className="card border-green-500/20 animate-[scale-in_0.3s_ease-out] mb-4">
            <div className="flex items-center gap-2 mb-3">
              <Unlock className="w-4 h-4 text-green-400" />
              <span className="text-xs font-medium text-green-400">Content Unlocked</span>
            </div>
            {content.content_type === 'image' ? (
              <img src={revealedContent} alt="Revealed" className="w-full rounded-lg max-h-80 object-contain bg-surface-900" />
            ) : content.content_type === 'link' ? (
              <a
                href={revealedContent}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2 text-sm text-blue-400 hover:text-blue-300 break-all"
              >
                <ExternalLink className="w-4 h-4 flex-shrink-0" />
                {revealedContent}
              </a>
            ) : (
              <p className="text-sm text-gray-200 whitespace-pre-wrap">{revealedContent}</p>
            )}
          </div>
        ) : !isUnlocked ? (
          <div className="card text-center mb-4">
            <Lock className="w-8 h-8 text-gray-600 mx-auto mb-2" />
            <p className="text-sm text-gray-400 mb-1">Content is locked</p>
            <p className="text-xs text-gray-600">
              {content.threshold - signatures.length} more signature{content.threshold - signatures.length !== 1 ? 's' : ''} needed to unlock
            </p>
          </div>
        ) : (
          <div className="card text-center mb-4">
            <p className="text-sm text-gray-400">Threshold met. Waiting for creator to publish reveal.</p>
          </div>
        )}

        {/* Connect / Sign Section */}
        {!connectedPubkey ? (
          <div className="card text-center">
            <p className="text-sm text-gray-400 mb-3">
              {isUnlocked ? 'Connect to verify your identity' : 'Want to help unlock this content?'}
            </p>
            <button
              onClick={handleConnect}
              className="btn-primary w-full flex items-center justify-center gap-2 py-3"
            >
              <LogIn className="w-4 h-4" />
              Connect with Nostr
            </button>
            <p className="text-[10px] text-gray-600 mt-2">Requires a NIP-07 browser extension (Alby, nos2x, etc.)</p>
            {signError && (
              <p className="text-xs text-red-400 mt-2">{signError}</p>
            )}
          </div>
        ) : (
          <div className="card">
            <div className="flex items-center gap-2 mb-3">
              <div className="w-2 h-2 rounded-full bg-green-400" />
              <span className="text-xs text-green-400">Connected</span>
              <code className="text-[10px] text-gray-500 font-mono ml-auto">{connectedPubkey.slice(0, 12)}...{connectedPubkey.slice(-6)}</code>
            </div>

            {/* Sign Success */}
            {(eligibility === 'already_signed') && (
              <div className="flex items-center gap-3 py-3 px-4 bg-green-500/10 border border-green-500/20 rounded-xl">
                <CheckCircle2 className="w-5 h-5 text-green-400 flex-shrink-0" />
                <div>
                  <p className="text-sm font-medium text-green-400">You've already signed!</p>
                  <p className="text-[10px] text-gray-400 mt-0.5">Your signature has been recorded</p>
                </div>
              </div>
            )}

            {/* Creator view */}
            {eligibility === 'is_creator' && (
              <div className="flex items-center gap-3 py-3 px-4 bg-nostr/10 border border-nostr/20 rounded-xl">
                <Users className="w-5 h-5 text-nostr flex-shrink-0" />
                <div>
                  <p className="text-sm font-medium text-nostr">You created this unlock</p>
                  <p className="text-[10px] text-gray-400 mt-0.5">Share the link for others to sign</p>
                </div>
              </div>
            )}

            {/* Not eligible */}
            {eligibility === 'not_eligible' && (
              <div className="flex items-center gap-3 py-3 px-4 bg-red-500/10 border border-red-500/20 rounded-xl">
                <XCircle className="w-5 h-5 text-red-400 flex-shrink-0" />
                <div>
                  <p className="text-sm font-medium text-red-400">You're not eligible to sign this unlock</p>
                  <p className="text-[10px] text-gray-400 mt-0.5">Only selected users can sign</p>
                </div>
              </div>
            )}

            {/* Eligible to sign */}
            {eligibility === 'eligible' && !isUnlocked && (
              <>
                <button
                  onClick={handleSign}
                  disabled={signing}
                  className="w-full py-3 bg-gradient-to-r from-nostr to-nostr/80 text-white rounded-xl font-medium text-sm hover:opacity-90 transition-all flex items-center justify-center gap-2"
                >
                  {signing ? (
                    <><Loader2 className="w-4 h-4 animate-spin" /> Signing &amp; Publishing...</>
                  ) : (
                    <><Lock className="w-4 h-4" /> Sign to Unlock</>
                  )}
                </button>
                {signError && (
                  <p className="text-xs text-red-400 mt-2 text-center">{signError}</p>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Relay Fetch ────────────────────────────────────────────────

interface FetchResult {
  content: SocialUnlockContent;
  pubkey: string;
  signatures: Signature[];
  reveal?: RevealData;
}

async function fetchFromRelays(relayUrls: string[], eventId: string): Promise<FetchResult | null> {
  return new Promise((resolve) => {
    let foundContent: SocialUnlockContent | null = null;
    let foundPubkey = '';
    const signatures: Signature[] = [];
    let revealData: RevealData | null = null;
    const connections: WebSocket[] = [];
    let eoseCount = 0;
    let resolved = false;
    const targetEose = relayUrls.slice(0, 3).length * 3;

    function finalize() {
      if (resolved) return;
      resolved = true;
      for (const ws of connections) {
        try { ws.close(); } catch {}
      }

      if (!foundContent) {
        resolve(null);
        return;
      }

      resolve({
        content: foundContent,
        pubkey: foundPubkey,
        signatures,
        reveal: revealData ?? undefined,
      });
    }

    const timeout = setTimeout(finalize, 12000);

    for (const url of relayUrls.slice(0, 3)) {
      let ws: WebSocket;
      try {
        ws = new WebSocket(url);
      } catch {
        eoseCount += 3;
        continue;
      }
      connections.push(ws);

      const subId = `pub_unlock_${Math.random().toString(36).slice(2, 8)}`;

      ws.onopen = () => {
        ws.send(JSON.stringify(['REQ', subId, { ids: [eventId] }]));

        ws.send(JSON.stringify(['REQ', `${subId}_sigs`, {
          kinds: [CUSTOM_KIND.SOCIAL_UNLOCK_SIGN],
          '#e': [eventId],
          limit: 200,
        }]));

        ws.send(JSON.stringify(['REQ', `${subId}_reveal`, {
          kinds: [CUSTOM_KIND.SOCIAL_UNLOCK_REVEAL],
          '#e': [eventId],
          limit: 1,
        }]));
      };

      ws.onmessage = (msg) => {
        try {
          const data = JSON.parse(msg.data);
          if (data[0] === 'EVENT') {
            const event = data[2];

            if (event.id === eventId && event.kind === CUSTOM_KIND.SOCIAL_UNLOCK) {
              const parsed = parseSocialUnlockContent(event.content);
              if (parsed) {
                foundContent = parsed;
                foundPubkey = event.pubkey;
              }
            } else if (event.kind === CUSTOM_KIND.SOCIAL_UNLOCK_SIGN) {
              const signContent = parseSocialUnlockSignContent(event.content);
              if (signContent && signContent.unlock_event_id === eventId) {
                if (!signatures.some((s) => s.pubkey === event.pubkey)) {
                  signatures.push({ pubkey: event.pubkey, message: signContent.message });
                }
              }
            } else if (event.kind === CUSTOM_KIND.SOCIAL_UNLOCK_REVEAL) {
              const revealContent = parseSocialUnlockRevealContent(event.content);
              if (revealContent && revealContent.unlock_event_id === eventId) {
                revealData = {
                  decryption_key: revealContent.decryption_key,
                  revealed_at: revealContent.revealed_at,
                };
              }
            }
          } else if (data[0] === 'EOSE') {
            eoseCount++;
            if (eoseCount >= targetEose) {
              clearTimeout(timeout);
              finalize();
            }
          }
        } catch {}
      };

      ws.onerror = () => {
        eoseCount += 3;
        if (eoseCount >= targetEose) {
          clearTimeout(timeout);
          finalize();
        }
      };
    }

    if (relayUrls.length === 0) {
      clearTimeout(timeout);
      resolve(null);
    }
  });
}
