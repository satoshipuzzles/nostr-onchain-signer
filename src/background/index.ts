/**
 * Background service worker for the extension.
 * Manages the key vault, handles NIP-07 requests, and coordinates
 * Bitcoin transaction signing.
 */

import { decryptVault, loadVault, VaultData } from '@/lib/crypto/vault';
import { signEvent, computeEventId, type UnsignedEvent, type SignedEvent } from '@/lib/nostr/events';
import { keyPairFromPrivateKey } from '@/lib/nostr/keys';
import type { ExtensionMessage, ExtensionResponse } from '@/shared/messages';

let unlockedKeys: VaultData[] | null = null;
let lockTimer: ReturnType<typeof setTimeout> | null = null;
const AUTO_LOCK_MS = 15 * 60 * 1000; // 15 minutes

function resetLockTimer() {
  if (lockTimer) clearTimeout(lockTimer);
  lockTimer = setTimeout(() => {
    unlockedKeys = null;
  }, AUTO_LOCK_MS);
}

function getActiveKey(): VaultData | null {
  if (!unlockedKeys || unlockedKeys.length === 0) return null;
  resetLockTimer();
  return unlockedKeys[0];
}

chrome.runtime.onMessage.addListener(
  (message: ExtensionMessage, _sender, sendResponse) => {
    handleMessage(message)
      .then((response) => sendResponse(response))
      .catch((err) => sendResponse({ id: message.id, error: err.message }));
    return true; // Keep channel open for async response
  }
);

async function handleMessage(
  message: ExtensionMessage
): Promise<ExtensionResponse> {
  const { type, payload, id } = message;

  switch (type) {
    case 'vault:status': {
      const vault = await loadVault();
      return {
        id,
        result: {
          exists: vault !== null,
          unlocked: unlockedKeys !== null,
          publicKey: getActiveKey()?.publicKeyHex,
        },
      };
    }

    case 'vault:unlock': {
      const { password } = payload as { password: string };
      const vault = await loadVault();
      if (!vault) return { id, error: 'No vault found' };
      try {
        unlockedKeys = await decryptVault(vault, password);
        resetLockTimer();
        return {
          id,
          result: { publicKey: unlockedKeys[0]?.publicKeyHex },
        };
      } catch {
        return { id, error: 'Invalid password' };
      }
    }

    case 'vault:lock': {
      unlockedKeys = null;
      if (lockTimer) clearTimeout(lockTimer);
      return { id, result: { locked: true } };
    }

    case 'nip07:getPublicKey': {
      const key = getActiveKey();
      if (!key) return { id, error: 'Vault is locked' };
      return { id, result: key.publicKeyHex };
    }

    case 'nip07:signEvent': {
      const key = getActiveKey();
      if (!key) return { id, error: 'Vault is locked' };

      const { event } = payload as { event: Omit<UnsignedEvent, 'pubkey'> };
      const unsigned: UnsignedEvent = {
        ...event,
        pubkey: key.publicKeyHex,
      };

      const signed = signEvent(unsigned, key.privateKeyHex);
      return { id, result: signed };
    }

    case 'nip07:getRelays': {
      const result = await chrome.storage.local.get('relays');
      return { id, result: result.relays ?? {} };
    }

    case 'btc:getAddress': {
      const key = getActiveKey();
      if (!key) return { id, error: 'Vault is locked' };
      // Import dynamically to keep background bundle smaller
      const { pubkeyToTaprootAddress } = await import('@/lib/bitcoin/address');
      const address = pubkeyToTaprootAddress(key.publicKeyHex);
      return { id, result: address };
    }

    case 'btc:getMultisigAddress': {
      const key = getActiveKey();
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

    case 'dual:signAndBroadcast': {
      const key = getActiveKey();
      if (!key) return { id, error: 'Vault is locked' };

      const { noteContent, recipientAddress, amountSats } = payload as {
        noteContent: string;
        noteTags?: string[][];
        recipientAddress: string;
        amountSats: number;
        feeRate: number;
      };

      // 1. Create and sign the Nostr note
      const noteEvent: UnsignedEvent = {
        kind: 1,
        content: noteContent,
        tags: [],
        created_at: Math.floor(Date.now() / 1000),
        pubkey: key.publicKeyHex,
      };
      const signedNote = signEvent(noteEvent, key.privateKeyHex);

      // 2. Create OP_RETURN with the event ID
      const { encodeNostrOpReturn } = await import('@/lib/bitcoin/opreturn');
      const opReturn = encodeNostrOpReturn({
        eventId: signedNote.id,
        kind: signedNote.kind,
        content: noteContent,
      });

      // 3. Return both for the UI to finalize
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
