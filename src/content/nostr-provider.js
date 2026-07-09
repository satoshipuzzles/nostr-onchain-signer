/**
 * NIP-07 provider that gets injected into the page context.
 * This file runs in the page's world (not the content script sandbox).
 * It communicates with the content script via window.postMessage.
 */

(function () {
  'use strict';

  let requestId = 0;
  const pendingRequests = new Map();

  function sendRequest(type, payload) {
    return new Promise((resolve, reject) => {
      const id = `req_${++requestId}_${Date.now()}`;
      pendingRequests.set(id, { resolve, reject });

      window.postMessage(
        {
          target: 'nostr-onchain-signer',
          type,
          payload,
          id,
        },
        '*'
      );

      setTimeout(() => {
        if (pendingRequests.has(id)) {
          pendingRequests.delete(id);
          reject(new Error('Request timed out'));
        }
      }, 60000);
    });
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (!event.data || event.data.target !== 'nostr-onchain-signer-response')
      return;

    const { id, result, error } = event.data;
    const pending = pendingRequests.get(id);
    if (!pending) return;

    pendingRequests.delete(id);
    if (error) {
      pending.reject(new Error(error));
    } else {
      pending.resolve(result);
    }
  });

  // NIP-07 interface — takes priority when our extension is installed
  window.nostr = {
    _nostrOnchainSigner: true,

    async getPublicKey() {
      return sendRequest('nip07:getPublicKey');
    },

    async signEvent(event) {
      return sendRequest('nip07:signEvent', { event });
    },

    async signSchnorr(hash) {
      return sendRequest('nip07:signSchnorr', { hash });
    },

    async getRelays() {
      return sendRequest('nip07:getRelays');
    },

    nip04: {
      async encrypt(pubkey, plaintext) {
        return sendRequest('nip07:nip04:encrypt', { pubkey, plaintext });
      },
      async decrypt(pubkey, ciphertext) {
        return sendRequest('nip07:nip04:decrypt', { pubkey, ciphertext });
      },
    },

    nip44: {
      async encrypt(pubkey, plaintext) {
        return sendRequest('nip07:nip44:encrypt', { pubkey, plaintext });
      },
      async decrypt(pubkey, ciphertext) {
        return sendRequest('nip07:nip44:decrypt', { pubkey, ciphertext });
      },
    },
  };

  // Bitcoin signing API (experimental extension to NIP-07 concept)
  window.bitcoin = {
    _nostrOnchainSigner: true,

    async getAddress() {
      return sendRequest('btc:getAddress');
    },

    async signPsbt(psbtHex, options) {
      return sendRequest('btc:signPsbt', { psbtHex, ...options });
    },

    async signPsbtPartial(psbtHex) {
      return sendRequest('btc:signPsbtPartial', { psbtHex });
    },

    async getMultisigAddress(pubkeys, threshold, network) {
      return sendRequest('btc:getMultisigAddress', {
        pubkeys,
        threshold,
        network,
      });
    },
  };

  // Standard events Nostr clients listen for
  window.dispatchEvent(new Event('nostr:init'));
  window.dispatchEvent(new Event('nostr-provider-loaded'));
  window.dispatchEvent(new Event('bitcoin-provider-loaded'));

  // Log for users on Nostr clients so they know the signer is ready
  console.log(
    '%c⚡ Nostr Onchain Signer ready %c NIP-07 + Bitcoin signing active',
    'background: #F7931A; color: white; padding: 2px 8px; border-radius: 4px 0 0 4px; font-weight: bold;',
    'background: #8B5CF6; color: white; padding: 2px 8px; border-radius: 0 4px 4px 0;'
  );
})();
