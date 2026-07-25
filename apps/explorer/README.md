# Nostr Block Chain — explorer

A block explorer for Nostr events anchored in Bitcoin OP_RETURNs, that is also a full Nostr client.

## What it does

- **Scans Bitcoin blocks in the browser** via public Esplora APIs (no server, no tracking), finds
  every OP_RETURN carrying a Nostr-onchain protocol, and caches results in IndexedDB — blocks are
  immutable, so each block is only ever scanned once. The feed grows as you scan deeper.
- **Renders the Nostr side**: NSTR anchors are resolved from relays, the content is verified
  against the on-chain hash (green "verified on-chain" badge on byte-exact matches), and shown
  with the author's profile, note content, comment thread, reactions, and zap totals.
- **Protocol cards**: NSTR (anchored notes), LOPS (proof of existence), NINV (invoice
  settlements), plus any readable text OP_RETURNs found along the way.
- **Full Nostr client**: login with any NIP-07 extension (Nostr Onchain Signer, Alby, nos2x) to
  comment, react, follow authors, and zap over lightning (NIP-57 with WebLN, or invoice
  copy/`lightning:` fallback).
- **Profiles**: `/p/npub…` shows a user's kind-0 profile plus every anchor published from their
  npub-derived taproot address, discovered directly from the chain.
- **BIP-110 aware**: every anchor is tagged "both chains" (≤83-byte script) or "main chain only
  post-BIP110".

## Development

```bash
# from the repo root (npm workspaces; Node >= 20)
npm install
npm run dev -w nostr-onchain-explorer     # http://localhost:5175
npm run build -w nostr-onchain-explorer   # static site in dist/
```

Deploy `apps/explorer/dist` anywhere static (Vercel, Netlify, GitHub Pages) — it's a pure client
app using hash routing, so no rewrite rules are needed.
