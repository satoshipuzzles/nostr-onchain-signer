/**
 * Background service worker for the extension.
 *
 * CRITICAL: MV3 service workers are ephemeral — Chrome kills them after
 * ~30s of inactivity. We persist the decrypted vault in chrome.storage.session
 * which survives worker restarts but clears on browser close.
 */

import { decryptVault, loadVault, VaultData } from '@/lib/crypto/vault';
import { signEvent, computeEventId, type UnsignedEvent, type SignedEvent } from '@/lib/nostr/events';
import { keyPairFromPrivateKey } from '@/lib/nostr/keys';
import type { ExtensionMessage, ExtensionResponse } from '@/shared/messages';

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

chrome.runtime.onMessage.addListener(
  (message: ExtensionMessage, _sender, sendResponse) => {
    handleMessage(message)
      .then((response) => sendResponse(response))
      .catch((err) => sendResponse({ id: message.id, error: err.message }));
    return true;
  }
);

async function handleMessage(
  message: ExtensionMessage
): Promise<ExtensionResponse> {
  const { type, payload, id } = message;

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
        // Restore active index from local storage (popup persists this)
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

    case 'nip07:getPublicKey': {
      const key = await getActiveKey();
      if (!key) return { id, error: 'Vault is locked' };
      return { id, result: key.publicKeyHex };
    }

    case 'nip07:signEvent': {
      const key = await getActiveKey();
      if (!key) return { id, error: 'Vault is locked' };

      const { event } = payload as { event: Omit<UnsignedEvent, 'pubkey'> };
      const unsigned: UnsignedEvent = {
        ...event,
        pubkey: key.publicKeyHex,
      };

      const signed = signEvent(unsigned, key.privateKeyHex);

      // Log signed event for Signed Events page
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
          origin: 'extension',
        });
        await chrome.storage.local.set({ signed_events_log: log.slice(0, 500) });
      } catch (err) {
        console.error('[Background] Failed to log signed event:', err);
      }

      return { id, result: signed };
    }

    case 'nip07:getRelays': {
      const result = await chrome.storage.local.get('relays');
      return { id, result: result.relays ?? {} };
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
