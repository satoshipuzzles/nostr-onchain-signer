/** Verify @scure/btc-signer accepts our OP_RETURN scripts at all sizes. */
import { buildOpReturnScript } from '../src/lib/bitcoin/opreturn.ts';
import { Transaction } from '@scure/btc-signer';
import { hex } from '@scure/base';

const opts = { allowUnknownOutputs: true, allowUnknownInputs: true };
const fromScript = hex.decode('5120e3ff47dde36d66a23bb3cdcf5890576288bc491b8598f73e422638df70f4fc33');

let failed = 0;
for (const len of [10, 80, 150, 300]) {
  const tx = new Transaction(opts);
  tx.addInput({
    txid: 'f9c649755a0481297956dfe63008539cd88f5226af48641c5656864fd7e723ca',
    index: 0,
    witnessUtxo: { script: fromScript, amount: 200_000n },
  });
  tx.addOutputAddress('bc1pwsnl43ylvmp99ucypw6ehrs2ndt8mds9mqz5a4efywyzy526psss68grpd', 50_000n);
  const script = buildOpReturnScript(new Uint8Array(len).fill(0x42));
  try {
    tx.addOutput({ script, amount: 0n });
    const roundTrip = Transaction.fromPSBT(tx.toPSBT(), opts);
    const out = roundTrip.getOutput(1);
    const ok = (out.script as Uint8Array)[0] === 0x6a && (out.script as Uint8Array).length === script.length;
    console.log(`payload=${len}: script=${script.length}B roundtrip ${ok ? 'PASS' : 'FAIL'}`);
    if (!ok) failed++;
  } catch (err) {
    console.log(`payload=${len}: FAIL — ${err instanceof Error ? err.message : err}`);
    failed++;
  }
}
console.log(failed === 0 ? 'ALL PASS' : `${failed} FAILURES`);
process.exit(failed === 0 ? 0 : 1);
