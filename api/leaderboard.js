/**
 * Vercel serverless function: /api/leaderboard
 *
 * Scans Nostr pubkeys and checks their derived Taproot addresses for balances.
 * Runs server-side to avoid browser CORS and rate limits.
 */

const MEMPOOL_APIS = [
  'https://blockstream.info/api',
  'https://mempool.emzy.de/api',
  'https://mempool.space/api',
];

let cachedResult = null;
let cacheTime = 0;
const CACHE_TTL = 5 * 60 * 1000;

async function fetchMempool(endpoint) {
  for (const base of MEMPOOL_APIS) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      const resp = await fetch(`${base}${endpoint}`, { signal: controller.signal });
      clearTimeout(timeout);
      if (resp.ok) return await resp.json();
    } catch {}
  }
  throw new Error('All mempool APIs failed');
}

async function getRecentPubkeys() {
  try {
    const resp = await fetch('https://api.nostr.band/v0/trending/notes');
    if (resp.ok) {
      const data = await resp.json();
      const pubkeys = new Set();
      (data.notes || []).forEach((n) => {
        if (n.event?.pubkey) pubkeys.add(n.event.pubkey);
      });
      return [...pubkeys];
    }
  } catch {}
  return [];
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method === 'POST') {
    try {
      const { addresses } = req.body;

      if (!addresses || !Array.isArray(addresses)) {
        return res.status(400).json({ error: 'addresses array required' });
      }

      const results = [];
      const batch = addresses.slice(0, 100);

      for (let i = 0; i < batch.length; i += 5) {
        const chunk = batch.slice(i, i + 5);
        const promises = chunk.map(async ({ pubkey, address }) => {
          try {
            const info = await fetchMempool(`/address/${address}`);
            const balance = info.chain_stats.funded_txo_sum - info.chain_stats.spent_txo_sum;
            if (balance > 0 || info.chain_stats.tx_count > 0) {
              return { pubkey, address, balance, txCount: info.chain_stats.tx_count };
            }
          } catch {}
          return null;
        });

        const chunkResults = await Promise.allSettled(promises);
        for (const r of chunkResults) {
          if (r.status === 'fulfilled' && r.value) {
            results.push(r.value);
          }
        }

        if (i + 5 < batch.length) {
          await new Promise((r) => setTimeout(r, 200));
        }
      }

      results.sort((a, b) => b.balance - a.balance);
      return res.status(200).json({ entries: results, scanned: batch.length });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  if (cachedResult && Date.now() - cacheTime < CACHE_TTL) {
    return res.status(200).json({ ...cachedResult, cached: true });
  }

  try {
    const pubkeys = await getRecentPubkeys();
    const payload = {
      pubkeys: pubkeys.slice(0, 200),
      message: 'Send POST with {addresses: [{pubkey, address}]} to scan',
    };
    cachedResult = payload;
    cacheTime = Date.now();
    return res.status(200).json(payload);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
