/**
 * Background service worker for the extension.
 *
 * CRITICAL: MV3 service workers are ephemeral — Chrome kills them after
 * ~30s of inactivity. We persist the decrypted vault in chrome.storage.session
 * which survives worker restarts but clears on browser close.
 */

import { decryptVault, loadVault, VaultData } from '@/lib/crypto/vault';
import { signEvent, type UnsignedEvent } from '@/lib/nostr/events';
import { encryptNip04, decryptNip04, encryptNip44, decryptNip44 } from '@/lib/nostr/dm-crypto';
import { schnorrSign } from '@/lib/bitcoin/psbt';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils';
import type { ExtensionMessage, ExtensionResponse } from '@/shared/messages';
import {
  needsApproval,
  queueForApproval,
  getPendingApproval,
  getWaiter,
  clearPendingApproval,
} from './pending-approval';

const SESSION_KEY = 'unlocked_session';
const SESSION_INDEX_KEY = 'active_account_index';

async function getSession(): Promise<VaultData[] | null> {
  try {
    const result = await chrome.storage.session.get(SESSION_KEY);
    return result[SESSION_KEY] ?? null;
  } catch {
    return null;
  }
}

async function setSession(data: VaultData[] | null): Promise<void> {
  if (data) {
    await chrome.storage.session.set({ [SESSION_KEY]: data });
  } else {
    await chrome.storage.session.remove(SESSION_KEY);
  }
}

async function getActiveIndex(): Promise<number> {
  try {
    const result = await chrome.storage.session.get(SESSION_INDEX_KEY);
    return result[SESSION_INDEX_KEY] ?? 0;
  } catch {
    return 0;
  }
}

async function setActiveIndex(index: number): Promise<void> {
  await chrome.storage.session.set({ [SESSION_INDEX_KEY]: index });
}

async function getActiveKey(): Promise<VaultData | null> {
  const session = await getSession();
  if (!session || session.length === 0) return null;
  const idx = await getActiveIndex();
  return session[Math.min(idx, session.length - 1)];
}

function hasVaultPrivateKey(key: VaultData): boolean {
  return (
    typeof key.privateKeyHex === 'string' &&
    key.privateKeyHex.length === 64 &&
    /^[0-9a-f]+$/i.test(key.privateKeyHex)
  );
}

chrome.runtime.onMessage.addListener(
  (message: ExtensionMessage, sender, sendResponse) => {
    handleMessage(message, sender)
      .then((response) => sendResponse(response))
      .catch((err) => sendResponse({ id: message.id, error: err.message }));
    return true;
  }
);

async function handleMessage(
  message: ExtensionMessage,
  sender?: chrome.runtime.MessageSender,
  options?: { skipApproval?: boolean }
): Promise<ExtensionResponse> {
  const { type, payload, id } = message;

  if (!options?.skipApproval && sender && needsApproval(type, sender)) {
    const key = await getActiveKey();
    if (!key) {
      return { id, error: 'Vault is locked — open the extension and unlock first' };
    }
    return queueForApproval(message, sender, key.publicKeyHex);
  }

  switch (type) {
    case 'vault:status': {
      const vault = await loadVault();
      const session = await getSession();
      const key = await getActiveKey();
      return {
        id,
        result: {
          exists: vault !== null,
          unlocked: session !== null,
          publicKey: key?.publicKeyHex,
        },
      };
    }

    case 'vault:unlock': {
      const { password } = payload as { password: string };
      const vault = await loadVault();
      if (!vault) return { id, error: 'No vault found' };
      try {
        const keys = await decryptVault(vault, password);
        await setSession(keys);
        const localStored = await chrome.storage.local.get('activeAccountIndex');
        const idx = typeof localStored.activeAccountIndex === 'number'
          ? Math.min(localStored.activeAccountIndex, keys.length - 1)
          : 0;
        await setActiveIndex(idx);
        const activeKey = keys[idx];
        return {
          id,
          result: { publicKey: activeKey?.publicKeyHex },
        };
      } catch {
        return { id, error: 'Invalid password' };
      }
    }

    case 'vault:lock': {
      await setSession(null);
      return { id, result: { locked: true } };
    }

    case 'vault:switchAccount': {
      const { index } = payload as { index: number };
      const session = await getSession();
      if (!session || index >= session.length) {
        return { id, error: 'Invalid account index or vault locked' };
      }
      await setActiveIndex(index);
      return { id, result: { publicKey: session[index].publicKeyHex } };
    }

    case 'vault:getPrivateKey': {
      const key = await getActiveKey();
      if (!key?.privateKeyHex || key.privateKeyHex.length !== 64) {
        return { id, error: 'No private key available' };
      }
      return { id, result: key.privateKeyHex };
    }

    case 'approval:get': {
      const { approvalId } = payload as { approvalId: string };
      const pending = await getPendingApproval(approvalId);
      if (!pending) return { id, error: 'Request expired or not found' };
      return {
        id,
        result: {
          origin: pending.origin,
          type: pending.type,
          preview: pending.preview,
          pubkey: pending.pubkey,
        },
      };
    }

    case 'approval:reject': {
      const { approvalId } = payload as { approvalId: string };
      const waiter = getWaiter(approvalId);
      if (waiter) {
        waiter.resolve({ id: waiter.message.id, error: 'User denied signing request' });
      }
      await clearPendingApproval(approvalId);
      return { id, result: { rejected: true } };
    }

    case 'approval:confirm': {
      const { approvalId } = payload as { approvalId: string };
      const pending = await getPendingApproval(approvalId);
      const waiter = getWaiter(approvalId);
      if (!pending || !waiter) {
        return { id, error: 'Request expired — try again from the website' };
      }
      const result = await handleMessage(waiter.message, undefined, { skipApproval: true });
      waiter.resolve(result);
      await clearPendingApproval(approvalId);
      return { id, result: { approved: true } };
    }

    case 'nip07:getPublicKey': {
      const key = await getActiveKey();
      if (!key) return { id, error: 'Vault is locked' };
      return { id, result: key.publicKeyHex };
    }

    case 'nip07:signEvent': {
      const key = await getActiveKey();
      if (!key) return { id, error: 'Vault is locked' };
      if (!hasVaultPrivateKey(key)) {
        return {
          id,
          error: 'This account has no private key in the vault. Use a generated/imported account, or unlock your NIP-07 extension (Alby/nos2x).',
        };
      }

      const { event } = payload as { event: Omit<UnsignedEvent, 'pubkey'> };
      const unsigned: UnsignedEvent = {
        ...event,
        pubkey: key.publicKeyHex,
      };

      const signed = signEvent(unsigned, key.privateKeyHex);

      try {
        const stored = await chrome.storage.local.get('signed_events_log');
        const log: Array<Record<string, unknown>> = stored.signed_events_log || [];
        log.unshift({
          id: signed.id,
          kind: signed.kind,
          content: signed.content,
          created_at: signed.created_at,
          pubkey: signed.pubkey,
          sig: signed.sig,
          tags: signed.tags,
          origin: sender?.tab?.url || 'extension',
        });
        await chrome.storage.local.set({ signed_events_log: log.slice(0, 500) });
      } catch (err) {
        console.error('[Background] Failed to log signed event:', err);
      }

      return { id, result: signed };
    }

    case 'nip07:signSchnorr': {
      const key = await getActiveKey();
      if (!key) return { id, error: 'Vault is locked — open the extension and unlock first' };
      if (!hasVaultPrivateKey(key)) {
        return {
          id,
          error: 'No private key in extension vault. Import nsec or unlock with a full-key account.',
        };
      }

      const { hash } = payload as { hash: string };
      if (!hash || typeof hash !== 'string') {
        return { id, error: 'Missing hash to sign' };
      }

      try {
        const hashBytes = hexToBytes(hash.replace(/^0x/, ''));
        const sig = schnorrSign(hashBytes, key.privateKeyHex);
        return { id, result: bytesToHex(sig) };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Failed to sign Schnorr';
        return { id, error: msg };
      }
    }

    case 'nip07:getRelays': {
      const result = await chrome.storage.local.get('relays');
      return { id, result: result.relays ?? {} };
    }

    case 'nip07:nip04:encrypt': {
      const key = await getActiveKey();
      if (!key || !hasVaultPrivateKey(key)) {
        return { id, error: 'Vault is locked or has no private key for DM encryption' };
      }
      const { pubkey, plaintext } = payload as { pubkey: string; plaintext: string };
      try {
        const encrypted = await encryptNip04(key.privateKeyHex, pubkey, plaintext);
        return { id, result: encrypted };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'NIP-04 encrypt failed';
        return { id, error: msg };
      }
    }

    case 'nip07:nip04:decrypt': {
      const key = await getActiveKey();
      if (!key || !hasVaultPrivateKey(key)) {
        return { id, error: 'Vault is locked or has no private key for DM decryption' };
      }
      const { pubkey, ciphertext } = payload as { pubkey: string; ciphertext: string };
      try {
        const decrypted = await decryptNip04(key.privateKeyHex, pubkey, ciphertext);
        return { id, result: decrypted };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'NIP-04 decrypt failed';
        return { id, error: msg };
      }
    }

    case 'nip07:nip44:encrypt': {
      const key = await getActiveKey();
      if (!key || !hasVaultPrivateKey(key)) {
        return { id, error: 'Vault is locked or has no private key for DM encryption' };
      }
      const { pubkey, plaintext } = payload as { pubkey: string; plaintext: string };
      try {
        const encrypted = encryptNip44(key.privateKeyHex, pubkey, plaintext);
        return { id, result: encrypted };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'NIP-44 encrypt failed';
        return { id, error: msg };
      }
    }

    case 'nip07:nip44:decrypt': {
      const key = await getActiveKey();
      if (!key || !hasVaultPrivateKey(key)) {
        return { id, error: 'Vault is locked or has no private key for DM decryption' };
      }
      const { pubkey, ciphertext } = payload as { pubkey: string; ciphertext: string };
      try {
        const decrypted = decryptNip44(key.privateKeyHex, pubkey, ciphertext);
        return { id, result: decrypted };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'NIP-44 decrypt failed';
        return { id, error: msg };
      }
    }

    case 'btc:getAddress': {
      const key = await getActiveKey();
      if (!key) return { id, error: 'Vault is locked' };
      const { pubkeyToTaprootAddress } = await import('@/lib/bitcoin/address');
      const address = pubkeyToTaprootAddress(key.publicKeyHex);
      return { id, result: address };
    }

    case 'btc:getMultisigAddress': {
      const key = await getActiveKey();
      if (!key) return { id, error: 'Vault is locked' };
      const { pubkeys, threshold, network } = payload as {
        pubkeys: string[];
        threshold: number;
        network?: 'mainnet' | 'testnet';
      };
      const { createMultisigFromPubkeys } = await import('@/lib/bitcoin/multisig');
      const wallet = createMultisigFromPubkeys(
        pubkeys,
        threshold,
        network ?? 'mainnet'
      );
      return { id, result: wallet };
    }

    case 'btc:signPsbtPartial': {
      const session = await getSession();
      if (!session || session.length === 0) return { id, error: 'Vault is locked' };
      const { psbtHex } = payload as { psbtHex: string };
      if (!psbtHex) return { id, error: 'Missing psbtHex' };

      // Try every full-key account, active one first — the co-signer key
      // is often not the currently active account
      const idx = await getActiveIndex();
      const ordered = [session[Math.min(idx, session.length - 1)], ...session.filter((_, i) => i !== Math.min(idx, session.length - 1))];
      const keys = ordered.filter(hasVaultPrivateKey).map((k) => k.privateKeyHex);
      if (keys.length === 0) {
        return {
          id,
          error: 'No private key in vault — import nsec or switch to a full-key account.',
        };
      }
      try {
        const { signMultisigPsbtWithKeys } = await import('@/lib/bitcoin/multisig-psbt');
        const { psbtHex: signed } = signMultisigPsbtWithKeys(psbtHex, keys);
        return { id, result: { psbtHex: signed } };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Failed to partial-sign PSBT';
        return { id, error: msg };
      }
    }

    case 'btc:signPsbt': {
      const key = await getActiveKey();
      if (!key) return { id, error: 'Vault is locked' };
      const { psbtHex } = payload as { psbtHex: string };
      if (!psbtHex) return { id, error: 'Missing psbtHex' };
      const hasValidKey = hasVaultPrivateKey(key);
      if (!hasValidKey) {
        return {
          id,
          error: 'This account uses an external NIP-07 signer. Sign from the web app with Alby, or import nsec.',
        };
      }
      try {
        const { signAndFinalizePsbt } = await import('@/lib/bitcoin/psbt-builder');
        const result = signAndFinalizePsbt(psbtHex, key.privateKeyHex);
        return { id, result };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Failed to sign PSBT';
        return { id, error: msg };
      }
    }

    case 'dual:signAndBroadcast': {
      const key = await getActiveKey();
      if (!key) return { id, error: 'Vault is locked' };

      const { noteContent, recipientAddress, amountSats } = payload as {
        noteContent: string;
        noteTags?: string[][];
        recipientAddress: string;
        amountSats: number;
        feeRate: number;
      };

      const noteEvent: UnsignedEvent = {
        kind: 1,
        content: noteContent,
        tags: [],
        created_at: Math.floor(Date.now() / 1000),
        pubkey: key.publicKeyHex,
      };
      const signedNote = signEvent(noteEvent, key.privateKeyHex);

      const { encodeNostrOpReturn } = await import('@/lib/bitcoin/opreturn');
      const opReturn = encodeNostrOpReturn({
        eventId: signedNote.id,
        kind: signedNote.kind,
        content: noteContent,
      });

      return {
        id,
        result: {
          signedNote,
          opReturn: {
            scriptHex: opReturn.scriptHex,
            size: opReturn.size,
          },
          recipientAddress,
          amountSats,
        },
      };
    }

    default:
      return { id, error: `Unknown message type: ${type}` };
  }
}
