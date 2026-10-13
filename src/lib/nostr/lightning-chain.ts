/**
 * Which Lightning network a Lightning Address is on: XBT or BTC.
 *
 * Every invoice minted by an XBT Lightning node sets feature bit 512/513
 * (option_blake2b, lightning-blake2b/bolts#3). BTC nodes never set it. So the
 * answer is in the invoice itself: ask the address for a minimum-amount
 * invoice (never paid, it just expires) and read its feature bits.
 *
 * An address can also say so up front in its LNURL-pay response with
 * `"chain": "xbt"` (or `"chains": ["xbt"]`). That saves the extra request,
 * and is what our own addresses publish. Nostr profiles can name an XBT
 * address separately with the `lud16_xbt` kind-0 field.
 */

export type LnChain = 'xbt' | 'btc';

const BLAKE2B_BITS = [512, 513];
const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const CACHE_KEY = 'ln_address_chain_v1';
const CACHE_TTL_MS = 24 * 3600 * 1000;

/** Feature bits of a BOLT-11 invoice (tagged field 9). */
export function invoiceFeatureBits(bolt11: string): Set<number> {
  const pr = bolt11.trim().toLowerCase().replace(/^lightning:/, '');
  const sep = pr.lastIndexOf('1');
  if (sep < 1) return new Set();
  const words: number[] = [];
  for (const c of pr.slice(sep + 1)) {
    const v = CHARSET.indexOf(c);
    if (v < 0) return new Set();
    words.push(v);
  }
  // timestamp (7 words) ... tagged fields ... signature (104) checksum (6)
  const data = words.slice(7, words.length - 6 - 104);
  let i = 0;
  while (i + 3 <= data.length) {
    const type = data[i];
    const len = data[i + 1] * 32 + data[i + 2];
    const val = data.slice(i + 3, i + 3 + len);
    i += 3 + len;
    if (type !== 5) continue;            // feature bits: tag '9', which is 5 in bech32
    const bits = new Set<number>();
    // big-endian 5-bit words; bit 0 is the last bit of the last word
    for (let w = 0; w < val.length; w++) {
      for (let b = 0; b < 5; b++) {
        if (val[w] & (1 << b)) bits.add((val.length - 1 - w) * 5 + b);
      }
    }
    return bits;
  }
  return new Set();
}

export function invoiceChain(bolt11: string): LnChain {
  const bits = invoiceFeatureBits(bolt11);
  return BLAKE2B_BITS.some((b) => bits.has(b)) ? 'xbt' : 'btc';
}

function declaredChain(payInfo: Record<string, unknown>): LnChain | null {
  const one = typeof payInfo.chain === 'string' ? payInfo.chain.toLowerCase() : '';
  const many = Array.isArray(payInfo.chains) ? payInfo.chains.map((c) => String(c).toLowerCase()) : [];
  if (one === 'xbt' || many.includes('xbt')) return 'xbt';
  if (one === 'btc' || (many.length > 0 && !many.includes('xbt'))) return 'btc';
  return null;
}

function readCache(): Record<string, { chain: LnChain; at: number }> {
  try {
    return JSON.parse(localStorage.getItem(CACHE_KEY) || '{}');
  } catch {
    return {};
  }
}

function writeCache(addr: string, chain: LnChain) {
  try {
    const c = readCache();
    c[addr] = { chain, at: Date.now() };
    localStorage.setItem(CACHE_KEY, JSON.stringify(c));
  } catch {
    /* storage full or blocked: detection just runs again next time */
  }
}

/**
 * Find out which Lightning network a Lightning Address is on. Returns null if
 * the address cannot be reached. Results are cached for a day.
 */
export async function detectAddressChain(lud16: string): Promise<LnChain | null> {
  const addr = lud16.trim().toLowerCase();
  const [name, domain] = addr.split('@');
  if (!name || !domain) return null;

  const hit = readCache()[addr];
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.chain;

  try {
    const res = await fetch(`https://${domain}/.well-known/lnurlp/${encodeURIComponent(name)}`);
    if (!res.ok) return null;
    const info = await res.json();
    if (info?.tag !== 'payRequest' || typeof info.callback !== 'string') return null;

    const declared = declaredChain(info);
    if (declared) {
      writeCache(addr, declared);
      return declared;
    }

    const url = new URL(info.callback);
    url.searchParams.set('amount', String(Math.max(1000, Number(info.minSendable) || 1000)));
    const inv = await (await fetch(url.toString())).json();
    if (typeof inv?.pr !== 'string') return null;
    const chain = invoiceChain(inv.pr);
    writeCache(addr, chain);
    return chain;
  } catch {
    return null;
  }
}
