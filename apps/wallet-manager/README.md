# Bitcoin Wallet Manager

Sparrow-style Bitcoin wallet manager with Nostr built in. Mobile-first PWA for iPhone and desktop
(MacBook), installable and fully offline-capable. Optional connection to your own node — never
required.

## What it does

- **Wallets**: create keys on-device, import nsec/hex, or add watch-only wallets (npub, pubkey, or
  address). Keys live in an encrypted vault (scrypt + AES-256-GCM) and never leave the device.
- **Transaction Builder**: coin control, multiple outputs, OP_RETURN data of any size (text or hex)
  with live BIP-110 compliance feedback, fee presets + custom rate, RBF, locktime. Both BIP-110-
  compliant and Core-style (large data) transactions are supported.
- **Files**: every PSBT is a document — preview (rendered inputs/outputs/fees/signature status),
  JSON view, raw base64/hex editor, and full revision history. Open, edit, save, share, download
  (.psbt binary / base64 / JSON). Import PSBTs from co-signers by pasting or dropping files.
- **People**: Nostr is the address book. Search anyone by name or npub, send to their taproot
  address derived from their pubkey — or to their **silent payment address** (BIP-352, sender side)
  if their profile publishes one. Unlinkable, no address reuse.
- **Interop, not lock-in**: exports are output descriptors, BIP-329 labels, and a plain-JSON wallet
  manifest — all import into Sparrow, Bitcoin Core, and Electrum. Experimental read-only
  `wallet.dat` key recovery is included for legacy Core wallets.
- **Your node**: point the app at any Esplora/electrs REST endpoint (Umbrel, Start9, etc.) in
  Settings; public providers are the fallback.

## Development

```bash
# from the repo root (uses npm workspaces; Node >= 20 required)
npm install
npm run dev -w bitcoin-wallet-manager     # dev server
npm run build -w bitcoin-wallet-manager   # production PWA build (dist/)
```

Shared Bitcoin primitives (PSBT building/signing, addresses, OP_RETURN protocols, BIP-110,
descriptors, BIP-329, silent payments, PSBT document model) live in `packages/core`
(`@nostr-onchain/core`) and are covered by `scripts/test-core.mts` at the repo root.

## Install as an app

- **iPhone**: open the deployed site in Safari → Share → "Add to Home Screen".
- **Mac**: open in Safari/Chrome → install from the address bar (or File → Add to Dock).
  Once installed it works offline; chain data syncs when you're back online.
