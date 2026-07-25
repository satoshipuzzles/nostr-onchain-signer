/**
 * Recovery diagnostic: fetch a multisig signing round (kind 9800 request +
 * kind 9801 responses) from public relays and check the multisig address
 * on-chain. Usage: node scripts/recover-round.mjs <roundId>
 */
import { SimplePool } from 'nostr-tools/pool';

const roundId = process.argv[2];
if (!roundId) {
  console.error('Usage: node scripts/recover-round.mjs <roundId>');
  process.exit(1);
}

const RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.snort.social',
  'wss://relay.nostr.band',
  'wss://purplepag.es',
  'wss://nostr-pub.wellorder.net',
  'wss://relay.nostr.bg',
  'wss://nostr.wine',
];

const pool = new SimplePool();

console.log(`Querying ${RELAYS.length} relays for round ${roundId}...\n`);

const [requests, responses] = await Promise.all([
  pool.querySync(RELAYS, { kinds: [9800], '#r': [roundId], limit: 20 }, { maxWait: 15000 }),
  pool.querySync(RELAYS, { kinds: [9801], '#r': [roundId], limit: 50 }, { maxWait: 15000 }),
]);

const matchingReqs = requests.filter((e) => {
  if (!e.tags.some((t) => t[0] === 'r' && t[1] === roundId)) return false;
  try { return JSON.parse(e.content).round_id === roundId; } catch { return false; }
});

console.log(`Found ${matchingReqs.length} matching request event(s) (of ${requests.length} returned)`);

if (matchingReqs.length === 0) {
  console.log('\nNO REQUEST EVENT FOUND on these relays.');
  process.exit(2);
}

const req = matchingReqs.sort((a, b) => b.created_at - a.created_at)[0];
const content = JSON.parse(req.content);

console.log('\n=== SIGNING REQUEST ===');
console.log('event id:        ', req.id);
console.log('author pubkey:   ', req.pubkey);
console.log('created at:      ', new Date(req.created_at * 1000).toISOString());
console.log('multisig address:', content.multisig_address);
console.log('threshold:       ', content.threshold, 'of', content.total_signers);
console.log('signer pubkeys:  ', JSON.stringify(content.signer_pubkeys, null, 2));
console.log('amount (sats):   ', content.amount_sats);
console.log('recipient:       ', content.recipient);
console.log('memo:            ', content.memo);
console.log('expires_at:      ', content.expires_at, content.expires_at ? `(${new Date(content.expires_at * 1000).toISOString()})` : '(none)');
console.log('signed_count:    ', content.signed_count);
console.log('psbt_hex length: ', (content.psbt_hex || '').length);

console.log('\n=== SIGNING RESPONSES (kind 9801) ===');
const sigs = [];
for (const evt of responses) {
  try {
    const c = JSON.parse(evt.content);
    if (c.round_id !== roundId) continue;
    console.log(`- from ${evt.pubkey.slice(0, 16)}... accepted=${c.accepted} at ${new Date(evt.created_at * 1000).toISOString()} psbt_len=${(c.psbt_hex || '').length}`);
    if (c.accepted && c.psbt_hex) sigs.push({ pubkey: evt.pubkey, psbt: c.psbt_hex });
  } catch { /* skip */ }
}
if (sigs.length === 0) console.log('(none found)');

// On-chain check via mempool.space
const addr = content.multisig_address;
if (addr) {
  console.log('\n=== ON-CHAIN STATE ===');
  try {
    const [addrInfo, utxos] = await Promise.all([
      fetch(`https://mempool.space/api/address/${addr}`).then((r) => r.json()),
      fetch(`https://mempool.space/api/address/${addr}/utxo`).then((r) => r.json()),
    ]);
    const funded = addrInfo.chain_stats.funded_txo_sum + addrInfo.mempool_stats.funded_txo_sum;
    const spent = addrInfo.chain_stats.spent_txo_sum + addrInfo.mempool_stats.spent_txo_sum;
    console.log('address:         ', addr);
    console.log('balance (sats):  ', funded - spent);
    console.log('total received:  ', funded);
    console.log('total spent:     ', spent);
    console.log('utxos:');
    for (const u of utxos) {
      console.log(`  - ${u.txid}:${u.vout}  ${u.value} sats  confirmed=${u.status.confirmed}`);
    }
  } catch (err) {
    console.log('on-chain lookup failed:', err.message);
  }
}

// Dump full data for recovery use
console.log('\n=== FULL REQUEST CONTENT (JSON) ===');
console.log(JSON.stringify(content, null, 2));

process.exit(0);
