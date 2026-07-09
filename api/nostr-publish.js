/**
 * Vercel serverless: POST /api/nostr-publish
 * Server-side relay publish fallback when browser WebSockets fail.
 */

const DEFAULT_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.snort.social',
  'wss://nostr-pub.wellorder.net',
  'wss://relay.nostr.bg',
];

function publishToRelay(relayUrl, event, timeoutMs = 10_000) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch {}
      resolve(ok);
    };

    let ws;
    const timer = setTimeout(() => finish(false), timeoutMs);

    try {
      ws = new WebSocket(relayUrl);
    } catch {
      finish(false);
      return;
    }

    ws.onopen = () => {
      ws.send(JSON.stringify(['EVENT', event]));
    };

    ws.onmessage = (msg) => {
      try {
        const data = JSON.parse(msg.data);
        if (data[0] === 'OK' && data[1] === event.id) {
          finish(data[2] === true);
        }
      } catch {}
    };

    ws.onerror = () => finish(false);
    ws.onclose = () => {
      if (!settled) finish(false);
    };
  });
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST only' });
  }

  const { event, relays } = req.body ?? {};
  if (!event?.id || !event?.sig || !event?.pubkey) {
    return res.status(400).json({ error: 'Invalid event' });
  }

  const targets = Array.isArray(relays) && relays.length > 0
    ? relays.filter((r) => typeof r === 'string' && r.startsWith('wss://'))
    : DEFAULT_RELAYS;

  const results = await Promise.all(
    targets.slice(0, 6).map(async (url) => ({
      url,
      ok: await publishToRelay(url, event),
    })),
  );

  const success = results.filter((r) => r.ok).map((r) => r.url);
  const failed = results.filter((r) => !r.ok).map((r) => r.url);

  return res.status(200).json({ success, failed });
}
