# Nostr Onchain Signer

A Chrome extension that acts as a dual-purpose signer for **Bitcoin on-chain transactions** and **Nostr events (NIP-07)**. Enables social multi-sig wallets derived from Nostr public keys.

## Core Features

### Dual Signer
- **NIP-07 Nostr Signer** — injects `window.nostr` for any Nostr web app
- **Bitcoin Transaction Signer** — injects `window.bitcoin` for Taproot key-path and script-path spending

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
