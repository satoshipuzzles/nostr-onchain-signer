# NIP-XX
## Social Unlocks

`draft` `optional`

---

Defines kinds `9810` (unlock definition), `9811` (signature contribution), and `9812` (reveal) for threshold-gated content release using Nostr social graphs.

## Motivation

Content creators want to gate images, files, or messages behind collective social proof ("10 of my followers must sign to reveal"). This reuses Nostr identity and Schnorr signatures without a central gatekeeper.

## Kind 9810 — Social Unlock Definition

Creator publishes encrypted content metadata and threshold.

### Content (JSON)

```jsonc
{
  "threshold": 3,                    // REQUIRED. Signatures needed
  "content_type": "text|image|...",  // REQUIRED
  "ciphertext": "...",               // REQUIRED. Encrypted payload or URL
  "preview": "...",                  // OPTIONAL. Public teaser
  "description": "..."               // OPTIONAL
}
```

### Tags

- `["t", "social-unlock"]`
- `["p", <eligible_signer>]` — optional allowlist; if omitted, policy is implementation-defined (e.g. followers only)

## Kind 9811 — Signature Contribution

An eligible user signs to contribute toward the threshold.

### Content

JSON or structured payload referencing the `9810` event and containing a Schnorr signature over a protocol-defined digest.

### Tags

- `["e", <unlock_event_id>]`
- `["p", <creator_pubkey>]`

## Kind 9812 — Reveal

Published by creator once threshold met.

### Content

Decrypted content or decryption key material.

### Tags

- `["e", <unlock_event_id>]`
- `["t", "social-unlock-reveal"]`

## Security considerations

- Encryption scheme and key derivation MUST be specified in a future revision (reference impl uses app-local conventions).
- Follower eligibility MUST be verified against kind `3` contact lists or explicit `p` tags — not honor-system.
- This NIP does not define Bitcoin spending; it is orthogonal to NDTM.

## Reference implementation

https://github.com/satoshipuzzles/nostr-onchain-signer — `src/lib/nostr/social-unlock.ts`, kinds `9810`–`9812` in `src/lib/nostr/kinds.ts`

**Status:** experimental; encryption and eligibility rules need hardening before wide adoption.
