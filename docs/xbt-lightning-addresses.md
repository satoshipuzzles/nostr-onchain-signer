# XBT Lightning Addresses

How a wallet or Nostr client tells whether a Lightning Address is on the
XBT (BLAKE2b) Lightning network or the BTC (SHA-256d) one, and how a person
publishes an XBT address. Three layers, each usable on its own; clients
should check them in this order.

## 1. Profile: `lud16_xbt`

A kind-0 profile can carry a second Lightning Address for XBT:

```json
{ "name": "bigfoot", "lud16": "me@btc-wallet.example", "lud16_xbt": "bigfoot@nostronchain.com" }
```

- `lud16_xbt` is always paid on XBT Lightning.
- `lud16` stays what every Nostr client already understands. It may point
  at either network; use layers 2 and 3 to find out which.
- Zap requests sent to either address carry a `["chain", "xbt" | "btc"]`
  tag, so receipts show which network a zap travelled on.

## 2. LNURL-pay: `chain`

The `payRequest` response of an address may declare its network:

```json
{ "tag": "payRequest", "callback": "…", "chain": "xbt", … }
```

`"chain": "xbt"` or `"chain": "btc"`. An address that can mint invoices on
both may send `"chains": ["xbt", "btc"]`. Unknown fields are ignored by
LNURL wallets, so this is safe to add today.

## 3. The invoice itself (always works)

Every invoice minted by an XBT Lightning node sets feature bit **512 or 513**
(`option_blake2b`, lightning-blake2b/bolts#3) in its BOLT-11 feature field
(tagged field `9`). BTC nodes never set it.

So a client that knows nothing else can ask the address for a
minimum-amount invoice and read the bit:

1. `GET https://<domain>/.well-known/lnurlp/<name>`
2. `GET <callback>?amount=<minSendable>`
3. Decode `pr`; bit 512/513 set → XBT, otherwise BTC.

The probe invoice is never paid and simply expires. Cache the answer
(a day is reasonable): addresses rarely change network.

Before paying any invoice, check the bit again against the wallet that
will pay it. An XBT node refuses an invoice without the bit
("invoice does not set option_blake2b"), and the reverse fails too, but a
clear message before anything is sent is better than a failed payment.

## Reference implementation

`src/lib/nostr/lightning-chain.ts` (`detectAddressChain`, `invoiceChain`),
used by `ZapDialog.tsx`. Our own addresses (`bigfoot@nostronchain.com`,
`bigfoot@lightning.nostronchain.com`) publish `"chain": "xbt"`.
