/**
 * Runs packages/core unifiedSighash against the official Knots test vectors
 * (src/test/data/unified_sighash.json). Usage:
 *   npx tsx scripts/test-unified-vectors.ts [path/to/unified_sighash.json]
 */
import { readFileSync } from 'node:fs';
import { unifiedSighash, parseRawTx, type UnifiedScriptType } from '../packages/core/src/unified-sighash';

const file = process.argv[2] ?? new URL('./fixtures/unified_sighash.json', import.meta.url).pathname;
const hex = (h: string) => Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));
const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

type Row = [string, string, number, number, number, [number, string][], string];
const rows = (JSON.parse(readFileSync(file, 'utf8')) as unknown[]).slice(1) as Row[];
let ok = 0;
const bad: string[] = [];
for (const [scriptCode, rawTx, inIdx, hashType, scriptType, spentOutputs, expect] of rows) {
  const tx = parseRawTx(hex(rawTx));
  const spent = spentOutputs.map(([v, s]) => ({ value: BigInt(v), script: hex(s) }));
  const opts = scriptType === 3 ? { leafScript: hex(scriptCode) } : { scriptCode: hex(scriptCode) };
  let got: string;
  try {
    got = toHex(unifiedSighash(tx, inIdx, hashType, scriptType as UnifiedScriptType, spent, opts));
  } catch (e) {
    got = `ERR ${(e as Error).message}`;
  }
  if (got === expect) ok++;
  else bad.push(`type ${scriptType} hashType 0x${hashType.toString(16)}: got ${got} want ${expect}`);
}
console.log(`unified sighash vectors: ${ok} ok, ${bad.length} bad of ${rows.length}`);
for (const b of bad.slice(0, 10)) console.log('  ' + b);
process.exit(bad.length ? 1 : 0);
