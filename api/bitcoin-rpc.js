/**
 * Vercel serverless: proxy JSON-RPC to a user-configured Bitcoin node.
 * POST body: { rpcUrl, rpcUser?, rpcPassword?, method, params }
 */

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
