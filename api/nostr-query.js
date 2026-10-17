/**
 * Vercel serverless: POST /api/nostr-query
 *
 * Read-only relay proxy for browsers whose network blocks some relays (some
 * home networks drop nos.lol, nostr.mom, relay.nostr.band at the TCP level).
 * The client queries its relays directly AND this endpoint in parallel, then
 * merges by event id, so a blocked network still sees the data.
 *
 * Body: { relays: string[], filters: object[], timeoutMs?: number }
 * Reply: { events: Event[], relays: { [url]: 'ok' | 'error' | 'timeout' } }
 *
 * Limits: at most 10 wss:// relays (relay.primal.net is always dropped),
 * kinds 0, 1, 3, 6, 7, 1111, 9735, 10002 (plus NIP-50 `search`), limit <= 500.
 */
import WebSocket from 'ws';

const ORIGINS = new Set([
  'https://nostronchain.com',
  'https://www.nostronchain.com',
  'https://client.nostronchain.com',
  'https://nostr-onchain-signer.vercel.app',
  'http://localhost:5173',
  'http://localhost:4173',
  'http://127.0.0.1:5173',
]);
const KINDS = new Set([0, 1, 3, 6, 7, 1111, 9735, 10002]);
const ALLOWED_KEYS = new Set([
  'ids', 'authors', 'kinds', 'since', 'until', 'limit', 'search',
  '#p', '#P', '#e', '#E', '#a', '#A', '#q', '#t', '#k', '#K',
]);
const HEX64 = /^[0-9a-f]{64}$/;
const MAX_LIMIT = 500;

function cleanFilters(fs) {
  if (!Array.isArray(fs) || !fs.length || fs.length > 10) return null;
  const out = [];
  for (const f of fs) {
    if (!f || typeof f !== 'object' || Array.isArray(f)) return null;
    const g = {};
    for (const [k, v] of Object.entries(f)) if (ALLOWED_KEYS.has(k)) g[k] = v;
    // Every filter names its kinds, and only the read-side kinds we allow
    if (!Array.isArray(g.kinds) || !g.kinds.length || !g.kinds.every((k) => KINDS.has(k))) return null;
    if (g.search !== undefined && (typeof g.search !== 'string' || !g.search.trim() || g.search.length > 100)) return null;
    for (const key of ['ids', 'authors']) {
      if (g[key] === undefined) continue;
      if (!Array.isArray(g[key]) || g[key].length > 500 || !g[key].every((x) => typeof x === 'string' && HEX64.test(x))) return null;
    }
    for (const key of Object.keys(g)) {
      if (!key.startsWith('#')) continue;
      if (!Array.isArray(g[key]) || g[key].length > 500 || !g[key].every((x) => typeof x === 'string' && x.length <= 200)) return null;
    }
    for (const key of ['since', 'until']) {
      if (g[key] !== undefined && !Number.isFinite(Number(g[key]))) return null;
      if (g[key] !== undefined) g[key] = Math.floor(Number(g[key]));
    }
    g.limit = Math.min(Math.max(Number(g.limit) || 200, 1), MAX_LIMIT);
    out.push(g);
  }
  return out;
}

function cleanRelays(rs) {
  if (!Array.isArray(rs)) return [];
  return [...new Set(
    rs
      .filter((r) => typeof r === 'string' && /^wss:\/\/[a-z0-9.-]+(:\d+)?(\/[^\s]*)?$/i.test(r))
      .filter((r) => !/primal\.net/i.test(r))
      .map((r) => r.replace(/\/+$/, '').toLowerCase()),
  )].slice(0, 10);
}

function queryRelay(url, filters, timeoutMs, events) {
  return new Promise((resolve) => {
    let done = false;
    let ws;
    const sid = 'q' + Math.random().toString(36).slice(2, 8);
    const finish = (state) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { ws.send(JSON.stringify(['CLOSE', sid])); } catch { /* closed */ }
      try { ws.close(); } catch { /* closed */ }
      resolve(state);
    };
    const timer = setTimeout(() => finish('timeout'), timeoutMs);
    try {
      ws = new WebSocket(url, { handshakeTimeout: Math.min(timeoutMs, 4000) });
    } catch {
      finish('error');
      return;
    }
    ws.on('open', () => {
      try { ws.send(JSON.stringify(['REQ', sid, ...filters])); } catch { finish('error'); }
    });
    ws.on('message', (data) => {
      let m;
      try { m = JSON.parse(data.toString()); } catch { return; }
      if (m[0] === 'EVENT' && m[1] === sid) {
        const e = m[2];
        if (e && typeof e.id === 'string' && HEX64.test(e.id) && KINDS.has(e.kind) && typeof e.sig === 'string') {
          events.set(e.id, e);
        }
      } else if (m[0] === 'EOSE' && m[1] === sid) finish('ok');
      else if (m[0] === 'CLOSED' && m[1] === sid) finish('error');
    });
    ws.on('error', () => finish('error'));
    ws.on('close', () => finish('error'));
  });
}

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (origin && ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = null; }
  }
  const relays = cleanRelays(body?.relays);
  const filters = cleanFilters(body?.filters);
  if (!relays.length || !filters) {
    return res.status(400).json({ error: 'need wss relays and filters (kinds 0, 1, 3, 6, 7, 1111, 9735, 10002)' });
  }
  const timeoutMs = Math.min(Math.max(Number(body.timeoutMs) || 4000, 500), 8000);

  const events = new Map();
  const states = await Promise.all(relays.map((r) => queryRelay(r, filters, timeoutMs, events)));
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({
    events: [...events.values()],
    relays: Object.fromEntries(relays.map((r, i) => [r, states[i]])),
  });
}
