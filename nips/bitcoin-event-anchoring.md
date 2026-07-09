# NIP-XX
## Bitcoin Event Anchoring (NSTR)

`draft` `optional`

---

Defines an OP_RETURN payload format linking a Bitcoin transaction to a Nostr event.

## Motivation

Payments and multisig spends often correspond to off-chain intent (invoices, board resolutions, messages). Anchoring a Nostr `event id` in OP_RETURN creates a compact, verifiable cross-chain reference provable by any full node or block explorer.

## Format

Protocol identifier: ASCII `NSTR` (`0x4e535452`).

### Payload layout

| Field | Size | Description |
|-------|------|-------------|
| protocol_id | 4 | `NSTR` |
| version | 1 | `0x01` |
| kind | 2 | Event kind, little-endian uint16 |
| event_id | 32 | SHA-256 of the Nostr event |
| content_hash | 20 | OPTIONAL. First 20 bytes of SHA-256(content UTF-8) |

Total: 39 bytes (without content_hash) or 59 bytes (with content_hash).

### Script construction

```
OP_RETURN OP_PUSHDATA <payload>
```

Implementations **MUST** keep total script ≤80 bytes (Bitcoin Knots / standard relay policy).

### Decoding

1. Locate OP_RETURN output.
2. Verify bytes 0–3 == `NSTR`, byte 4 == `0x01`.
3. Read kind (LE uint16), event_id (32 bytes).
4. If 20 bytes remain, treat as optional content_hash.

## Verification

Given a claimed Nostr event:

1. Compute `event.id` per NIP-01; compare to anchored bytes.
2. If `content_hash` present, verify `SHA256(content)[0:20]`.
3. Verify event `kind` matches anchored kind field.
4. Verify event `sig` per NIP-01.

## Common uses

| Anchored kind | Purpose |
|---------------|---------|
| 9733 | Prove on-chain settlement of an onchain invoice |
| 1 | Link payment to a public note |
| 9800 | Reference the signing round that authorized spend |

## Plain-text memo (non-normative extension)

Implementations MAY use a separate OP_RETURN with UTF-8 memo text for human-readable chain messages. This is independent of NSTR and not required for verification.

## Reference implementation

https://github.com/satoshipuzzles/nostr-onchain-signer — `src/lib/bitcoin/opreturn.ts`
