/**
 * Signing inbox subscription module.
 * Subscribes to kind 9800 signing request events addressed to the user.
 */

import { CUSTOM_KIND, type SigningRequestContent } from './kinds';

export interface SigningRequest {
  eventId: string;
  senderPubkey: string;
  createdAt: number;
  psbt_hex: string;
  round_id: string;
  multisig_address: string;
  threshold: number;
  signed_count: number;
  total_signers: number;
  memo?: string;
  expires_at: number;
  status: 'pending' | 'signed' | 'declined' | 'expired';
}

const STORAGE_KEY = 'signing_inbox_state';

interface InboxState {
  seen: Record<string, { status: 'pending' | 'signed' | 'declined' | 'expired'; respondedAt?: number }>;
}

async function loadInboxState(): Promise<InboxState> {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  return result[STORAGE_KEY] ?? { seen: {} };
}

async function saveInboxState(state: InboxState): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: state });
}

export async function markRequestStatus(
  eventId: string,
  status: 'signed' | 'declined'
): Promise<void> {
  const state = await loadInboxState();
  state.seen[eventId] = { status, respondedAt: Date.now() };
  await saveInboxState(state);
}

export async function getRequestStatus(
  eventId: string
): Promise<'pending' | 'signed' | 'declined' | 'expired' | null> {
  const state = await loadInboxState();
  return state.seen[eventId]?.status ?? null;
}

function parseSigningRequest(eventId: string, pubkey: string, content: string, createdAt: number): SigningRequest | null {
  try {
    const parsed: SigningRequestContent = JSON.parse(content);

    if (!parsed.psbt_hex || !parsed.round_id || !parsed.multisig_address) {
      return null;
    }

    const now = Math.floor(Date.now() / 1000);
    const isExpired = parsed.expires_at > 0 && parsed.expires_at < now;

    return {
      eventId,
      senderPubkey: pubkey,
      createdAt: createdAt,
      psbt_hex: parsed.psbt_hex,
      round_id: parsed.round_id,
      multisig_address: parsed.multisig_address,
      threshold: parsed.threshold,
      signed_count: parsed.signed_count,
      total_signers: parsed.total_signers,
      memo: parsed.memo,
      expires_at: parsed.expires_at,
      status: isExpired ? 'expired' : 'pending',
    };
  } catch {
    return null;
  }
}

/**
 * Subscribe to incoming signing requests for the given pubkey.
 * Returns a cleanup function to close the connection.
 */
export function subscribeSigningInbox(
  relayUrls: string[],
  userPubkey: string,
  onRequest: (request: SigningRequest) => void,
  onEose?: () => void
): () => void {
  const connections: { ws: WebSocket; subId: string }[] = [];
  const seenIds = new Set<string>();
  let eoseCount = 0;
  let eoseFired = false;
  const totalRelays = relayUrls.length;

  loadInboxState().then((state) => {
    for (const url of relayUrls) {
      const subId = `inbox_${Math.random().toString(36).slice(2, 10)}`;

      let ws: WebSocket;
      try {
        ws = new WebSocket(url);
      } catch {
        continue;
      }

      connections.push({ ws, subId });

      ws.onopen = () => {
        const filter = {
          kinds: [CUSTOM_KIND.SIGNING_REQUEST],
          '#p': [userPubkey],
          limit: 50,
        };
        ws.send(JSON.stringify(['REQ', subId, filter]));
      };

      ws.onmessage = (msg) => {
        try {
          const data = JSON.parse(msg.data);

          if (data[0] === 'EVENT' && data[1] === subId) {
            const event = data[2];
            if (seenIds.has(event.id)) return;
            seenIds.add(event.id);

            const request = parseSigningRequest(
              event.id,
              event.pubkey,
              event.content,
              event.created_at
            );

            if (request) {
              const savedStatus = state.seen[event.id];
              if (savedStatus) {
                request.status = savedStatus.status;
              }
              onRequest(request);
            }
          } else if (data[0] === 'EOSE' && data[1] === subId) {
            eoseCount++;
            if (!eoseFired && eoseCount >= Math.min(totalRelays, 2)) {
              eoseFired = true;
              onEose?.();
            }
          }
        } catch {
          // ignore
        }
      };

      ws.onerror = () => {
        eoseCount++;
        if (!eoseFired && eoseCount >= totalRelays) {
          eoseFired = true;
          onEose?.();
        }
      };
    }
  });

  return () => {
    for (const conn of connections) {
      try {
        if (conn.ws.readyState === WebSocket.OPEN) {
          conn.ws.send(JSON.stringify(['CLOSE', conn.subId]));
        }
        conn.ws.close();
      } catch {
        // ignore
      }
    }
    connections.length = 0;
  };
}

/**
 * Hook helper: returns the count of pending signing requests.
 */
export async function getPendingSigningCount(
  relayUrls: string[],
  userPubkey: string
): Promise<number> {
  return new Promise((resolve) => {
    const requests: SigningRequest[] = [];
    let resolved = false;

    const cleanup = subscribeSigningInbox(
      relayUrls,
      userPubkey,
      (req) => {
        if (req.status === 'pending') {
          requests.push(req);
        }
      },
      () => {
        if (!resolved) {
          resolved = true;
          cleanup();
          resolve(requests.length);
        }
      }
    );

    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        cleanup();
        resolve(requests.length);
      }
    }, 12000);
  });
}
