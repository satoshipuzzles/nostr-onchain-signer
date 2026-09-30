# Nostr Onchain Signer

A Chrome extension that acts as a dual-purpose signer for **Bitcoin on-chain transactions** and **Nostr events (NIP-07)**. Enables social multi-sig wallets derived from Nostr public keys.

## Download & install

**[Download the latest release](https://github.com/satoshipuzzles/nostr-onchain-signer/releases/latest)** (`nostr-onchain-signer-vX.Y.Z.zip`) · install guide: **[nostronchain.com/extension](https://nostronchain.com/extension)**

1. Download the `.zip` from the latest release and unzip it.
2. Open `chrome://extensions` (Chrome, Brave, Arc, Edge) and turn on **Developer mode**.
3. Click **Load unpacked** and select the unzipped folder (the one containing `manifest.json`).
4. Pin the extension and open it to create or import your key.

Chromium browsers only for now (Manifest V3 service worker). Prefer a web app? The same signer runs at [client.nostronchain.com](https://client.nostronchain.com). Hardware-backed signing: [nostronchain.com/signer](https://nostronchain.com/signer).

Build it yourself: `npm install && npm run build:ext` → load `dist/`.

## Core Features

### Dual Signer
- **NIP-07 Nostr Signer** — injects `window.nostr` for any Nostr web app.
  If another NIP-07 extension is already installed (Alby, nos2x, or the
  sibling hardware-backed **Pocket Signer Link**), we yield the
  `window.nostr` slot to it and log a note in DevTools — the other
  extension handles Nostr signing, and this extension continues to
  provide the Bitcoin API side-by-side.
- **Bitcoin Transaction Signer** — injects `window.bitcoin` for Taproot key-path and script-path spending. Unique to this extension; always installed.

### Social Multi-Sig
- Derive Bitcoin Taproot addresses from any set of Nostr npubs
- Create m-of-n multi-sig using BIP342 Tapscript (`OP_CHECKSIGADD`)
- Pull keys from your following list or custom key groups
- Participants don't need to opt in — their npub IS a valid Taproot key

### OP_RETURN Nostr Notes
- Embed a Nostr event ID in Bitcoin transactions via OP_RETURN
- Protocol: `NSTR` prefix + version + kind + event_id + optional content hash
- Always under 80 bytes (Knots-compatible)
- Cryptographic link between on-chain payment and off-chain message

### Atomic Send + Note
- Sign a Nostr note and prepare a Bitcoin transaction in one action
- The transaction includes the note's event ID in OP_RETURN
- Creates a verifiable on-chain proof that a payment is linked to a message

## Architecture

```
┌─────────────────────────────────────────────────┐
│                 Web Page                          │
│  window.nostr (NIP-07)  │  window.bitcoin        │
└──────────────┬──────────┴───────────┬────────────┘
               │    postMessage        │
┌──────────────┴──────────────────────┴────────────┐
│              Content Script (bridge)              │
└──────────────────────┬───────────────────────────┘
                       │  chrome.runtime.sendMessage
┌──────────────────────┴───────────────────────────┐
│           Background Service Worker               │
│  ┌─────────┐  ┌──────────┐  ┌────────────────┐  │
│  │Key Vault│  │NIP-07 Sig│  │Bitcoin Signing │  │
│  │(AES-GCM)│  │(Schnorr) │  │(Tapscript/PSBT)│  │
│  └─────────┘  └──────────┘  └────────────────┘  │
└──────────────────────────────────────────────────┘
```

## Tech Stack

- **Crypto**: `@noble/curves`, `@noble/hashes`, `@scure/base`, `@scure/btc-signer`
- **UI**: React 18, Tailwind CSS, Lucide icons
- **Build**: Vite, TypeScript
- **Extension**: Chrome Manifest V3

## Development

```bash
npm install
npm run dev     # Watch mode (rebuilds on change)
npm run build   # Production build
```

### Load in Chrome
1. `npm run build`
2. Open `chrome://extensions`
3. Enable Developer mode
4. Click "Load unpacked" → select the `dist/` folder

### Load in Safari (iOS/macOS)
Use Apple's `safari-web-extension-converter` tool to wrap the built extension for Safari.

## BTC / XBT — the chain split

Since block **961,632** (2026-08-08) there are two Bitcoin chains sharing one history:
**BTC** (SHA-256d, Bitcoin Core) and **XBT** (BLAKE2b proof of work from block 961,640, Bitcoin Knots with the
BIP-110 rules). Every coin from before the split exists on both, and an ordinary signature is valid on both, so a
normal spend *replays*: the coins move on BTC and XBT together.

What this repo does about it:

- **Chain selector** in the block explorer, the wallet, the transaction builder and multisig requests
  (`btc` | `xbt`). XBT data comes from `mempool.guide` through `api/mempool.js?chain=xbt` (it has no CORS and only
  speaks HTTP/1.1). Explorer links go to mempool.space (BTC) or mempool.guide (XBT).
- **`SIGHASH_UNIFIED`** (`packages/core/src/unified-sighash.ts`): XBT's opt-in signature hash (bit `0x20`, tag
  `UnifiedSighash`, Knots PR 357). Every XBT-targeted PSBT is built with hash type `0x21` (ALL|UNIFIED) on all
  inputs and signed with the unified message — key path, tapscript multisig, vault key, NIP-07 `signSchnorr`. Such a
  signature verifies only on XBT, so it can never be replayed onto BTC. Verified against the 166 official Knots test
  vectors (`npm run test:sighash`) and end to end on a Knots regtest node past the activation height
  (`npm run test:regtest`, see `scripts/regtest-e2e.ts`).
- **Split status** per UTXO (unsplit / BTC only / XBT only) by comparing both chains' UTXO sets, shown in Coin
  Control and the explorer's Address tab.
- **"Split coins on XBT"**: one-click self-send of every unsplit coin on XBT with `SIGHASH_UNIFIED`. Once it confirms,
  the BTC-side coins can be spent on BTC normally — their XBT twins are already spent, so nothing replays. The builder
  warns before any BTC spend that would drag unsplit coins along.

## OP_RETURN Protocol Spec

```
Byte layout (41-61 bytes total):
┌──────────┬─────────┬──────┬──────────────────┬───────────────────┐
│ NSTR (4) │ Ver (1) │ Kind │ Event ID (32)    │ Content Hash (20) │
│ 4e535452 │   01    │ (2)  │ sha256 of event  │ optional, trunc.  │
└──────────┴─────────┴──────┴──────────────────┴───────────────────┘
```

## Multi-Sig Derivation

Every Nostr npub is a secp256k1 x-only public key — the exact format Taproot uses. The extension:

1. Collects npubs (from following list, custom groups, or manual entry)
2. Builds a BIP342 Tapscript: `<key1> CHECKSIG <key2> CHECKSIGADD ... <m> NUMEQUAL`
3. Creates a TapLeaf hash from the script
4. Computes the Taproot output key using an unspendable internal key + merkle root
5. Encodes as a `bc1p...` bech32m address

The resulting address can only be spent when `m` of the `n` npub holders sign.

## Security

- Private keys encrypted at rest with AES-256-GCM (PBKDF2 600k iterations)
- Auto-lock after 15 minutes of inactivity
- Keys never leave the background service worker
- Content script only relays messages, never touches keys

## License

MIT
