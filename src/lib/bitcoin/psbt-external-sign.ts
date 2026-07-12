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

/**
 * Build Taproot sighash → ask NIP-07 signer to signSchnorr → attach to PSBT.
 * This is the "transaction is ready, just need the signature" path.
 * Works with Alby; nos2x does not implement signSchnorr.
 */
export async function signPsbtViaNostrSchnorr(
  psbtHex: string,
  pubkeyHex: string
): Promise<SignedTxResult | null> {
  const w = window as NostrWindow;
  if (!w.nostr?.signSchnorr) return null;

  const tx = Transaction.fromPSBT(hex.decode(psbtHex));
  let signedCount = 0;

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

    const tapKeySig =
      sighash !== SigHash.DEFAULT
        ? concatBytes(sigBytes, new Uint8Array([sighash]))
        : sigBytes;

    tx.updateInput(idx, { tapKeySig }, true);
    signedCount++;
  }

  if (signedCount === 0) return null;

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

  if (pubkeyHex) {
    try {
      const schnorr = await signPsbtViaNostrSchnorr(psbtHex, pubkeyHex);
      if (schnorr) return schnorr;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '';
      if (msg && !msg.toLowerCase().includes('reject')) throw err;
    }
  }

  try {
    return await signPsbtViaBitcoinApi(psbtHex);
  } catch {
    // fall through
  }

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
