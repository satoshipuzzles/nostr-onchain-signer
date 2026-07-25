/**
 * Prove the key-path NIP-07 signing bug and its fix:
 *  - a raw-key signSchnorr signer (all real NIP-07 extensions) produces
 *    signatures that DON'T verify against the tweaked output key → the fixed
 *    code must throw KEYPATH_TWEAK_ERROR instead of emitting a bad tx
 *  - a tweak-aware signer must still work end-to-end
 */
import { schnorr, secp256k1 } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { concatBytes, bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { pubkeyToTaprootAddress } from '../src/lib/bitcoin/address.ts';
import { buildPsbt } from '../src/lib/bitcoin/psbt-builder.ts';

function taggedHash(tag: string, ...msgs: Uint8Array[]): Uint8Array {
  const t = sha256(new TextEncoder().encode(tag));
  return sha256(concatBytes(t, t, ...msgs));
}

const n = secp256k1.CURVE.n;
function bytesToBig(b: Uint8Array): bigint {
  let r = 0n;
  for (const x of b) r = (r << 8n) | BigInt(x);
  return r;
}
function bigToBytes(v: bigint): Uint8Array {
  const out = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) { out[i] = Number(v & 0xffn); v >>= 8n; }
  return out;
}

const d = secp256k1.utils.randomPrivateKey();
const xOnly = schnorr.getPublicKey(d);
const address = pubkeyToTaprootAddress(bytesToHex(xOnly));

// Tweaked private key (BIP341): d' = d_even + H_TapTweak(Px) mod n
const point = secp256k1.ProjectivePoint.fromPrivateKey(d);
const dEven = (point.toRawBytes(false)[64] & 1) === 1 ? n - bytesToBig(d) : bytesToBig(d);
const tweak = bytesToBig(taggedHash('TapTweak', xOnly));
const dTweaked = bigToBytes((dEven + tweak) % n);

const fakeUtxo = {
  txid: 'f9c649755a0481297956dfe63008539cd88f5226af48641c5656864fd7e723ca',
  vout: 0, value: 150_000,
  status: { confirmed: true, block_height: 0, block_hash: '', block_time: 0 },
} as any;

const psbt = await buildPsbt({
  fromAddress: address,
  toAddress: 'bc1pwsnl43ylvmp99ucypw6ehrs2ndt8mds9mqz5a4efywyzy526psss68grpd',
  amountSats: 50_000, feeRate: 3,
  internalPubkeyHex: bytesToHex(xOnly),
  selectedUtxos: [fakeUtxo],
});

let failed = 0;
const check = (name: string, ok: boolean) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`); if (!ok) failed++; };

// Case 1: raw-key signer (what NIP-07 extensions actually do) → must throw
(globalThis as any).window = {
  nostr: { signSchnorr: async (h: string) => bytesToHex(schnorr.sign(hexToBytes(h), d)) },
};
const { signPsbtViaNostrSchnorr, KEYPATH_TWEAK_ERROR } = await import('../src/lib/bitcoin/psbt-external-sign.ts');
try {
  await signPsbtViaNostrSchnorr(psbt.psbtHex, bytesToHex(xOnly));
  check('raw-key signer rejected', false);
} catch (err) {
  check('raw-key signer rejected with clear error', err instanceof Error && err.message === KEYPATH_TWEAK_ERROR);
}

// Case 2: tweak-aware signer → must produce a valid finalized tx
(globalThis as any).window = {
  nostr: { signSchnorr: async (h: string) => bytesToHex(schnorr.sign(hexToBytes(h), dTweaked)) },
};
try {
  const result = await signPsbtViaNostrSchnorr(psbt.psbtHex, bytesToHex(xOnly));
  check('tweak-aware signer produces finalized tx', !!result?.txHex && !!result?.txid && result.source === 'nip07-schnorr');
} catch (err) {
  console.log('  error:', err instanceof Error ? err.message : err);
  check('tweak-aware signer produces finalized tx', false);
}

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILURES`);
process.exit(failed === 0 ? 0 : 1);
