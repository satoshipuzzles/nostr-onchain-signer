# NIP-NDTM
## Nostr-Derived Taproot Multisig

`draft` `optional`

---

Defines how to derive a Bitcoin Taproot (P2TR) script-path multisig address from a set of Nostr public keys (x-only secp256k1, 32 bytes) without requiring participants to opt in.

Referenced by: Collaborative PSBT Signing, Onchain Payment Requests.

## Motivation

Bitcoin multisig products (Casa, Unchained, Nunchuk) depend on proprietary coordination servers and account systems. Nostr already provides identity (npub) and transport (relays). Because every npub is a valid x-only Taproot key, a group of Nostr identities implicitly defines a spend condition. This NIP normatively specifies that derivation so independent wallets produce identical addresses.

## Definitions

- **x-only pubkey**: 32-byte secp256k1 public key (BIP-340); identical to the decoded payload of an npub.
- **Participant set**: unordered collection of x-only pubkeys identified by Nostr hex pubkeys or npubs.
- **m-of-n**: threshold `m`, total keys `n`.

## Specification

### 1. Pubkey normalization

1. Decode each participant npub or hex pubkey to a 32-byte x-only key.
2. **Sort all keys lexicographically** by raw byte value (ascending). Implementations **MUST** sort; address derivation is undefined if order differs.
3. Reject duplicates. Reject keys that are not valid x-only secp256k1 points.

### 2. Tapscript leaf (BIP-342)

Build a single leaf script using `OP_CHECKSIG` / `OP_CHECKSIGADD` / `OP_NUMEQUAL`:

```
<key_1> OP_CHECKSIG
<key_2> OP_CHECKSIGADD
...
<key_n> OP_CHECKSIGADD
<m> OP_NUMEQUAL
```

Where `<key_i>` are the sorted 32-byte x-only pubkeys and `<m>` is the threshold encoded per standard script number rules.

### 3. Internal key (NUMS)

The Taproot internal key **MUST** be an unspendable NUMS point so spending is forced through the script path.

Normative derivation string:

```
SHA256("nostr-onchain-signer/unspendable/v1")
```

Lift to a valid x-only point per BIP-341 (iterate SHA256 on failure, max 256 attempts).

> Future versions MAY define alternate derivation strings with an explicit version tag in wallet metadata. v1 implementations MUST use the string above for interoperability with nostr-onchain-signer.

### 4. Taproot output

1. `leaf_hash = tagged_hash("TapLeaf", leaf_version || compact_size(script) || script)` with `leaf_version = 0xc0`.
2. `output_key = internal_key + tagged_hash("TapTweak", internal_key || leaf_hash) * G` (BIP-341).
3. Encode as bech32m witness version 1: `bc1p...` (mainnet) or `tb1p...` (testnet).

### 5. Witness for script-path spend

When spending, the witness stack **MUST** be (bottom to top):

1. Empty signatures for keys that did not sign (BIP-342 `OP_CHECKSIGADD` convention).
2. Schnorr signatures for signing keys, in **reverse script key order** (last key in script signed first).
3. The leaf script.
4. The control block (single-leaf tree, parity bit from output key).

### 6. Descriptor export (conformance)

Conforming wallets **MUST** be able to export a recovery descriptor for the script-path spend:

```
tr(<internal_key>)<{sorted_key_1>,<sorted_key_2>,...}>/[<m>]/<leaf_hash>
```

Exact descriptor syntax MAY follow `[BIP 389](https://github.com/bitcoin/bips/blob/master/bip-0389.mediawiki)` tr() conventions. The exported artifact MUST include: sorted pubkeys, threshold, internal key hex, leaf script hex, and bech32 address.

Recovery in Bitcoin Core, Sparrow, or any PSBT-capable wallet without this software MUST be possible from the descriptor alone.

### 7. Privacy considerations

Because pubkeys are public, anyone can compute the multisig address for any published npub set (the "leaderboard problem"). Implementations MAY offer a **privacy mode** that tweaks the leaf script with an ECDH shared secret among participants; such modes MUST use a distinct derivation version and MUST NOT be mixed with v1 addresses.

### 8. Future extensions (non-normative)

- Additional tap tree leaves: timelocked fallback (`OP_CHECKSEQUENCEVERIFY`), heir paths, degraded 1-of-n after N blocks.
- MuSig2/FROST key-path spends (single-sig appearance on-chain). Reserved; not part of v1.

## Reference implementation

https://github.com/satoshipuzzles/nostr-onchain-signer — `src/lib/bitcoin/multisig.ts`

**Known gap:** reference implementation does not yet sort pubkeys before script construction.
