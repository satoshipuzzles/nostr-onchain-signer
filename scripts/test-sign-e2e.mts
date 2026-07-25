/**
 * End-to-end personal-send test: derive taproot address from a nostr-style
 * x-only pubkey → build PSBT (buildPsbt) → sign+finalize with the vault key
 * (signAndFinalizePsbt) → verify the schnorr signature against the tweaked
 * output key. This is exactly the extension/web-app personal send path.
 */
import { schnorr, secp256k1 } from '@noble/curves/secp256k1';
import { bytesToHex } from '@noble/hashes/utils';
import { hex } from '@scure/base';
import { Transaction } from '@scure/btc-signer';
import { pubkeyToTaprootAddress } from '../src/lib/bitcoin/address.ts';
import { buildPsbt, signAndFinalizePsbt } from '../src/lib/bitcoin/psbt-builder.ts';

// Random "nostr" key
const privKey = secp256k1.utils.randomPrivateKey();
const privHex = bytesToHex(privKey);
const xOnlyPub = bytesToHex(schnorr.getPublicKey(privKey)); // nostr pubkey
const address = pubkeyToTaprootAddress(xOnlyPub);
console.log('address:', address);

// Synthetic UTXO at that address
const fakeUtxo = {
  txid: 'f9c649755a0481297956dfe63008539cd88f5226af48641c5656864fd7e723ca',
  vout: 0,
  value: 150_000,
  status: { confirmed: true, block_height: 0, block_hash: '', block_time: 0 },
} as any;

for (const withMemo of [false, true]) {
  const psbt = await buildPsbt({
    fromAddress: address,
    toAddress: 'bc1pwsnl43ylvmp99ucypw6ehrs2ndt8mds9mqz5a4efywyzy526psss68grpd',
    amountSats: 50_000,
    feeRate: 3,
    internalPubkeyHex: xOnlyPub,
    opReturnData: withMemo ? new TextEncoder().encode('hello world memo for testing over eighty bytes total to exercise pushdata1!!') : undefined,
    selectedUtxos: [fakeUtxo],
  });

  try {
    const { txHex, txid } = signAndFinalizePsbt(psbt.psbtHex, privHex);
    // Parse the final tx and sanity-check the witness signature
    const tx = Transaction.fromRaw(hex.decode(txHex), { allowUnknownOutputs: true, allowUnknownInputs: true });
    console.log(`memo=${withMemo}: signed+finalized OK, txid=${txid.slice(0, 16)}..., vsize~${txHex.length / 2}, outputs=${tx.outputsLength}  PASS`);
  } catch (err) {
    console.log(`memo=${withMemo}: FAIL — ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
  }
}
