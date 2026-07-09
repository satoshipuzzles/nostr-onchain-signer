# NIP-XX
## Collaborative PSBT Signing over Nostr

`draft` `optional`

---

Defines kinds `9800` (signing request), `9801` (signing response), and `9802` (signing round chat) for coordinating multi-signature Bitcoin transactions between Nostr identities.

Requires: [NDTM](./NDTM.md) for address derivation verification.

## Motivation

Mainstream multisig routes PSBT coordination through company servers. Signers in an NDTM multisig already share identity and messaging on Nostr. This NIP specifies the message flow so any conforming wallet can participate without a central coordinator.

## Transport

Kinds `9800` and `9801` contain PSBTs revealing UTXOs, balances, and spending intent. They **MUST** be published as NIP-59 gift wraps (kind `1059`) — one sealed wrap per recipient. They **MUST NOT** be published unwrapped on public relays.

Kind `9802` **MUST** likewise be gift-wrapped to every round participant.

## Round identity

`round_id`: client-generated string, unique per initiator, **SHOULD** be ≥16 bytes of entropy (32 hex chars or UUID).

All three kinds include tag `["r", <round_id>]`.

## Kind 9800 — Signing Request

Published by the round initiator (or relayer in sequential mode) to a co-signer.

### Content (JSON)

```jsonc
{
  "psbt_hex": "...",              // REQUIRED. Current PSBT, hex-encoded (BIP-174)
  "round_id": "...",              // REQUIRED
  "multisig_address": "bc1p...",  // REQUIRED
  "threshold": 2,                 // REQUIRED. m
  "signed_count": 1,              // REQUIRED. signatures already in psbt_hex
  "total_signers": 3,             // REQUIRED. n
  "memo": "...",                  // OPTIONAL. Human hint only
  "op_return_event_id": "...",    // OPTIONAL. See Bitcoin Event Anchoring NIP
  "expires_at": 1767225600        // REQUIRED. Unix seconds
}
```

### Tags

- `["p", <co_signer_pubkey>]` — recipient
- `["r", <round_id>]`
- `["a", <multisig_address>]`

## Kind 9801 — Signing Response

Published by a co-signer to the initiator.

### Content (JSON)

```jsonc
{
  "round_id": "...",     // REQUIRED
  "accepted": true,      // REQUIRED. false = declined
  "psbt_hex": "...",     // REQUIRED when accepted
  "message": "..."       // OPTIONAL. Decline reason, etc.
}
```

When `accepted` is true, `psbt_hex` is the input PSBT with **only this signer's** partial signature added (parallel mode) or the accumulated PSBT (sequential mode).

### Tags

- `["p", <initiator_pubkey>]`
- `["r", <round_id>]`
- `["e", <request_event_id>]`

## Kind 9802 — Round Chat

Free-form discussion among participants.

### Content (JSON)

```jsonc
{
  "round_id": "...",
  "message": "..."
}
```

### Tags

- `["r", <round_id>]`
- `["p", <participant_pubkey>]` — one per participant

On broadcast completion, initiator **SHOULD** post `message: "broadcast:<txid>"`.

## Collection modes

### Parallel (RECOMMENDED)

Initiator sends the same base PSBT to all required co-signers simultaneously. Each returns `9801` with the base PSBT plus only their signature. Initiator combines per BIP-174 (Tapscript partial Schnorr signatures do not conflict).

Advantages: one round-trip, tolerant of single relay delivery failure.

### Sequential

Each signer forwards the accumulating PSBT via a new `9800` with incremented `signed_count`. Implementations **MUST** accept incoming requests in either mode.

Disadvantage: one unreachable signer stalls the round.

## Signer obligations

Before signing, wallets **MUST**:

1. Parse the PSBT independently and display every output address, amount, fee, and OP_RETURN — derived from the PSBT, never from `memo` or other metadata.
2. Verify inputs spend from a multisig whose address they independently derived per [NDTM](./NDTM.md), with their key in the sorted set.
3. If `op_return_event_id` is present, fetch that event, verify `id` and `sig`, and show its content before signing.
4. Refuse to sign after `expires_at`.

Signers **MUST** sign only their own leaf-script sighash and **MUST NOT** alter transaction structure. Combiners **MUST** verify each partial signature before merging.

## Completion

When `m` valid signatures are collected, initiator finalizes witness per NDTM, broadcasts, and announces `txid` via `9802`.

## Security considerations

- **PSBT is source of truth.** Metadata fields are unauthenticated hints.
- **Replay:** partial signatures commit to a specific tx digest; wallets SHOULD track responded `round_id`s.
- **Leakage:** gift wrap hides content but timing/recipient patterns may reveal coordination. High-privacy deployments SHOULD use dedicated relay sets per round.
- **Spam:** unsolicited `9800` events are large. Wallets SHOULD surface only requests for locally registered multisigs or from followed pubkeys.

## Reference implementation

https://github.com/satoshipuzzles/nostr-onchain-signer — `src/lib/nostr/kinds.ts`, `src/lib/nostr/signing-inbox.ts`, `src/popup/pages/SigningInbox.tsx`

**Known gaps:** gift wrap not enforced; multisig spend path uses JSON placeholder instead of real PSBT in `RequestSignature.tsx`.
