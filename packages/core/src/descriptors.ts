/**
 * Output descriptors (BIP-380): checksum, tr() construction, minimal parsing.
 *
 * Descriptors are the interoperable wallet-definition format understood by
 * Bitcoin Core, Sparrow, Electrum, etc. We use them as the canonical way to
 * express a wallet in exports/imports instead of opaque .dat files.
 */

const INPUT_CHARSET =
  "0123456789()[],'/*abcdefgh@:$%{}IJKLMNOPQRSTUVWXYZ&+-.;<=>?!^_|~ijklmnopqrstuvwxyzABCDEFGH`#\"\\ ";
const CHECKSUM_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

function polymod(c: bigint, val: number): bigint {
  const c0 = c >> 35n;
  c = ((c & 0x7ffffffffn) << 5n) ^ BigInt(val);
  if (c0 & 1n) c ^= 0xf5dee51989n;
  if (c0 & 2n) c ^= 0xa9fdca3312n;
  if (c0 & 4n) c ^= 0x1bab10e32dn;
  if (c0 & 8n) c ^= 0x3706b1677an;
  if (c0 & 16n) c ^= 0x644d626ffdn;
  return c;
}

/** BIP-380 descriptor checksum (the 8 chars after '#'). */
export function descriptorChecksum(descriptor: string): string {
  let c = 1n;
  let cls = 0;
  let clscount = 0;
  for (const ch of descriptor) {
    const pos = INPUT_CHARSET.indexOf(ch);
    if (pos === -1) throw new Error(`Invalid descriptor character: ${JSON.stringify(ch)}`);
    c = polymod(c, pos & 31);
    cls = cls * 3 + (pos >> 5);
    if (++clscount === 3) {
      c = polymod(c, cls);
      cls = 0;
      clscount = 0;
    }
  }
  if (clscount > 0) c = polymod(c, cls);
  for (let i = 0; i < 8; i++) c = polymod(c, 0);
  c ^= 1n;
  let out = '';
  for (let i = 0; i < 8; i++) {
    out += CHECKSUM_CHARSET[Number((c >> BigInt(5 * (7 - i))) & 31n)];
  }
  return out;
}

/** Append (or validate and normalize) the checksum on a descriptor. */
export function withChecksum(descriptor: string): string {
  const hashIdx = descriptor.indexOf('#');
  if (hashIdx !== -1) {
    const body = descriptor.slice(0, hashIdx);
    const provided = descriptor.slice(hashIdx + 1);
    const expected = descriptorChecksum(body);
    if (provided !== expected) {
      throw new Error(`Descriptor checksum mismatch: expected ${expected}, got ${provided}`);
    }
    return descriptor;
  }
  return `${descriptor}#${descriptorChecksum(descriptor)}`;
}

/** Build a key-path-only taproot descriptor from an x-only pubkey (hex). */
export function trDescriptor(xOnlyPubkeyHex: string): string {
  if (!/^[0-9a-f]{64}$/i.test(xOnlyPubkeyHex)) {
    throw new Error('Expected 32-byte x-only pubkey hex');
  }
  return withChecksum(`tr(${xOnlyPubkeyHex.toLowerCase()})`);
}

export interface ParsedDescriptor {
  type: 'tr' | 'wpkh' | 'addr' | 'unknown';
  /** Inner key/address expression. */
  inner: string;
  raw: string;
}

/** Minimal parse: enough to recognize tr(KEY), wpkh(KEY), addr(ADDR). */
export function parseDescriptor(descriptor: string): ParsedDescriptor {
  const body = descriptor.includes('#') ? withChecksum(descriptor).split('#')[0] : descriptor;
  const m = body.match(/^(tr|wpkh|addr)\((.+)\)$/);
  if (!m) return { type: 'unknown', inner: body, raw: descriptor };
  return { type: m[1] as ParsedDescriptor['type'], inner: m[2], raw: descriptor };
}
