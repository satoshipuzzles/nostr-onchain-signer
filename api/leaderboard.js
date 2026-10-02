/**
 * Vercel serverless function: /api/leaderboard
 *
 * GET  -> trending pubkeys (nostr.band), cached 5 minutes.
 * POST {addresses: [{pubkey, address}]} -> scans each npub-derived taproot
 *      address on BOTH chains and returns
 *      {pubkey, address, xbt, btc, txCount, unsplitSats}
 *      xbt / btc are confirmed + mempool balances in sats; unsplitSats is the
 *      value of outpoints that exist in both chains' UTXO sets (coins from
 *      before the split that have not been separated yet). unsplitSats is
 *      null when either UTXO lookup failed.
 *
 * Runs server-side: mempool.guide (XBT) sends no CORS headers and answers
 * only over HTTP/1.1, which is what Node's fetch speaks. Batches are small
 * and paced so neither explorer is hammered.
 */

const BTC_PROVIDERS = [
  'https://blockstream.info/api',
  'https://mempool.emzy.de/api',
  'https://mempool.space/api',
];
const XBT_PROVIDERS = ['https://mempool.guide/api'];

let cachedTrending = null;
let trendingTime = 0;
const CACHE_TTL = 5 * 60 * 1000;

// Per-address scan cache (5 min) so repeated page loads do not rescan.
const scanCache = new Map(); // address -> { at, entry }

async function fetchJson(providers, endpoint) {
  for (const base of providers) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 9000);
      const resp = await fetch(`${base}${endpoint}`, { signal: controller.signal });
      clearTimeout(timeout);
      if (resp.ok) return await resp.json();
    } catch {}
  }
  throw new Error('All providers failed');
}

function balanceOf(info) {
  const c = info.chain_stats || {};
  const m = info.mempool_stats || {};
  return (c.funded_txo_sum || 0) - (c.spent_txo_sum || 0) + (m.funded_txo_sum || 0) - (m.spent_txo_sum || 0);
}

async function scanAddress(pubkey, address) {
  const hit = scanCache.get(address);
  if (hit && Date.now() - hit.at < CACHE_TTL) return { ...hit.entry, pubkey };

  const [xbtInfo, btcInfo] = await Promise.allSettled([
    fetchJson(XBT_PROVIDERS, `/address/${address}`),
    fetchJson(BTC_PROVIDERS, `/address/${address}`),
  ]);
  const xbt = xbtInfo.status === 'fulfilled' ? balanceOf(xbtInfo.value) : null;
  const btc = btcInfo.status === 'fulfilled' ? balanceOf(btcInfo.value) : null;
  const txCount = Math.max(
    xbtInfo.status === 'fulfilled' ? (xbtInfo.value.chain_stats?.tx_count || 0) : 0,
    btcInfo.status === 'fulfilled' ? (btcInfo.value.chain_stats?.tx_count || 0) : 0,
  );

  // Only addresses holding coins on both chains can have unsplit outpoints.
  let unsplitSats = 0;
  if (xbt > 0 && btc > 0) {
    const [xu, bu] = await Promise.allSettled([
      fetchJson(XBT_PROVIDERS, `/address/${address}/utxo`),
      fetchJson(BTC_PROVIDERS, `/address/${address}/utxo`),
    ]);
    if (xu.status === 'fulfilled' && bu.status === 'fulfilled') {
      const btcSet = new Map(bu.value.map((u) => [`${u.txid}:${u.vout}`, u.value]));
      for (const u of xu.value) {
        const k = `${u.txid}:${u.vout}`;
        if (btcSet.has(k)) unsplitSats += u.value;
      }
    } else {
      unsplitSats = null;
    }
  }

  const entry = { address, xbt: xbt ?? 0, btc: btc ?? 0, txCount, unsplitSats,
    xbtUnknown: xbt === null, btcUnknown: btc === null };
  scanCache.set(address, { at: Date.now(), entry });
  return { ...entry, pubkey };
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
      const { addresses } = req.body || {};
      if (!addresses || !Array.isArray(addresses)) {
        return res.status(400).json({ error: 'addresses array required' });
      }

      const batch = addresses
        .filter((a) => a && typeof a.address === 'string' && /^bc1[a-z0-9]{20,}$/i.test(a.address) && /^[0-9a-f]{64}$/i.test(a.pubkey || ''))
        .slice(0, 60);

      const results = [];
      for (let i = 0; i < batch.length; i += 4) {
        const chunk = batch.slice(i, i + 4);
        const settled = await Promise.allSettled(chunk.map(({ pubkey, address }) => scanAddress(pubkey, address)));
        for (const r of settled) {
          if (r.status === 'fulfilled' && r.value) results.push(r.value);
        }
        if (i + 4 < batch.length) await new Promise((r) => setTimeout(r, 250));
      }

      results.sort((a, b) => b.xbt - a.xbt || b.btc - a.btc);
      return res.status(200).json({ entries: results, scanned: batch.length, at: Date.now() });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  if (cachedTrending && Date.now() - trendingTime < CACHE_TTL) {
    return res.status(200).json({ ...cachedTrending, cached: true });
  }

  try {
    const pubkeys = await getRecentPubkeys();
    const payload = {
      pubkeys: pubkeys.slice(0, 200),
      message: 'Send POST with {addresses: [{pubkey, address}]} to scan both chains',
    };
    cachedTrending = payload;
    trendingTime = Date.now();
    return res.status(200).json(payload);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
