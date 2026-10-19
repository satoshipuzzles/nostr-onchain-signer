/**
 * A direct connection to one relay for the relay explorer.
 *
 * The shared SimplePool hides everything a relay says except events and EOSE,
 * so a relay that refuses a filter ("blocked: filters must specify at least one
 * kind", "auth-required: …", "error: search filter is required") or only sends
 * a NOTICE simply looked empty. This client keeps those answers, can answer a
 * NIP-42 AUTH challenge, and verifies every event's signature before showing it.
 */
import { verifyEvent } from 'nostr-tools/pure';
import type { NostrEvent } from './feed';

export interface QueryResult {
  events: NostrEvent[];
  /** the relay's CLOSED reason, e.g. "auth-required: please authenticate" */
  closed?: string;
  /** NOTICEs the relay sent while this query ran */
  notices: string[];
  timedOut: boolean;
  /** the socket never opened or dropped */
  connectError?: string;
}

/** A relay's machine-readable prefix (NIP-01): auth-required, restricted, rate-limited, blocked, error… */
export function reasonPrefix(reason?: string): string {
  const m = /^([a-z-]+):/.exec((reason || '').trim());
  return m ? m[1] : '';
}

/** Whether a refusal means "this filter needs a kind" (or similar), so the caller should retry narrower. */
export function needsNarrowerFilter(r: QueryResult): boolean {
  const text = [r.closed || '', ...r.notices].join(' ').toLowerCase();
  return /kind|empty filter|invalid filter|filter.*(required|must)|too broad|unsupported filter/.test(text) && !/search filter is required/.test(text);
}
export function needsSearch(r: QueryResult): boolean {
  return /search.*required/i.test([r.closed || '', ...r.notices].join(' '));
}
export function needsAuth(r: QueryResult): boolean {
  return reasonPrefix(r.closed) === 'auth-required' || /auth-required/i.test(r.notices.join(' '));
}

type Signer = (template: { kind: number; created_at: number; tags: string[][]; content: string }) => Promise<NostrEvent & { sig: string }>;

let subSeq = 0;

export class ExplorerRelay {
  readonly url: string;
  private ws: WebSocket | null = null;
  private opening: Promise<void> | null = null;
  private subs = new Map<string, (msg: unknown[]) => void>();
  private oks = new Map<string, (ok: boolean, msg: string) => void>();
  private noticeListeners = new Set<(n: string) => void>();
  challenge = '';
  authed = false;
  lastError = '';

  constructor(url: string) { this.url = url; }

  connect(timeoutMs = 7000): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return Promise.resolve();
    if (this.opening) return this.opening;
    this.opening = new Promise<void>((resolve, reject) => {
      let settled = false;
      let ws: WebSocket;
      try { ws = new WebSocket(this.url); } catch (e) { this.opening = null; reject(new Error('That address could not be opened')); return; }
      this.ws = ws;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.opening = null;
        try { ws.close(); } catch { /* closed */ }
        this.lastError = 'The relay did not answer within 7 seconds. It may be down, or blocked on your network.';
        reject(new Error(this.lastError));
      }, timeoutMs);
      ws.onopen = () => { if (settled) return; settled = true; clearTimeout(timer); this.opening = null; this.lastError = ''; resolve(); };
      ws.onerror = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.opening = null;
        // browsers give no detail; the usual causes are a dead host, a refused upgrade (403 for paid relays) or a bad certificate
        this.lastError = 'Could not open a connection. The relay may be down, members-only, or blocked on your network.';
        reject(new Error(this.lastError));
      };
      ws.onclose = () => {
        this.ws = null;
        this.authed = false;
        for (const [, fn] of this.subs) fn(['CLOSED', '', 'connection closed by the relay']);
        this.subs.clear();
      };
      ws.onmessage = (m) => {
        let d: unknown[];
        try { d = JSON.parse(String(m.data)); } catch { return; }
        if (!Array.isArray(d)) return;
        const [type] = d;
        if (type === 'AUTH' && typeof d[1] === 'string') { this.challenge = d[1]; return; }
        if (type === 'NOTICE') { for (const fn of this.noticeListeners) fn(String(d[1] ?? '')); return; }
        if (type === 'OK') { const fn = this.oks.get(String(d[1])); if (fn) { this.oks.delete(String(d[1])); fn(!!d[2], String(d[3] ?? '')); } return; }
        if ((type === 'EVENT' || type === 'EOSE' || type === 'CLOSED') && typeof d[1] === 'string') this.subs.get(d[1])?.(d);
      };
    });
    return this.opening;
  }

  /** One REQ, settled at EOSE, CLOSED, connection loss or `waitMs`. */
  async query(filter: Record<string, unknown>, waitMs = 9000): Promise<QueryResult> {
    const notices: string[] = [];
    try { await this.connect(); } catch {
      // one retry: a first handshake often fails while the page is busy opening the feed's own sockets
      await new Promise((r) => setTimeout(r, 1500));
      try { await this.connect(); } catch (e) {
        return { events: [], notices, timedOut: false, connectError: e instanceof Error ? e.message : String(e) };
      }
    }
    const ws = this.ws!;
    const id = `x${++subSeq}`;
    return new Promise<QueryResult>((resolve) => {
      const byId = new Map<string, NostrEvent>();
      const onNotice = (n: string) => notices.push(n);
      this.noticeListeners.add(onNotice);
      let done = false;
      const finish = (extra: Partial<QueryResult>) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.subs.delete(id);
        this.noticeListeners.delete(onNotice);
        if (!extra.closed) { try { ws.send(JSON.stringify(['CLOSE', id])); } catch { /* socket gone */ } }
        resolve({ events: [...byId.values()].sort((a, b) => b.created_at - a.created_at), notices, timedOut: false, ...extra });
      };
      const timer = setTimeout(() => finish({ timedOut: true }), waitMs);
      this.subs.set(id, (msg) => {
        if (msg[0] === 'EVENT') {
          const e = msg[2] as NostrEvent & { sig?: string };
          if (e && typeof e.id === 'string' && !byId.has(e.id)) {
            try { if (verifyEvent(e as Parameters<typeof verifyEvent>[0])) byId.set(e.id, e); } catch { /* bad event */ }
          }
        } else if (msg[0] === 'EOSE') finish({});
        else if (msg[0] === 'CLOSED') finish({ closed: String(msg[2] ?? '') || 'closed without a reason' });
      });
      try { ws.send(JSON.stringify(['REQ', id, filter])); } catch { finish({ connectError: 'The connection dropped' }); }
    });
  }

  /** Answer the relay's NIP-42 challenge with a kind 22242 event from the user's signer. */
  async auth(sign: Signer): Promise<{ ok: boolean; message: string }> {
    await this.connect();
    if (!this.challenge) return { ok: false, message: 'The relay has not sent an AUTH challenge.' };
    const signed = await sign({
      kind: 22242,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['relay', this.url], ['challenge', this.challenge]],
      content: '',
    });
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.oks.delete(signed.id); resolve({ ok: false, message: 'The relay did not confirm the login.' }); }, 8000);
      this.oks.set(signed.id, (ok, msg) => { clearTimeout(timer); this.authed = ok; resolve({ ok, message: msg || (ok ? 'Logged in to the relay' : 'The relay refused the login') }); });
      try { this.ws!.send(JSON.stringify(['AUTH', signed])); } catch { clearTimeout(timer); resolve({ ok: false, message: 'The connection dropped' }); }
    });
  }

  close() { try { this.ws?.close(); } catch { /* closed */ } this.ws = null; }
}

// a few open connections are kept so flipping between relays is quick
const open = new Map<string, ExplorerRelay>();
export function explorerRelay(url: string): ExplorerRelay {
  let r = open.get(url);
  if (!r) {
    r = new ExplorerRelay(url);
    open.set(url, r);
    while (open.size > 4) {
      const [oldest, conn] = open.entries().next().value as [string, ExplorerRelay];
      if (oldest === url) break;
      conn.close();
      open.delete(oldest);
    }
  }
  return r;
}

/** Kinds asked for when a relay won't take a filter without one. */
export const COMMON_KINDS = [0, 1, 3, 5, 6, 7, 16, 20, 21, 22, 1063, 1111, 1222, 9735, 9802, 10002, 30023, 30311, 34235];
