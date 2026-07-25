/** Explorer validation: anchor extraction, bolt11 parsing, live block endpoints. */
import { encodeNostrOpReturn, encodeLightOp, encodeInvoiceOpReturn, encodeCustomOpReturn, EsploraClient } from '../packages/core/src/index.ts';
import { anchorsFromTx } from '../apps/explorer/src/lib/scanner.ts';

let failed = 0;
const check = (name: string, ok: boolean, detail?: string) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) failed++;
};

const eventId = 'a'.repeat(64);
const nstr = encodeNostrOpReturn({ eventId, kind: 1, content: 'hello nostr block chain' });
const lops = encodeLightOp(eventId);
const ninv = encodeInvoiceOpReturn(eventId);
const text = encodeCustomOpReturn('gm from the block chain', 'text');

const fakeTx = {
  txid: 'f'.repeat(64),
  version: 2,
  locktime: 0,
  size: 300,
  weight: 1200,
  fee: 1234,
  status: { confirmed: true, block_height: 900000, block_time: 1750000000 },
  vin: [],
  vout: [
    { scriptpubkey: nstr.scriptHex, value: 0 },
    { scriptpubkey: lops.scriptHex, value: 0 },
    { scriptpubkey: ninv.scriptHex, value: 0 },
    { scriptpubkey: text.scriptHex, value: 0 },
    { scriptpubkey: '51201234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef', value: 5000 },
  ],
} as never;

const anchors = anchorsFromTx(fakeTx);
check('finds 4 anchors, skips p2tr output', anchors.length === 4, String(anchors.length));
check('NSTR decoded', anchors[0]?.protocol === 'NSTR' && anchors[0].nostrEventId === eventId && anchors[0].nostrKind === 1);
check('LOPS decoded', anchors[1]?.protocol === 'LOPS' && !!anchors[1].hash);
check('NINV decoded', anchors[2]?.protocol === 'NINV' && !!anchors[2].hash);
check('TEXT decoded', anchors[3]?.protocol === 'TEXT' && anchors[3].text === 'gm from the block chain');
check('fee + height carried', anchors[0].feeSats === 1234 && anchors[0].blockHeight === 900000);

// bolt11 amount parsing (nostr lib touches localStorage at load — stub it for Node)
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};
const { bolt11Sats } = await import('../apps/explorer/src/lib/nostr.ts');
check('bolt11 21 sats', bolt11Sats('lnbc210n1p...') === 21, String(bolt11Sats('lnbc210n1p...')));
check('bolt11 1000 sats', bolt11Sats('lnbc10u1p...') === 1000);
check('bolt11 0.001 btc', bolt11Sats('lnbc1m1p...') === 100_000);

// Live: new block endpoints
const client = new EsploraClient();
try {
  const tip = await client.getTipHeight();
  const hash = await client.getBlockHashAtHeight(tip);
  const block = await client.getBlock(hash);
  const txs = await client.getBlockTxs(hash, 0);
  check('live: tip/hash/block/txs endpoints', tip > 900000 && block.height === tip && txs.length > 0, `tip=${tip} txs=${txs.length}`);
} catch (err) {
  check('live: tip/hash/block/txs endpoints', false, err instanceof Error ? err.message : String(err));
}

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILURES`);
process.exit(failed === 0 ? 0 : 1);
