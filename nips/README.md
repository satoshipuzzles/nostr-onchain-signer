# Nostr Onchain Protocol — NIP Drafts

Draft specifications for the protocol implemented in [nostr-onchain-signer](https://github.com/satoshipuzzles/nostr-onchain-signer).

These documents are intended for submission to [nostr-protocol/nips](https://github.com/nostr-protocol/nips). Kind numbers are placeholders until registered.

## Documents

| Draft | Kind(s) | Status |
|-------|---------|--------|
| [NDTM — Nostr-Derived Taproot Multisig](./NDTM.md) | (derivation) | draft |
| [Collaborative PSBT Signing](./collaborative-psbt-signing.md) | 9800–9802 | draft |
| [Onchain Payment Requests](./onchain-payment-requests.md) | 9733 | draft |
| [Bitcoin Event Anchoring (NSTR)](./bitcoin-event-anchoring.md) | OP_RETURN | draft |
| [Social Unlocks](./social-unlocks.md) | 9810–9812 | draft |

## Core thesis

A Nostr `npub` is an x-only secp256k1 public key — the same primitive Taproot uses (BIP-341). Any set of Nostr identities therefore defines a Bitcoin multisig *without opt-in*. Nostr relays replace proprietary coordinator servers; PSBTs and invoices travel as encrypted events.

## Implementation divergences (fix code or relax spec)

| Issue | Spec says | Code today |
|-------|-----------|------------|
| Gift wrap | **MUST** NIP-59 for 9733, 9800–9802 | Comment only; events often published unwrapped |
| Pubkey ordering | **MUST** sort lexicographically by 32-byte x-only key | Insertion order from UI / following list |
| Multisig spend | Real BIP174 PSBT | `RequestSignature.tsx` still sends JSON placeholder |
| Collection mode | Parallel recommended | Publishes to all signers at once but with placeholder PSBT |
| Vault KDF | (recommend scrypt/argon2) | PBKDF2 100k iterations (`vault.ts`); README incorrectly says 600k |
| Descriptor export | Conformance requirement | Not implemented |
| Privacy mode | Optional ECDH-tweaked derivation | Not implemented |

**Priority before NIP PR:** canonical pubkey sort, real multisig PSBT builder, gift-wrap enforcement, descriptor export.

## Suggested PR order to nostr-protocol/nips

1. **NDTM + Collaborative PSBT Signing** (load-bearing pair)
2. **Onchain Payment Requests + NSTR anchoring**
3. **Social Unlocks** (optional; more experimental)

Include a minimal reference verifier (CLI that derives an address from npubs and parses NSTR OP_RETURN) — second implementation is what gets drafts merged.

## Kind registry check

Before opening PRs, verify 9733 and 9800–9812 against the [NIPs kind registry](https://github.com/nostr-protocol/nips/blob/master/README.md) for collisions.
