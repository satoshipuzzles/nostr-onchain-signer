import { buildOpReturnScript, encodeCustomOpReturn } from '../src/lib/bitcoin/opreturn.ts';
import { checkOpReturnCompliance, opReturnScriptSize } from '../src/lib/bitcoin/bip110.ts';

let failed = 0;
function check(name: string, cond: boolean) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failed++;
}

for (const len of [1, 75, 76, 80, 83, 100, 255, 256, 300]) {
  const payload = new Uint8Array(len).fill(0xab);
  const script = buildOpReturnScript(payload);
  check(`len=${len}: starts with OP_RETURN`, script[0] === 0x6a);
  if (len <= 75) {
    check(`len=${len}: direct push`, script[1] === len && script.length === 2 + len);
  } else if (len <= 255) {
    check(`len=${len}: OP_PUSHDATA1`, script[1] === 0x4c && script[2] === len && script.length === 3 + len);
  } else {
    check(`len=${len}: OP_PUSHDATA2`, script[1] === 0x4d && (script[2] | (script[3] << 8)) === len && script.length === 4 + len);
  }
  check(`len=${len}: size helper matches`, opReturnScriptSize(len) === script.length);
  const c = checkOpReturnCompliance(len);
  check(`len=${len}: compliance ${c.bip110Compliant}`, c.bip110Compliant === (script.length <= 83));
}

// hex + text encoders
const hexEnc = encodeCustomOpReturn('deadBEEF', 'hex');
check('hex encode', hexEnc.payload.length === 4 && hexEnc.scriptHex === '6a04deadbeef');
const textEnc = encodeCustomOpReturn('hi', 'text');
check('text encode', textEnc.payload.length === 2 && textEnc.scriptHex === '6a026869');
let threw = false;
try { encodeCustomOpReturn('xyz', 'hex'); } catch { threw = true; }
check('bad hex throws', threw);

// boundary: 80-byte payload → 83-byte script (largest compliant with PUSHDATA1)
check('80B payload = 83B script = compliant', checkOpReturnCompliance(80).bip110Compliant);
check('81B payload = 84B script = NOT compliant', !checkOpReturnCompliance(81).bip110Compliant);

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILURES`);
process.exit(failed === 0 ? 0 : 1);
