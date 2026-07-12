/**
 * Vercel serverless: proxy JSON-RPC to a user-configured Bitcoin node.
 * POST body: { rpcUrl, rpcUser?, rpcPassword?, method, params }
 */

/**
 * Reject hosts that point at internal / link-local infrastructure. This is a
 * public, unauthenticated proxy, so without this it can be abused as an SSRF
 * pivot (e.g. cloud metadata at 169.254.169.254 or internal RPC services).
 * Local nodes (127.0.0.1 / localhost) never hit this proxy — the client talks
 * to them directly — so blocking them here is safe.
 */
function isBlockedHost(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');

  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    return true;
  }
  // IPv6 loopback / link-local / unique-local
  if (host === '::1' || host === '::' || host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) {
    return true;
  }
  // IPv4 literals in private / loopback / link-local / metadata ranges
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 0 || a === 127) return true;                 // 0.0.0.0/8, loopback
    if (a === 10) return true;                              // 10.0.0.0/8
    if (a === 169 && b === 254) return true;                // link-local + cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;       // 172.16.0.0/12
    if (a === 192 && b === 168) return true;                // 192.168.0.0/16
    if (a === 100 && b >= 64 && b <= 127) return true;      // CGNAT 100.64.0.0/10
  }
  return false;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { rpcUrl, rpcUser, rpcPassword, method, params } = req.body || {};
  if (!rpcUrl || typeof rpcUrl !== 'string') {
    return res.status(400).json({ error: 'rpcUrl required' });
  }
  if (!method || typeof method !== 'string') {
    return res.status(400).json({ error: 'method required' });
  }

  let parsed;
  try {
    parsed = new URL(rpcUrl);
  } catch {
    return res.status(400).json({ error: 'Invalid rpcUrl' });
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return res.status(400).json({ error: 'rpcUrl must be http or https' });
  }
  if (isBlockedHost(parsed.hostname)) {
    return res.status(403).json({ error: 'Refusing to proxy to a private or link-local address' });
  }

  const headers = { 'Content-Type': 'application/json' };
  if (rpcUser && rpcPassword) {
    const token = Buffer.from(`${rpcUser}:${rpcPassword}`).toString('base64');
    headers.Authorization = `Basic ${token}`;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);
    const resp = await fetch(rpcUrl, {
      method: 'POST',
      signal: controller.signal,
      headers,
      body: JSON.stringify({
        jsonrpc: '1.0',
        id: 'nostr-onchain',
        method,
        params: Array.isArray(params) ? params : [],
      }),
    });
    clearTimeout(timeout);

    const text = await resp.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return res.status(502).json({ error: text.slice(0, 200) || 'Invalid RPC response' });
    }

    if (data.error) {
      return res.status(502).json({ error: data.error });
    }
    return res.status(200).json({ result: data.result });
  } catch (err) {
    return res.status(502).json({ error: err?.message || 'RPC request failed' });
  }
}
