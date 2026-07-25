/** Validation for @nostr-onchain/core: descriptors, BIP-352, PSBT build/doc. */
import { schnorr, secp256k1 } from '@noble/curves/secp256k1';
import { bytesToHex } from '@noble/hashes/utils';
import {
  descriptorChecksum, trDescriptor, parseDescriptor,
  deriveSpKeysFromNostrKey, decodeSilentPaymentAddress, deriveSilentPaymentOutputs,
  taprootTweakPrivateKey, xOnlyToTaprootAddress,
  pubkeyToTaprootAddress, buildTx, signAndFinalizePsbt, psbtToDoc, parseAnyPsbt,
  exportBip329, importBip329, combinePsbts,
} from '../packages/core/src/index.ts';

let failed = 0;
const check = (name: string, ok: boolean, detail?: string) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? ` — ${detail}` : ''}`);
  if (!ok) failed++;
};

// 1. Descriptor checksum — Bitcoin Core test vector
check('descriptor checksum raw(deadbeef)', descriptorChecksum('raw(deadbeef)') === '89f8spxm', descriptorChecksum('raw(deadbeef)'));
const priv = secp256k1.utils.randomPrivateKey();
const xOnly = bytesToHex(schnorr.getPublicKey(priv));
const desc = trDescriptor(xOnly);
check('tr() descriptor parse round-trip', parseDescriptor(desc).type === 'tr' && parseDescriptor(desc).inner === xOnly);

// 2. BIP-352 sender/receiver ECDH symmetry
const Point = secp256k1.ProjectivePoint;
const n = secp256k1.CURVE.n;
const bytesToBig = (b: Uint8Array) => b.reduce((r, x) => (r << 8n) | BigInt(x), 0n);

const sp = deriveSpKeysFromNostrKey(bytesToHex(priv));
const decoded = decodeSilentPaymentAddress(sp.address);
check('sp1 address encode/decode', bytesToHex(decoded.scanKey) === bytesToHex(sp.scanPub) && bytesToHex(decoded.spendKey) === bytesToHex(sp.spendPub));

// Sender: taproot input (tweaked key)
const inputPrivRaw = bytesToHex(secp256k1.utils.randomPrivateKey());
const tweaked = taprootTweakPrivateKey(inputPrivRaw);
const spInput = { privateKeyHex: tweaked, isTaproot: true, txid: 'a'.repeat(64), vout: 1 };
const [senderOut] = deriveSilentPaymentOutputs(sp.address, [spInput], 1);

// Receiver: recompute with scan private key
{
  let a = bytesToBig(Buffer.from(tweaked, 'hex') as unknown as Uint8Array);
  const P = Point.BASE.multiply(a);
  if (!P.hasEvenY()) a = n - a;
  const ASum = Point.BASE.multiply(a);
  // input_hash same as sender
  const { sha256 } = await import('@noble/hashes/sha256');
  const { concatBytes, hexToBytes } = await import('@noble/hashes/utils');
  const tag = (t: string, ...m: Uint8Array[]) => {
    const td = sha256(new TextEncoder().encode(t));
    return sha256(concatBytes(td, td, ...m));
  };
  const txidBytes = hexToBytes('a'.repeat(64)).reverse();
  const vout = new Uint8Array([1, 0, 0, 0]);
  const inputHash = bytesToBig(tag('BIP0352/Inputs', concatBytes(txidBytes, vout), ASum.toRawBytes(true))) % n;
  // receiver ECDH: input_hash · b_scan · A_sum
  const bScan = bytesToBig(hexToBytes(sp.scanPrivHex));
  const ecdh = ASum.multiply((inputHash * bScan) % n).toRawBytes(true);
  const tk = bytesToBig(tag('BIP0352/SharedSecret', ecdh, new Uint8Array([0, 0, 0, 0]))) % n;
  const spendPub = Point.fromHex(sp.spendPub);
  const receiverOut = spendPub.add(Point.BASE.multiply(tk)).toAffine().x.toString(16).padStart(64, '0');
  check('BIP-352 sender/receiver derive same output', receiverOut === senderOut.xOnlyPubkeyHex, `${receiverOut} vs ${senderOut.xOnlyPubkeyHex}`);
}
check('SP output → bc1p address', xOnlyToTaprootAddress(senderOut.xOnlyPubkeyHex).startsWith('bc1p'));

// 3. buildTx → sign → finalize → doc
const fromAddr = pubkeyToTaprootAddress(xOnly);
const built = buildTx({
  utxos: [
    { txid: 'f9c649755a0481297956dfe63008539cd88f5226af48641c5656864fd7e723ca', vout: 0, value: 200_000 },
    { txid: 'b'.repeat(64), vout: 2, value: 50_000 },
  ],
  fromAddress: fromAddr,
  outputs: [
    { address: 'bc1pwsnl43ylvmp99ucypw6ehrs2ndt8mds9mqz5a4efywyzy526psss68grpd', amountSats: 60_000 },
    { address: xOnlyToTaprootAddress(senderOut.xOnlyPubkeyHex), amountSats: 20_000 },
    { amountSats: 0, opReturnData: new TextEncoder().encode('nostr onchain wallet manager test payload over eighty-three bytes to exercise pushdata one!') },
  ],
  feeRate: 4,
  changeAddress: fromAddr,
  internalPubkeyHex: xOnly,
  rbf: true,
  locktime: 0,
});
check('buildTx multi-output + big OP_RETURN', built.inputCount >= 1 && built.outputCount >= 3 && built.fee > 0);

const doc = psbtToDoc(built.psbtBase64);
check('psbtToDoc parses', doc.inputCount === built.inputCount && doc.outputCount === built.outputCount);
check('doc detects RBF', doc.inputs.every(i => i.rbfSignaled));
const opret = doc.outputs.find(o => o.type === 'op_return');
check('doc decodes OP_RETURN text', !!opret?.opReturn?.payloadText?.includes('wallet manager'));
check('doc flags non-BIP110 OP_RETURN', opret?.opReturn?.bip110Compliant === false);
check('doc fee matches', doc.feeSats === built.fee || Math.abs((doc.feeSats ?? 0) - built.fee) < 200);

const signed = signAndFinalizePsbt(built.psbtHex, bytesToHex(priv));
check('sign+finalize', /^[0-9a-f]{64}$/.test(signed.txid));

// parseAnyPsbt accepts hex and base64
check('parseAnyPsbt hex/base64', bytesToHex(parseAnyPsbt(built.psbtHex)) === bytesToHex(parseAnyPsbt(built.psbtBase64)));

// combine unsigned + signed copies
const combined = combinePsbts([built.psbtBytes, built.psbtBytes]);
check('combinePsbts', combined.length > 0);

// 4. BIP-329 round trip
const labels = [{ type: 'addr' as const, ref: fromAddr, label: 'My main' }, { type: 'tx' as const, ref: signed.txid, label: 'test tx' }];
const jsonl = exportBip329(labels);
check('BIP-329 round trip', importBip329(jsonl).length === 2 && importBip329(jsonl)[0].label === 'My main');

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILURES`);
process.exit(failed === 0 ? 0 : 1);
