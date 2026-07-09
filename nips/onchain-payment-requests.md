# NIP-XX
## Onchain Payment Requests

`draft` `optional`

---

Defines kind `9733` — a Nostr-native request for Layer-1 Bitcoin payment, analogous to kind `9734` (Lightning zap request) but for on-chain settlement.

## Motivation

BIP-70 payment requests failed (centralization, HTTPS, wallet fragmentation). Nostr already carries payment intent between identities. Kind `9733` standardizes an invoice event that wallets, explorers, and merchants can consume. Settlement is proven on-chain via [Bitcoin Event Anchoring](./bitcoin-event-anchoring.md).

## Kind 9733 — Onchain Invoice

### Content (JSON)

```jsonc
{
  "address": "bc1p...",           // REQUIRED. Recipient Taproot address
  "amount_sats": 100000,          // OPTIONAL. 0 or omitted = any amount
  "memo": "...",                  // OPTIONAL
  "expires_at": 1767225600,       // OPTIONAL. Unix seconds
  "multisig_config": {            // OPTIONAL. If address is NDTM-derived
    "threshold": 2,
    "pubkeys": ["<hex>", "..."]   // Sorted per NDTM
  }
}
```

### Tags

- `["p", <payer_or_recipient_pubkey>]` — counterparty (implementation-defined: creator tags intended payer)
- `["a", <address>]` — Bitcoin address
- `["amount", "<sats>"]` — optional duplicate for filterability

### Transport

**MUST** be gift-wrapped (NIP-59) when sent to a specific payer. Public invoices (donation addresses) MAY be published unwrapped at creator discretion.

## Payer workflow

1. Fetch and verify kind `9733` (signature, expiry, address format).
2. If `multisig_config` present, independently verify address per [NDTM](./NDTM.md).
3. Build PSBT (or raw tx) paying `address` for `amount_sats`.
4. Optionally embed `event.id` in OP_RETURN per [Bitcoin Event Anchoring](./bitcoin-event-anchoring.md) — proves which invoice was settled.
5. Broadcast.

## Recipient workflow

1. Monitor address via Esplora or node.
2. Match incoming tx: if OP_RETURN contains invoice event id, mark invoice settled.
3. Optionally publish kind `1` or `9802` note referencing txid.

## Relationship to Lightning

Kind `9733` is intentionally parallel to NIP-57 (`9734`/`9735`). Clients MAY display both options. No conversion between layers is implied.

## Security considerations

- Invoice `address` is not authenticated beyond the event signature — verify against expected NDTM derivation or known personal address.
- Unwrapped public invoices reveal payment relationships on relays.

## Reference implementation

https://github.com/satoshipuzzles/nostr-onchain-signer — `src/lib/nostr/kinds.ts`, `src/popup/components/InvoiceCreator.tsx`, `src/popup/pages/InvoicePage.tsx`
