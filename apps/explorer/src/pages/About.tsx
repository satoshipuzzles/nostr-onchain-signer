import { Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';

export function About() {
  return (
    <div className="space-y-5">
      <Link to="/" className="btn-ghost text-xs -ml-2">
        <ArrowLeft size={14} /> Feed
      </Link>

      <h1 className="text-2xl font-bold">What is this?</h1>

      <div className="card p-5 space-y-3 text-sm text-zinc-300 leading-relaxed">
        <p>
          The <strong>Nostr Block Chain</strong> is a block explorer for Nostr events that live inside Bitcoin. When
          someone publishes a note with the{' '}
          <a className="text-bitcoin underline" href="https://github.com/satoshipuzzles/nostr-onchain-signer" target="_blank" rel="noreferrer">
            Nostr Onchain Signer
          </a>
          , the note goes to Nostr relays <em>and</em> a compact fingerprint goes into a Bitcoin OP_RETURN output —
          an immutable, timestamped anchor that no relay can delete.
        </p>
        <p>
          This site scans Bitcoin blocks in your browser, finds those anchors, fetches the referenced events from
          relays, and verifies them against the on-chain hash. Green shield = the content you're reading is byte-for-byte
          what was anchored.
        </p>
      </div>

      <div className="card p-5 space-y-3 text-sm text-zinc-300">
        <h2 className="font-semibold">The protocols</h2>
        <ul className="space-y-2">
          <li>
            <span className="text-nostr font-semibold">NSTR</span> — a Nostr note anchor: event id, kind, and an
            optional truncated SHA-256 of the content (41–61 byte payload).
          </li>
          <li>
            <span className="text-sky-400 font-semibold">LOPS</span> — "Light OPs" proof of existence: the SHA-256 of
            any Nostr event id, anchored forever.
          </li>
          <li>
            <span className="text-emerald-400 font-semibold">NINV</span> — invoice settlement proof: hash of a Nostr
            invoice event, written on-chain when it's paid.
          </li>
          <li>
            <span className="text-zinc-300 font-semibold">TEXT</span> — any other readable OP_RETURN message we find
            along the way.
          </li>
        </ul>
      </div>

      <div className="card p-5 space-y-3 text-sm text-zinc-300">
        <h2 className="font-semibold">It's also a Nostr client</h2>
        <p>
          Login with any NIP-07 extension (Nostr Onchain Signer, Alby, nos2x) to comment on anchored notes, react,
          follow authors, and zap them over lightning (NIP-57). Profiles show every anchor an identity has published
          from its npub-derived taproot address.
        </p>
        <p className="text-xs text-zinc-500">
          Scanning happens client-side against public Esplora APIs and is cached in your browser — blocks are immutable,
          so each block only ever needs to be scanned once. No server, no tracking.
        </p>
      </div>
    </div>
  );
}
