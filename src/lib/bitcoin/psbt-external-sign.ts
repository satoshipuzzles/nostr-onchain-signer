/**
 * Sign PSBTs via external browser wallet APIs — no nsec in the web app.
 *
 * Strategies (in order):
 * 1. WebBTC signPsbt (Alby) — extension signs full PSBT
 * 2. NIP-07 signSchnorr — we build sighash, extension signs hash, we attach sig
 * 3. window.bitcoin.signPsbt (our extension with vault key)
 */

import { Transaction, getInputType, SigHash } from '@scure/btc-signer';
import { hex, base64 } from '@scure/base';
import { concatBytes } from '@noble/hashes/utils';
import type { VaultData } from '@/lib/crypto/vault';

export type BitcoinSignerSource = 'vault' | 'webbtc' | 'nip07-schnorr' | 'bitcoin-api' | 'nip46-amber';

export interface SignedTxResult {
  txHex: string;
  txid: string;
  source: BitcoinSignerSource;
}

export interface BitcoinSignerInfo {
  webbtc: boolean;
  signSchnorr: boolean;
  bitcoinApi: boolean;
  label: string;
}

type NostrWindow = Window & {
  nostr?: {
    getPublicKey?: () => Promise<string>;
    signSchnorr?: (hash: string) => Promise<string>;
  };
  webbtc?: { signPsbt?: unknown; enable?: () => Promise<void> };
  bitcoin?: { signPsbt?: unknown };
};

function isPwaMode(): boolean {
  try {
    return (globalThis as { chrome?: { runtime?: { id?: string } } }).chrome?.runtime?.id === 'pwa-mode';
  } catch {
    return false;
  }
}

/** Prompt the user's browser extension before signing (Alby enable / NIP-07 connect). */
export async function promptExtensionAccess(): Promise<void> {
  const w = window as NostrWindow;
  if (w.webbtc?.enable) {
    await w.webbtc.enable();
    return;
  }
  if (w.nostr?.getPublicKey) {
    await w.nostr.getPublicKey();
  }
}

export function detectBitcoinSigners(): BitcoinSignerInfo {
  const w = window as NostrWindow;
  const hasWebbtc = typeof w.webbtc?.signPsbt === 'function';
  const hasSchnorr = typeof w.nostr?.signSchnorr === 'function';
  const hasBitcoinApi = typeof w.bitcoin?.signPsbt === 'function';
  let label = 'None detected';
  if (hasWebbtc) label = 'Alby (WebBTC)';
  else if (hasSchnorr && isPwaMode()) label = 'NIP-07 signSchnorr';
  else if (hasSchnorr) label = 'NIP-07 signSchnorr (Alby, etc.)';
  else if (hasBitcoinApi && isPwaMode()) label = 'Nostr Onchain extension';
  else if (hasBitcoinApi) label = 'Nostr Onchain extension';
  else if (isPwaMode() && typeof w.nostr?.getPublicKey === 'function') {
    label = 'NIP-07 connected (Nostr only — install Alby or unlock our extension)';
  }
  return { webbtc: hasWebbtc, signSchnorr: hasSchnorr, bitcoinApi: hasBitcoinApi, label };
}

/** Detect which NIP-07 extension is available for adding accounts. */
export function detectNostrSignerType(): VaultData['signerType'] {
  const w = window as NostrWindow;
  if (w.webbtc?.signPsbt || w.nostr?.signSchnorr) return 'alby';
  if (typeof w.nostr?.getPublicKey === 'function') return 'nip07';
  return 'nip07';
}

export function nip07SignerLabel(type: VaultData['signerType']): string {
  switch (type) {
    case 'alby': return 'Alby';
    case 'nos2x': return 'nos2x';
    case 'nostr-onchain': return 'Nostr Onchain';
    default: return 'NIP-07';
  }
}

export function finalizeSignedPsbt(signedPsbtHex: string, source: BitcoinSignerSource): SignedTxResult {
  const tx = Transaction.fromPSBT(hex.decode(signedPsbtHex));
  tx.finalize();
  const txBytes = tx.extract();
  return {
    txHex: hex.encode(txBytes),
    txid: tx.id,
    source,
  };
}

/** Alby / WebBTC — signs in extension, key never exposed to the page. */
export async function signPsbtViaWebBtc(psbtHex: string): Promise<SignedTxResult> {
  const w = window as NostrWindow & {
    webbtc?: {
      enable?: () => Promise<void>;
      signPsbt?: (psbt: string) => Promise<{ signed?: string } | string>;
    };
  };
  if (!w.webbtc?.signPsbt) {
    throw new Error('WEBBTC_UNAVAILABLE');
  }
  if (w.webbtc.enable) {
    await w.webbtc.enable();
  }
  const result = await w.webbtc.signPsbt(psbtHex);
  const signedHex = typeof result === 'string' ? result : result?.signed;
  if (!signedHex || typeof signedHex !== 'string') {
    throw new Error('WebBTC returned invalid signed PSBT');
  }
  return finalizeSignedPsbt(signedHex, 'webbtc');
}

export const KEYPATH_TWEAK_ERROR =
  'Your Nostr signer signs with the raw (untweaked) key, so it cannot authorize ' +
  'key-path Taproot spends from your personal address — the signature would be ' +
  'invalid on-chain. Import your nsec into the vault, or pair Amber (which signs ' +
  'PSBTs with the correct tweak), then try again.';

/**
 * Build Taproot sighash → ask NIP-07 signer to signSchnorr → attach to PSBT.
 * This is the "transaction is ready, just need the signature" path.
 *
 * IMPORTANT: key-path spends must be signed with the TapTweak-adjusted key
 * (d + H_TapTweak(P)), but NIP-07 signSchnorr signs with the raw nostr key.
 * We therefore VERIFY each returned signature against the actual output key
 * before attaching it — a raw-key signature never validates, and previously
 * this produced transactions that every node rejected at broadcast.
 */
export async function signPsbtViaNostrSchnorr(
  psbtHex: string,
  pubkeyHex: string
): Promise<SignedTxResult | null> {
  const w = window as NostrWindow;
  if (!w.nostr?.signSchnorr) return null;

  const { schnorr } = await import('@noble/curves/secp256k1');
  const tx = Transaction.fromPSBT(hex.decode(psbtHex));
  let signedCount = 0;
  let invalidTweakCount = 0;

  for (let idx = 0; idx < tx.inputsLength; idx++) {
    const input = tx.getInput(idx);
    const inputType = getInputType(input, false);
    if (inputType.txType !== 'taproot' || !input.tapInternalKey) continue;

    const internalKeyHex = hex.encode(input.tapInternalKey);
    if (internalKeyHex.toLowerCase() !== pubkeyHex.toLowerCase()) continue;

    const prevOutScript: Uint8Array[] = [];
    const amount: bigint[] = [];
    for (let i = 0; i < tx.inputsLength; i++) {
      const wu = tx.getInput(i).witnessUtxo;
      if (!wu) throw new Error('PSBT input missing witnessUtxo');
      prevOutScript.push(wu.script as Uint8Array);
      amount.push(wu.amount as bigint);
    }

    const sighash = inputType.sighash ?? SigHash.DEFAULT;

    const msgHash = tx.preimageWitnessV1(idx, prevOutScript, sighash, amount);
    const sigHex = await w.nostr.signSchnorr(hex.encode(msgHash));
    const sigBytes = hex.decode(sigHex.replace(/^0x/, ''));
    if (sigBytes.length !== 64) throw new Error('Signer returned an invalid Schnorr signature');

    // The key-path signature must verify against the TWEAKED output key,
    // which is the witness program of this input (script = OP_1 PUSH32 <Q>).
    const ownScript = prevOutScript[idx];
    const outputKey = ownScript.length === 34 && ownScript[0] === 0x51 && ownScript[1] === 0x20
      ? ownScript.slice(2)
      : null;
    if (!outputKey || !schnorr.verify(sigBytes, msgHash, outputKey)) {
      invalidTweakCount++;
      continue;
    }

    const tapKeySig =
      sighash !== SigHash.DEFAULT
        ? concatBytes(sigBytes, new Uint8Array([sighash]))
        : sigBytes;

    tx.updateInput(idx, { tapKeySig }, true);
    signedCount++;
  }

  if (signedCount === 0) {
    if (invalidTweakCount > 0) throw new Error(KEYPATH_TWEAK_ERROR);
    return null;
  }
  if (invalidTweakCount > 0) throw new Error(KEYPATH_TWEAK_ERROR);

  tx.finalize();
  const txBytes = tx.extract();
  return {
    txHex: hex.encode(txBytes),
    txid: tx.id,
    source: 'nip07-schnorr',
  };
}

/**
 * NIP-46 remote signer (Amber). Sends the PSBT to the paired bunker, which
 * signs it on the user's device and returns it; we then finalize and extract.
 * The private key never touches this app.
 */
export async function signPsbtViaNip46(psbtHex: string): Promise<SignedTxResult | null> {
  const { isRemoteSignerConnected, signPsbtBase64ViaRemote } = await import('@/lib/nostr/nip46');
  if (!(await isRemoteSignerConnected())) return null;

  const psbtBase64 = base64.encode(hex.decode(psbtHex));
  const signedBase64 = await signPsbtBase64ViaRemote(psbtBase64);

  const signedBytes = base64.decode(signedBase64.trim());
  const tx = Transaction.fromPSBT(signedBytes, {
    allowUnknownOutputs: true,
    allowUnknownInputs: true,
  });
  tx.finalize();
  const txBytes = tx.extract();
  return {
    txHex: hex.encode(txBytes),
    txid: tx.id,
    source: 'nip46-amber',
  };
}

/** Our injected window.bitcoin API (extension with unlocked vault). */
export async function signPsbtViaBitcoinApi(psbtHex: string): Promise<SignedTxResult | null> {
  const w = window as NostrWindow & {
    bitcoin?: { signPsbt?: (h: string) => Promise<{ txHex: string; txid: string }> };
  };
  if (!w.bitcoin?.signPsbt) return null;
  const result = await w.bitcoin.signPsbt(psbtHex);
  if (!result?.txHex || !result?.txid) return null;
  return { txHex: result.txHex, txid: result.txid, source: 'bitcoin-api' };
}

export async function tryExternalPsbtSign(
  psbtHex: string,
  pubkeyHex?: string
): Promise<SignedTxResult | null> {
  // Explicitly-paired remote signer (Amber) takes priority — the user opted
  // into it, and it signs on their device.
  try {
    const remote = await signPsbtViaNip46(psbtHex);
    if (remote) return remote;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : '';
    if (msg && !msg.toLowerCase().includes('reject') && !msg.toLowerCase().includes('no remote signer')) {
      throw err;
    }
  }

  try {
    return await signPsbtViaWebBtc(psbtHex);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : '';
    if (msg && msg !== 'WEBBTC_UNAVAILABLE' && !msg.toLowerCase().includes('reject')) {
      throw err;
    }
  }

  // NIP-07 signSchnorr: works for tapscript inputs, but CANNOT produce valid
  // key-path signatures (raw key, no TapTweak). If it fails for that reason,
  // keep the error but still try the remaining signers first — our extension's
  // vault (window.bitcoin) can sign key-path spends correctly.
  let deferredError: Error | null = null;
  if (pubkeyHex) {
    try {
      const schnorr = await signPsbtViaNostrSchnorr(psbtHex, pubkeyHex);
      if (schnorr) return schnorr;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '';
      if (msg === KEYPATH_TWEAK_ERROR) {
        deferredError = err as Error;
      } else if (msg && !msg.toLowerCase().includes('reject')) {
        throw err;
      }
    }
  }

  try {
    const viaApi = await signPsbtViaBitcoinApi(psbtHex);
    if (viaApi) return viaApi;
  } catch {
    // fall through
  }

  if (deferredError) throw deferredError;
  return null;
}

export function externalSignerHelpMessage(): string {
  const { webbtc, signSchnorr, bitcoinApi } = detectBitcoinSigners();
  if (webbtc || signSchnorr || bitcoinApi) return '';
  return (
    'No Bitcoin-capable signer found. Install Alby (WebBTC or signSchnorr), ' +
    'use the Nostr Onchain extension, or import nsec once into vault.'
  );
}
