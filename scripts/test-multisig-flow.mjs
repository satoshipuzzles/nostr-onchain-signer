/**
 * Simulates the production multisig signing flow offline:
 * 1. Build 2-of-3 tapscript multisig (same construction as multisig.ts)
 * 2. Build spend PSBT (same as multisig-psbt.ts)
 * 3. Initiator partial-signs
 * 4. Co-signer partial-signs the initiator's PSBT (as /sign page does)
 * 5. Combine + finalize + extract (as psbt-broadcast.ts does)
 */
import { Transaction, p2tr, p2tr_ms, PSBTCombine } from '@scure/btc-signer';
import { hex } from '@scure/base';
import { schnorr } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha256';

function log(label, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ' — ' + extra : ''}`);
}

// ── Keys (like Nostr keys: x-only pubkeys) ─────────────────────
const privs = [1, 2, 3].map((i) => sha256(new TextEncoder().encode(`test-key-${i}`)));
const pubs = privs.map((p) => schnorr.getPublicKey(p)); // x-only 32B

// NUMS internal key (same iteration as unspendableInternalKey)
import { secp256k1 } from '@noble/curves/secp256k1';
function numsKey() {
  let attempt = sha256(new TextEncoder().encode('nostr-onchain-signer/unspendable/v1'));
  for (let i = 0; i < 256; i++) {
    try {
      secp256k1.ProjectivePoint.fromHex(new Uint8Array([0x02, ...attempt]));
      return attempt;
    } catch {
      attempt = sha256(attempt);
    }
  }
  throw new Error('no NUMS');
}
const nums = numsKey();

// Sort pubkeys lexicographically like createMultisigAddress does
const sorted = [...pubs].sort((a, b) => hex.encode(a).localeCompare(hex.encode(b)));

// ── Build wallet like multisigTaprootInfo ──────────────────────
const msScript = p2tr_ms(2, sorted);
const tree = { script: msScript.script, leafVersion: 0xc0 };
const tap = p2tr(nums, tree);
console.log('address:', tap.address);

// ── Build PSBT like buildMultisigPsbt ──────────────────────────
const tx = new Transaction();
tx.addInput({
  txid: '11'.repeat(32),
  index: 0,
  witnessUtxo: { script: tap.script, amount: 100000n },
  tapInternalKey: tap.tapInternalKey,
  tapLeafScript: tap.tapLeafScript,
  tapMerkleRoot: tap.tapMerkleRoot,
});
tx.addOutputAddress('bc1pu0l50h0rd4n2ywaneh843yzhv2ytcjgmskv0w0jzycud7u85lsese8szg8', 50000n);
tx.addOutputAddress(tap.address, 40000n); // change

const basePsbtHex = hex.encode(tx.toPSBT());

// ── Step 1: initiator partial-signs (signMultisigPsbtPartial) ──
function partialSign(psbtHex, priv) {
  const t = Transaction.fromPSBT(hex.decode(psbtHex), { allowUnknownOutputs: true, allowUnknownInputs: true });
  t.sign(priv);
  return hex.encode(t.toPSBT());
}

// Which sorted index is which priv?
const order = sorted.map((pk) => pubs.findIndex((p) => hex.encode(p) === hex.encode(pk)));
console.log('sorted key order (priv indexes):', order);

let sig1Psbt;
try {
  sig1Psbt = partialSign(basePsbtHex, privs[0]);
  log('initiator partial-sign', true);
} catch (e) {
  log('initiator partial-sign', false, e.message);
  process.exit(1);
}

// Verify sig actually added
function countTapSigs(psbtHex) {
  const t = Transaction.fromPSBT(hex.decode(psbtHex), { allowUnknownOutputs: true, allowUnknownInputs: true });
  const input = t.getInput(0);
  return (input.tapScriptSig ?? []).length;
}
log('initiator sig count == 1', countTapSigs(sig1Psbt) === 1, `got ${countTapSigs(sig1Psbt)}`);

// ── Step 2: co-signer signs initiator's PSBT (like /sign page) ──
let sig2Psbt;
try {
  sig2Psbt = partialSign(sig1Psbt, privs[1]);
  log('co-signer partial-sign', true);
} catch (e) {
  log('co-signer partial-sign', false, e.message);
  process.exit(1);
}
log('after co-sign, sig count == 2', countTapSigs(sig2Psbt) === 2, `got ${countTapSigs(sig2Psbt)}`);

// ── Step 3: combine + finalize + extract (combinePsbtsToRawTx) ──
function combineAndExtract(psbtList) {
  const unique = [...new Set(psbtList)];
  let combined;
  if (unique.length === 1) combined = hex.decode(unique[0]);
  else combined = PSBTCombine(unique.map((h) => hex.decode(h)));
  const t = Transaction.fromPSBT(combined, { allowUnknownOutputs: true, allowUnknownInputs: true });
  t.finalize();
  return hex.encode(t.extract());
}

// Case A: the exact production flow — [request.psbt_hex (sig1), response (sig1+sig2)]
try {
  const raw = combineAndExtract([sig1Psbt, sig2Psbt]);
  log('CASE A combine [sig1, sig1+sig2] -> raw tx', true, `${raw.length / 2} bytes`);
} catch (e) {
  log('CASE A combine [sig1, sig1+sig2] -> raw tx', false, e.message);
}

// Case B: two co-signers who each signed the base independently
try {
  const sig2only = partialSign(basePsbtHex, privs[1]);
  const raw = combineAndExtract([sig1Psbt, sig2only]);
  log('CASE B combine [sig1, sig2-independent] -> raw tx', true, `${raw.length / 2} bytes`);
} catch (e) {
  log('CASE B combine [sig1, sig2-independent] -> raw tx', false, e.message);
}

// Case C: 3 signatures on a 2-of-3 (over-complete)
try {
  const sig3Psbt = partialSign(sig2Psbt, privs[2]);
  const raw = combineAndExtract([sig1Psbt, sig2Psbt, sig3Psbt]);
  log('CASE C 3 sigs on 2-of-3 -> raw tx', true, `${raw.length / 2} bytes`);
} catch (e) {
  log('CASE C 3 sigs on 2-of-3 -> raw tx', false, e.message);
}

// Case D: signer whose key is NOT in the multisig
try {
  const outsider = sha256(new TextEncoder().encode('outsider'));
  partialSign(basePsbtHex, outsider);
  log('CASE D outsider sign should FAIL', false, 'signed but should have thrown');
} catch (e) {
  log('CASE D outsider sign correctly fails', true, e.message);
}

// Case E: verify the finalized tx against consensus rules (witness structure)
try {
  const raw = combineAndExtract([sig1Psbt, sig2Psbt]);
  const finalTx = Transaction.fromRaw(hex.decode(raw), { allowUnknownOutputs: true, allowUnknownInputs: true });
  const witness = finalTx.getInput(0).finalScriptWitness;
  console.log('witness stack elements:', witness?.length, witness?.map((w) => w.length));
  // For 2-of-3 CHECKSIGADD: [sig_k3_or_empty, sig_k2_or_empty, sig_k1_or_empty, script, control]
  log('CASE E witness has 5 elements (3 sig slots + script + control)', witness?.length === 5, `got ${witness?.length}`);
} catch (e) {
  log('CASE E witness inspection', false, e.message);
}
