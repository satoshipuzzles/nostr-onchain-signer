/**
 * Nostr Wallet Connect (NWC) — NIP-47
 * Handles wallet connections for zapping via Lightning.
 */

import { secp256k1, schnorr } from '@noble/curves/secp256k1';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { computeEventId } from './events';

export interface NwcConnection {
  pubkey: string;
  /** First relay in the URI; kept for connections saved before `relays` existed */
  relay: string;
  /** Every relay the URI names. Requests go to all of them, first reply wins. */
  relays?: string[];
  secret: string;
}

/**
 * Connections saved before we kept every relay only remember the first one.
 * Our node's URIs always listed nos.lol next, so try it too: a request sent to a
 * relay the wallet doesn't listen on is simply never answered there.
 */
const LEGACY_FALLBACK_RELAYS = ['wss://nos.lol'];

export function nwcRelays(c: NwcConnection): string[] {
  const list = c.relays?.length ? c.relays : [c.relay, ...LEGACY_FALLBACK_RELAYS];
  return [...new Set(list.map((r) => r.trim()).filter(Boolean))];
}

export function parseNwcUri(uri: string): NwcConnection | null {
  try {
    const cleaned = uri.trim();
    const match = cleaned.match(/^nostr\+walletconnect:\/\/([0-9a-f]{64})\??(.*)$/i);
    if (!match) return null;

    const pubkey = match[1].toLowerCase();
    const params = new URLSearchParams(match[2]);
    const relays = [...new Set(params.getAll('relay').map((r) => r.trim()).filter(Boolean))];
    const secret = params.get('secret');

    if (!relays.length || !secret || !/^[0-9a-f]{64}$/i.test(secret)) return null;
    return { pubkey, relay: relays[0], relays, secret: secret.toLowerCase() };
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
 * Send one NIP-47 request to the wallet and wait for its reply.
 * Resolves with the method's result, or with { error } on failure or timeout.
 */
export async function nwcRequest<T = any>(
  connection: NwcConnection,
  method: string,
  params: Record<string, unknown> = {},
  timeoutMs = 30000,
): Promise<{ result?: T; error?: string }> {
  const sessionPubkey = getNwcSessionPubkey(connection.secret);
  const encrypted = await nip04Encrypt(
    JSON.stringify({ method, params }), connection.secret, connection.pubkey,
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

  const relays = nwcRelays(connection);
  return new Promise((resolve) => {
    const sockets: WebSocket[] = [];
    const failures: string[] = [];
    let done = false;
    const finish = (r: { result?: T; error?: string }) => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      sockets.forEach((s) => { try { s.close(); } catch { /* already closed */ } });
      resolve(r);
    };
    const fail = (relay: string, why: string) => {
      failures.push(`${relay.replace(/^wss:\/\//, '')}: ${why}`);
      if (failures.length >= relays.length) {
        finish({ error: `Could not reach the wallet. ${failures.join('; ')}` });
      }
    };
    const timeout = setTimeout(() => {
      finish({
        error: failures.length
          ? `Wallet did not answer. ${failures.join('; ')}`
          : 'Wallet did not answer in time. Is the node online?',
      });
    }, timeoutMs);

    for (const relay of relays) {
      let ws: WebSocket;
      try {
        ws = new WebSocket(relay);
      } catch {
        fail(relay, 'bad relay URL');
        continue;
      }
      sockets.push(ws);
      const subId = `nwc_${Math.random().toString(36).slice(2, 8)}`;
      let failed = false;
      const relayFail = (why: string) => { if (!failed) { failed = true; fail(relay, why); } };

      ws.onopen = () => {
        ws.send(JSON.stringify(['REQ', subId, {
          kinds: [23195],
          authors: [connection.pubkey],
          '#p': [sessionPubkey],
          '#e': [id],
        }]));
        ws.send(JSON.stringify(['EVENT', signedEvent]));
      };

      ws.onmessage = async (msg) => {
        try {
          const data = JSON.parse(msg.data);
          // A relay that refuses the request (rate limits, bans, paid relays) says so here
          if (data[0] === 'OK' && data[1] === id && data[2] === false) {
            relayFail(String(data[3] || 'refused the request'));
            return;
          }
          if (data[0] === 'EVENT' && data[1] === subId && data[2].kind === 23195) {
            const decrypted = await nip04Decrypt(
              data[2].content, connection.secret, connection.pubkey,
            );
            const reply = JSON.parse(decrypted);
            if (reply.error) {
              finish({ error: reply.error.message || `${method} failed` });
            } else {
              finish({ result: reply.result });
            }
          }
        } catch { /* ignore parse errors */ }
      };

      ws.onerror = () => relayFail('connection failed');
      ws.onclose = () => relayFail('connection closed');
    }
  });
}

/**
 * Send a pay_invoice request via NWC and wait for the wallet response.
 * `amountMsats` is only for invoices that carry no amount of their own.
 */
export async function sendNwcPayment(
  connection: NwcConnection,
  invoice: string,
  amountMsats?: number,
): Promise<{ preimage?: string; error?: string }> {
  const params: Record<string, unknown> = { invoice };
  if (amountMsats) params.amount = amountMsats;
  const r = await nwcRequest<{ preimage?: string }>(connection, 'pay_invoice', params, 60000);
  return r.error ? { error: r.error } : { preimage: r.result?.preimage };
}

export interface NwcInfo {
  alias?: string;
  pubkey?: string;
  network?: string;
  block_height?: number;
  methods?: string[];
}

export interface NwcTransaction {
  type: 'incoming' | 'outgoing';
  invoice?: string;
  description?: string;
  payment_hash?: string;
  /** msats */
  amount: number;
  fees_paid?: number;
  created_at?: number;
  settled_at?: number | null;
  expires_at?: number;
}

export function getNwcInfo(c: NwcConnection) {
  return nwcRequest<NwcInfo>(c, 'get_info', {}, 15000);
}

/** Spendable balance in msats. */
export async function getNwcBalance(c: NwcConnection): Promise<{ msats?: number; error?: string }> {
  const r = await nwcRequest<{ balance: number }>(c, 'get_balance', {}, 15000);
  return r.error ? { error: r.error } : { msats: Number(r.result?.balance ?? 0) };
}

export function makeNwcInvoice(c: NwcConnection, amountMsats: number, description = '', expiry = 3600) {
  return nwcRequest<NwcTransaction>(c, 'make_invoice', { amount: amountMsats, description, expiry }, 20000);
}

export function lookupNwcInvoice(c: NwcConnection, paymentHash: string) {
  return nwcRequest<NwcTransaction>(c, 'lookup_invoice', { payment_hash: paymentHash }, 15000);
}

export async function listNwcTransactions(c: NwcConnection, limit = 20) {
  const r = await nwcRequest<{ transactions: NwcTransaction[] }>(c, 'list_transactions', { limit }, 20000);
  return r.error ? { error: r.error } : { transactions: r.result?.transactions ?? [] };
}

/** Lightning network a wallet pays on. XBT and BTC Lightning share the
 *  `lnbc` invoice prefix, so the wallet, not the invoice, decides the chain. */
export type LightningChain = 'xbt' | 'btc';

// The original single connection predates XBT Lightning and is the BTC wallet.
const NWC_KEYS: Record<LightningChain, string> = { btc: 'nwc_connection', xbt: 'nwc_connection_xbt' };

export async function loadNwcConnection(chain: LightningChain = 'btc'): Promise<NwcConnection | null> {
  const key = NWC_KEYS[chain];
  const result = await chrome.storage.local.get(key);
  return result[key] ?? null;
}

export async function saveNwcConnection(
  connection: NwcConnection | null,
  chain: LightningChain = 'btc',
): Promise<void> {
  const key = NWC_KEYS[chain];
  if (connection) {
    await chrome.storage.local.set({ [key]: connection });
  } else {
    await chrome.storage.local.remove(key);
  }
}
