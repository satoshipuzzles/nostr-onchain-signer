import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { FileText, Upload, FileJson, Wallet, StickyNote, ChevronRight } from 'lucide-react';
import { base64 } from '@scure/base';
import { parseAnyPsbt, importWalletDat, parseManifest } from '@nostr-onchain/core';
import { listDocs, createDoc, type WalletDoc, type DocKind } from '../lib/storage';

const KIND_ICON: Record<DocKind, typeof FileText> = {
  psbt: FileText,
  wallet: Wallet,
  labels: FileJson,
  note: StickyNote,
};

export function Files() {
  const [docs, setDocs] = useState<WalletDoc[]>([]);
  const [error, setError] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    listDocs().then(setDocs);
  }, []);

  async function handleImport(file: File) {
    setError('');
    try {
      const buf = new Uint8Array(await file.arrayBuffer());
      const asText = new TextDecoder().decode(buf);

      // 1. Binary or text PSBT
      try {
        const psbt = parseAnyPsbt(buf[0] === 0x70 ? buf : asText.trim());
        const doc = await createDoc('psbt', file.name.replace(/\.(psbt|txt)$/i, ''), base64.encode(psbt));
        setDocs(await listDocs());
        return void doc;
      } catch {
        // not a PSBT
      }

      // 2. Wallet manifest JSON
      try {
        parseManifest(asText);
        await createDoc('wallet', file.name.replace(/\.json$/i, ''), asText);
        setDocs(await listDocs());
        return;
      } catch {
        // not a manifest
      }

      // 3. wallet.dat (experimental)
      if (/\.dat$/i.test(file.name)) {
        const result = importWalletDat(buf);
        const summary = JSON.stringify(result, null, 2);
        await createDoc('note', `${file.name} import (experimental)`, summary);
        setDocs(await listDocs());
        setError(
          result.candidateKeys.length > 0
            ? `Found ${result.candidateKeys.length} candidate key(s) — open the import report to review.`
            : 'No plaintext keys found in this .dat file — see the import report.'
        );
        return;
      }

      // 4. BIP-329 JSONL or plain text → note document
      await createDoc('note', file.name, asText);
      setDocs(await listDocs());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import failed');
    }
  }

  return (
    <div className="space-y-5">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Files</h1>
          <p className="text-stone-400 text-sm">PSBTs, wallet files, and labels — with revision history.</p>
        </div>
        <button className="btn-primary" onClick={() => fileInput.current?.click()}>
          <Upload size={16} /> Import
        </button>
        <input
          ref={fileInput}
          type="file"
          hidden
          accept=".psbt,.txt,.json,.jsonl,.dat"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) handleImport(f);
            e.target.value = '';
          }}
        />
      </header>

      {error && <p className="text-amber-400 text-sm">{error}</p>}

      <div className="space-y-2">
        {docs.length === 0 && (
          <div className="card text-center text-stone-400 text-sm py-10">
            No files yet. Build a transaction or import a .psbt, wallet .json, or .dat file.
          </div>
        )}
        {docs.map((doc) => {
          const Icon = KIND_ICON[doc.kind] ?? FileText;
          return (
            <Link key={doc.id} to={`/files/${doc.id}`} className="card flex items-center gap-3 hover:border-accent transition-colors">
              <Icon size={20} className="text-accent shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="font-semibold text-sm truncate">{doc.name}</div>
                <div className="text-xs text-stone-500">
                  {doc.kind.toUpperCase()} · {doc.revisions.length} revision{doc.revisions.length === 1 ? '' : 's'} ·{' '}
                  {new Date(doc.updatedAt).toLocaleString()}
                </div>
              </div>
              <ChevronRight size={16} className="text-stone-600 shrink-0" />
            </Link>
          );
        })}
      </div>
    </div>
  );
}
