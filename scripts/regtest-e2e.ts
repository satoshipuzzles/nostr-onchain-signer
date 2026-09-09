/**
 * End-to-end check of the extension's PSBT builder + vault signer against a
 * Bitcoin Knots regtest node with the BLAKE2b hardfork active:
 *   1. key-path spend built with chain 'xbt' (sighash 0x21) → signAndFinalizePsbt → testmempoolaccept
 *   2. tapscript 1-of-2 multisig built with chain 'xbt' → signMultisigPsbtWithKeys → combine/finalize → testmempoolaccept
 *   3. same key-path spend built for 'btc' (legacy) still accepted (control)
 *
 * Env: REGTEST_DATADIR, RPC_PORT (default 18555), RPC_AUTH (user:pass, default t:t).
 * Run: npx tsx scripts/regtest-e2e.ts
 */
import { execFileSync } from 'node:child_process';
import { schnorr } from '@noble/curves/secp256k1';
import { hex, bech32m } from '@scure/base';
import { buildPsbtFromUtxos, signAndFinalizePsbt } from '../src/lib/bitcoin/psbt-builder';
import { signMultisigPsbtWithKeys, multisigTaprootInfo } from '../src/lib/bitcoin/multisig-psbt';
import { combinePsbtsToRawTx } from '../src/lib/bitcoin/psbt-broadcast';
import { Transaction } from '@scure/btc-signer';

const DATADIR = process.env.REGTEST_DATADIR ?? '/private/tmp/claude-501/-Users-kennyalves/d546db7c-4fa3-413b-9640-0395a60bcfce/scratchpad/regtest';
const [user, pass] = (process.env.RPC_AUTH ?? 't:t').split(':');
const BIN = process.env.BITCOIN_CLI ?? '/Users/kennyalves/bitcoin-knots-29.4.1/bin/bitcoin-cli';
const base = ['-regtest', `-datadir=${DATADIR}`, `-rpcuser=${user}`, `-rpcpassword=${pass}`, `-rpcport=${process.env.RPC_PORT ?? '18555'}`];
const rpc = (...a: string[]) => execFileSync(BIN, [...base, ...a], { encoding: 'utf8' }).trim();
const rpcw = (...a: string[]) => execFileSync(BIN, [...base, '-rpcwallet=w', ...a], { encoding: 'utf8' }).trim();

// The builder produces mainnet 'bc1p' addresses; regtest wants 'bcrt1p'. Same script.
const toRegtest = (addr: string) => {
  const d = bech32m.decode(addr as `${string}1${string}`);
  return bech32m.encode('bcrt', d.words, 200);
};
async function fund(addrMain: string) {
  const addr = toRegtest(addrMain);
  const txid = rpcw('sendtoaddress', addr, '0.5');
  rpcw('-generate', '1');
  const dec = JSON.parse(rpcw('gettransaction', txid, 'true', 'true')).decoded;
  const vout = dec.vout.findIndex((o: any) => o.scriptPubKey.address === addr);
  return { txid, vout, value: Math.round(dec.vout[vout].value * 1e8), status: { confirmed: true } };
}
const accept = (raw: string) => JSON.parse(rpc('testmempoolaccept', JSON.stringify([raw])))[0];
const results: string[] = [];
const check = (name: string, ok: boolean, extra = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name} ${extra}`);

console.log('regtest height', rpc('getblockcount'));

// ── 1. key-path, XBT (unified) ──
{
  const priv = schnorr.utils.randomPrivateKey();
  const pubHex = hex.encode(schnorr.getPublicKey(priv));
  const { pubkeyToTaprootAddress } = await import('../src/lib/bitcoin/address');
  const addr = pubkeyToTaprootAddress(pubHex);
  const u = await fund(addr);
  const res = buildPsbtFromUtxos(
    { fromAddress: addr, toAddress: addr, amountSats: u.value - 2000, internalPubkeyHex: pubHex, selectedUtxos: [u], chain: 'xbt' },
    [u], 2,
  );
  const psbt = Transaction.fromPSBT(hex.decode(res.psbtHex));
  check('builder sets sighash 0x21 on XBT inputs', psbt.getInput(0).sighashType === 0x21);
  const signed = signAndFinalizePsbt(res.psbtHex, hex.encode(priv));
  check('signAndFinalizePsbt reports chain xbt', signed.chain === 'xbt');
  const r = accept(signed.txHex);
  check('key-path UNIFIED tx accepted by Knots regtest', r.allowed, r.allowed ? '' : r['reject-reason']);
  if (r.allowed) { rpc('sendrawtransaction', signed.txHex); rpcw('-generate', '1'); const blk = JSON.parse(rpc('getblock', rpc('getbestblockhash'))); check('key-path UNIFIED tx mined', blk.tx.includes(signed.txid)); }

  // control: same flow for BTC (legacy sighash) still valid post-fork
  const u2 = await fund(addr);
  const res2 = buildPsbtFromUtxos(
    { fromAddress: addr, toAddress: addr, amountSats: u2.value - 2000, internalPubkeyHex: pubHex, selectedUtxos: [u2], chain: 'btc' },
    [u2], 2,
  );
  const signed2 = signAndFinalizePsbt(res2.psbtHex, hex.encode(priv));
  const r2 = accept(signed2.txHex);
  check('legacy (btc) key-path tx still accepted (control)', r2.allowed && signed2.chain === 'btc', r2.allowed ? '' : r2['reject-reason']);
}

// ── 2. tapscript multisig 1-of-2, XBT (unified) ──
{
  const privA = schnorr.utils.randomPrivateKey();
  const privB = schnorr.utils.randomPrivateKey();
  const pubs = [hex.encode(schnorr.getPublicKey(privA)), hex.encode(schnorr.getPublicKey(privB))].sort();
  const { createMultisigFromPubkeys } = await import('../src/lib/bitcoin/multisig');
  const wallet = createMultisigFromPubkeys(pubs, 1);
  const tap = multisigTaprootInfo(wallet);
  check('multisig address matches', tap.address === wallet.address);
  const u = await fund(wallet.address);
  // buildMultisigPsbt fetches UTXOs from the network; replicate its input shape offline.
  const tx = new Transaction({ allowUnknownOutputs: true });
  tx.addInput({ txid: u.txid, index: u.vout, witnessUtxo: { script: tap.script, amount: BigInt(u.value) },
    tapInternalKey: tap.tapInternalKey, tapLeafScript: tap.tapLeafScript, tapMerkleRoot: tap.tapMerkleRoot, sighashType: 0x21 });
  tx.addOutputAddress(wallet.address, BigInt(u.value - 3000));
  const psbtHex = hex.encode(tx.toPSBT());
  const { psbtHex: signedHex, signedCount } = signMultisigPsbtWithKeys(psbtHex, [hex.encode(privB)]);
  check('tapscript unified partial-sign added a signature', signedCount === 1);
  const combined = combinePsbtsToRawTx([signedHex]);
  check('combine infers chain xbt from PSBT', combined.chain === 'xbt');
  const r = accept(combined.rawHex);
  check('tapscript 1-of-2 UNIFIED tx accepted by Knots regtest', r.allowed, r.allowed ? '' : r['reject-reason']);
}

console.log(results.join('\n'));
process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0);
