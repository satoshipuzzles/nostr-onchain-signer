import { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { Lock, Unlock, Users, ExternalLink, Check, LogIn } from 'lucide-react';
import { loadRelayList, getReadRelays } from '@/lib/nostr/relays';
import {
  decryptContent,
  parseSocialUnlockContent,
  parseSocialUnlockSignContent,
  parseSocialUnlockRevealContent,
  type SocialUnlockContent,
} from '@/lib/nostr/social-unlock';
import { CUSTOM_KIND } from '@/lib/nostr/kinds';
import { getCachedProfile } from '@/lib/nostr/cache';
import { safeImageUrl } from '@/lib/utils';
import type { ProfileMetadata } from '@/lib/nostr/social';

interface Signature {
  pubkey: string;
  message?: string;
}

interface RevealData {
  decryption_key: string;
  revealed_at: number;
}

function PageSignerBadge({ pubkey }: { pubkey: string }) {
  const [profile, setProfile] = useState<ProfileMetadata | null>(null);
  useEffect(() => {
    getCachedProfile(pubkey).then((p) => setProfile(p));
  }, [pubkey]);

  const name = profile?.displayName || profile?.name || pubkey.slice(0, 8) + '...';
  return (
    <div className="flex items-center gap-2">
      {profile?.picture ? (
        <img src={safeImageUrl(profile.picture)} alt="" className="w-6 h-6 rounded-full object-cover flex-shrink-0" />
      ) : (
        <div className="w-6 h-6 rounded-full bg-surface-600 flex items-center justify-center text-[10px] font-medium flex-shrink-0">
          {name.charAt(0).toUpperCase()}
        </div>
      )}
      <span className="text-xs text-gray-300 truncate">{name}</span>
      {profile?.nip05 && <span className="text-[9px] text-nostr/70 truncate">{profile.nip05}</span>}
    </div>
  );
}

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

  async function fetchUnlockEvent(id: string) {
    setLoading(true);
    setError(null);

    try {
      const relayList = await loadRelayList();
      const readRelays = getReadRelays(relayList);

      if (readRelays.length === 0) {
        readRelays.push('wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.snort.social');
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
        window.location.href = '/';
      }
    } catch (err) {
      console.error('NIP-07 connect failed:', err);
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-black flex items-center justify-center">
        <div className="animate-pulse text-gray-500">Loading social unlock...</div>
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

  return (
    <div className="min-h-screen bg-black text-white p-4 md:p-8 pb-24">
      <div className="max-w-lg mx-auto">
        {/* Header */}
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
            <span className="text-sm font-medium">
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
            <PageSignerBadge pubkey={creatorPubkey} />
          </div>
        )}

        {/* Signers */}
        {signatures.length > 0 && (
          <div className="card mb-4">
            <p className="text-xs text-gray-400 mb-2">Signers ({signatures.length})</p>
            <div className="space-y-2 max-h-40 overflow-y-auto">
              {signatures.map((sig, i) => (
                <div key={i} className="flex items-center gap-2">
                  <Check className="w-3.5 h-3.5 text-green-400 flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <PageSignerBadge pubkey={sig.pubkey} />
                  </div>
                  {sig.message && <span className="text-[10px] text-gray-500 truncate">&mdash; {sig.message}</span>}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Revealed content or locked state */}
        {isUnlocked && revealedContent ? (
          <div className="card border-green-500/20 animate-[scale-in_0.3s_ease-out]">
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
          <div className="card text-center">
            <Lock className="w-8 h-8 text-gray-600 mx-auto mb-2" />
            <p className="text-sm text-gray-400 mb-1">Content is locked</p>
            <p className="text-xs text-gray-600">
              {content.threshold - signatures.length} more signature{content.threshold - signatures.length !== 1 ? 's' : ''} needed to unlock
            </p>
          </div>
        ) : (
          <div className="card text-center">
            <p className="text-sm text-gray-400">Threshold met. Waiting for creator to publish reveal.</p>
          </div>
        )}

        {/* Login to sign */}
        {!isUnlocked && !connectedPubkey && (
          <div className="card mt-4 text-center">
            <p className="text-sm text-gray-400 mb-3">Want to help unlock this content?</p>
            <button
              onClick={handleConnect}
              className="btn-primary w-full flex items-center justify-center gap-2"
            >
              <LogIn className="w-4 h-4" />
              Connect with NIP-07 to Sign
            </button>
          </div>
        )}

        {connectedPubkey && !isUnlocked && (
          <div className="card mt-4 text-center">
            <p className="text-xs text-green-400 mb-1">Connected</p>
            <code className="text-[10px] text-gray-400 font-mono">{connectedPubkey.slice(0, 12)}...{connectedPubkey.slice(-6)}</code>
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
        // Fetch the main event by ID
        ws.send(JSON.stringify(['REQ', subId, { ids: [eventId] }]));

        // Fetch signatures referencing this event
        ws.send(JSON.stringify(['REQ', `${subId}_sigs`, {
          kinds: [CUSTOM_KIND.SOCIAL_UNLOCK_SIGN],
          '#e': [eventId],
          limit: 200,
        }]));

        // Fetch reveal for this event
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
