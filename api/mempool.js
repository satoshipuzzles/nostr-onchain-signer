/**
 * Vercel serverless: /api/mempool?path=/address/...
 * Proxies Esplora API calls server-side (no browser CORS/rate limits).
 */

const PROVIDERS = [
  'https://blockstream.info/api',
  'https://mempool.emzy.de/api',
  'https://mempool.space/api',
];

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const path = req.query.path;
  if (!path || typeof path !== 'string' || !path.startsWith('/')) {
    return res.status(400).json({ error: 'path query required (e.g. ?path=/address/...)' });
  }

  const isBroadcast = req.method === 'POST' && path === '/tx';
  let body;
  if (isBroadcast) {
    body = typeof req.body === 'string' ? req.body : req.body?.toString?.() ?? '';
    body = body.replace(/\s/g, '');
    if (!body) {
      return res.status(400).json({ error: 'raw transaction hex required in body' });
    }
  }

  let lastError = 'All providers failed';

  for (const base of PROVIDERS) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => {
        controller.abort(new DOMException('Request timeout', 'TimeoutError'));
      }, 20_000);
      const url = `${base}${path}`;

      const resp = await fetch(url, {
        method: req.method,
        signal: controller.signal,
        headers: isBroadcast ? { 'Content-Type': 'text/plain' } : undefined,
        body: isBroadcast ? body : undefined,
      });
      clearTimeout(timeout);

      if (resp.ok) {
        const text = await resp.text();
        if (path.startsWith('/v1/') || path.includes('/txs') || path.includes('/address/')) {
          try {
            return res.status(200).json(JSON.parse(text));
          } catch {
            return res.status(200).send(text);
          }
        }
        return res.status(200).send(text);
      }

      if (resp.status === 403 || resp.status === 429) {
        lastError = `HTTP ${resp.status}`;
        continue;
      }
      lastError = `HTTP ${resp.status}`;
    } catch (err) {
      lastError = err?.message || 'Network error';
    }
  }

  return res.status(502).json({ error: lastError });
}
