/**
 * Wallet operations: chain queries, recipient resolution (address / npub /
 * silent payment), transaction building, signing, broadcasting.
 */

import {
  EsploraClient,
  buildTx,
  signAndFinalizePsbt,
  parseAnyPsbt,
  pubkeyToTaprootAddress,
  isSilentPaymentAddress,
  deriveSilentPaymentOutputs,
  taprootTweakPrivateKey,
  xOnlyToTaprootAddress,
  type BuiltTx,
  type CoreUtxo,
  type EsploraUtxo,
  type TxOutputSpec,
} from '@nostr-onchain/core';
import { loadSettings, effectiveEsploraUrls } from './storage';
import { parsePubkeyInput } from './nostr';
import { accountAddress, type VaultAccount } from './vault';

export function esplora(): EsploraClient {
  const settings = loadSettings();
  return new EsploraClient({ baseUrls: effectiveEsploraUrls(settings) });
}

export interface ResolvedRecipient {
  input: string;
  kind: 'address' | 'npub' | 'silent-payment';
  /** Final on-chain address (for silent payments, resolved at build time). */
  address: string | null;
  /** hex pubkey when kind is npub. */
  pubkeyHex?: string;
}

/** Resolve a recipient string: bc1…/tb1… address, npub/nprofile/hex, or sp1…. */
export function resolveRecipient(input: string, network: 'mainnet' | 'testnet' = 'mainnet'): ResolvedRecipient {
  const trimmed = input.trim();
  if (!trimmed) throw new Error('Empty recipient');
  if (/^(bc1|tb1)[a-z0-9]{20,}$/i.test(trimmed)) {
    return { input: trimmed, kind: 'address', address: trimmed.toLowerCase() };
  }
  if (isSilentPaymentAddress(trimmed)) {
    return { input: trimmed, kind: 'silent-payment', address: null };
  }
  const pubkey = parsePubkeyInput(trimmed);
  if (pubkey) {
    return {
      input: trimmed,
      kind: 'npub',
      address: pubkeyToTaprootAddress(pubkey, network),
      pubkeyHex: pubkey,
    };
  }
  throw new Error('Recipient must be a bitcoin address, npub, or silent payment (sp1…) address');
}

export interface BuildRequest {
  account: VaultAccount;
  utxos: EsploraUtxo[];
  recipients: { resolved: ResolvedRecipient; amountSats: number }[];
  opReturn?: Uint8Array;
  feeRate: number;
  rbf: boolean;
  locktime?: number;
  useAllUtxos?: boolean;
}

/**
 * Build a PSBT. Silent-payment recipients require the account's private key
 * (the SP output is derived from the keys of the inputs being spent).
 */
export function buildWalletTx(req: BuildRequest): BuiltTx {
  const settings = loadSettings();
  const network = settings.network;
  const fromAddress = accountAddress(req.account, network);
  const coreUtxos: CoreUtxo[] = req.utxos.map((u) => ({ txid: u.txid, vout: u.vout, value: u.value }));

  const hasSp = req.recipients.some((r) => r.resolved.kind === 'silent-payment');
  const outputs: TxOutputSpec[] = [];

  if (hasSp) {
    if (!req.account.privateKeyHex) {
      throw new Error('Silent payment sends need this account\'s private key (watch-only can\'t derive the recipient output)');
    }
    const tweaked = taprootTweakPrivateKey(req.account.privateKeyHex);
    for (const r of req.recipients) {
      if (r.resolved.kind !== 'silent-payment') continue;
      const spInputs = coreUtxos.map((u) => ({
        privateKeyHex: tweaked,
        isTaproot: true,
        txid: u.txid,
        vout: u.vout,
      }));
      const [derived] = deriveSilentPaymentOutputs(r.resolved.input, spInputs, 1);
      r.resolved.address = xOnlyToTaprootAddress(derived.xOnlyPubkeyHex, network);
    }
  }

  for (const r of req.recipients) {
    if (!r.resolved.address) throw new Error('Unresolved recipient');
    outputs.push({ address: r.resolved.address, amountSats: r.amountSats });
  }
  if (req.opReturn && req.opReturn.length > 0) {
    outputs.push({ amountSats: 0, opReturnData: req.opReturn });
  }

  return buildTx(
    {
      utxos: coreUtxos,
      fromAddress,
      outputs,
      feeRate: req.feeRate,
      changeAddress: fromAddress,
      internalPubkeyHex: req.account.watchOnly && req.account.addressOverride ? undefined : req.account.publicKeyHex,
      rbf: req.rbf,
      locktime: req.locktime,
    },
    { useAllUtxos: req.useAllUtxos }
  );
}

export function signWithAccount(psbtHexOrB64: string, account: VaultAccount): { txHex: string; txid: string } {
  if (!account.privateKeyHex) throw new Error('This account is watch-only — export the PSBT and sign elsewhere');
  return signAndFinalizePsbt(parseAnyPsbt(psbtHexOrB64), account.privateKeyHex);
}

export async function broadcastTx(txHex: string): Promise<string> {
  return esplora().broadcast(txHex);
}

export function formatSats(sats: number): string {
  if (Math.abs(sats) >= 100_000_000) return `${(sats / 100_000_000).toLocaleString(undefined, { maximumFractionDigits: 8 })} BTC`;
  return `${sats.toLocaleString()} sats`;
}
