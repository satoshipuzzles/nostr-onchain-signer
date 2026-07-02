/**
 * Nostr Wallet Connect (NWC) — NIP-47
 * Handles wallet connections for zapping via Lightning.
 */

import { secp256k1, schnorr } from '@noble/curves/secp256k1';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { computeEventId } from './events';

export interface NwcConnection {
  pubkey: string;
  relay: string;
  secret: string;
}

export function parseNwcUri(uri: string): NwcConnection | null {
  try {
    const cleaned = uri.trim();
    const match = cleaned.match(/^nostr\+walletconnect:\/\/([0-9a-f]{64})\??(.*)$/i);
    if (!match) return null;

    const pubkey = match[1].toLowerCase();
    const params = new URLSearchParams(match[2]);
    const relay = params.get('relay');
    const secret = params.get('secret');

    if (!relay || !secret) return null;
    return { pubkey, relay, secret: secret.toLowerCase() };
  } catch {
    return null;
  }
}

export function getNwcSessionPubkey(secret: string): string {
  return bytesToHex(schnorr.getPublicKey(hexToBytes(secret)));
}

async function nip04Encrypt(
  plaintext: string,
  ourSecret: string,
  theirPubkey: string,
): Promise<string> {
  const sharedPoint = secp256k1.getSharedSecret(ourSecret, '02' + theirPubkey);
  const sharedX = sharedPoint.slice(1, 33);

  const iv = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey(
    'raw', sharedX, { name: 'AES-CBC' }, false, ['encrypt'],
  );
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-CBC', iv }, key, new TextEncoder().encode(plaintext),
  );

  const encB64 = btoa(String.fromCharCode(...new Uint8Array(ciphertext)));
  const ivB64 = btoa(String.fromCharCode(...iv));
  return `${encB64}?iv=${ivB64}`;
}

async function nip04Decrypt(
  ciphertext: string,
  ourSecret: string,
  theirPubkey: string,
): Promise<string> {
  const [encB64, ivB64] = ciphertext.split('?iv=');
  const sharedPoint = secp256k1.getSharedSecret(ourSecret, '02' + theirPubkey);
  const sharedX = sharedPoint.slice(1, 33);

  const enc = Uint8Array.from(atob(encB64), (c) => c.charCodeAt(0));
  const iv = Uint8Array.from(atob(ivB64), (c) => c.charCodeAt(0));

  const key = await crypto.subtle.importKey(
    'raw', sharedX, { name: 'AES-CBC' }, false, ['decrypt'],
  );
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, key, enc);
  return new TextDecoder().decode(plaintext);
}

/**
 * Send a pay_invoice request via NWC and wait for the wallet response.
 */
export async function sendNwcPayment(
  connection: NwcConnection,
  invoice: string,
): Promise<{ preimage?: string; error?: string }> {
  const sessionPubkey = getNwcSessionPubkey(connection.secret);
  const requestContent = JSON.stringify({
    method: 'pay_invoice',
    params: { invoice },
  });
  const encrypted = await nip04Encrypt(
    requestContent, connection.secret, connection.pubkey,
  );

  const unsigned = {
    kind: 23194,
    pubkey: sessionPubkey,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['p', connection.pubkey]],
    content: encrypted,
  };

  const id = computeEventId(unsigned);
  const sig = bytesToHex(
    schnorr.sign(hexToBytes(id), hexToBytes(connection.secret)),
  );
  const signedEvent = { ...unsigned, id, sig };

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      ws.close();
      resolve({ error: 'Timeout waiting for wallet response' });
    }, 30000);

    let ws: WebSocket;
    try {
      ws = new WebSocket(connection.relay);
    } catch {
      clearTimeout(timeout);
      resolve({ error: 'Failed to connect to NWC relay' });
      return;
    }

    const subId = `nwc_${Math.random().toString(36).slice(2, 8)}`;

    ws.onopen = () => {
      ws.send(JSON.stringify(['REQ', subId, {
        kinds: [23195],
        authors: [connection.pubkey],
        '#p': [sessionPubkey],
        since: Math.floor(Date.now() / 1000) - 10,
      }]));
      ws.send(JSON.stringify(['EVENT', signedEvent]));
    };

    ws.onmessage = async (msg) => {
      try {
        const data = JSON.parse(msg.data);
        if (data[0] === 'EVENT' && data[1] === subId && data[2].kind === 23195) {
          const decrypted = await nip04Decrypt(
            data[2].content, connection.secret, connection.pubkey,
          );
          const result = JSON.parse(decrypted);
          clearTimeout(timeout);
          ws.close();
          if (result.error) {
            resolve({ error: result.error.message || 'Payment failed' });
          } else {
            resolve({ preimage: result.result?.preimage });
          }
        }
      } catch { /* ignore parse errors */ }
    };

    ws.onerror = () => {
      clearTimeout(timeout);
      resolve({ error: 'WebSocket error' });
    };
  });
}

export async function loadNwcConnection(): Promise<NwcConnection | null> {
  const result = await chrome.storage.local.get('nwc_connection');
  return result.nwc_connection ?? null;
}

export async function saveNwcConnection(
  connection: NwcConnection | null,
): Promise<void> {
  if (connection) {
    await chrome.storage.local.set({ nwc_connection: connection });
  } else {
    await chrome.storage.local.remove('nwc_connection');
  }
}
