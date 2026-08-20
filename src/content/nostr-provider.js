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

  // NIP-07 interface. If another Nostr signer extension (Alby, nos2x,
  // the sibling Pocket Signer Link, …) already claimed window.nostr,
  // yield to it — signing continues to work through the other extension
  // and the user has one source of truth for Nostr identity per page.
  // Bitcoin support below is installed unconditionally: this is the only
  // extension that provides window.bitcoin, so it can never conflict.
  const nostrClaimedByUs =
    typeof window.nostr === 'object' &&
    window.nostr !== null &&
    window.nostr._nostrOnchainSigner === true;

  if (window.nostr && !nostrClaimedByUs) {
    const other = window.nostr._pocketSignerLink
      ? 'Pocket Signer Link'
      : 'another Nostr signer extension';
    console.info(
      '%c[Nostr Onchain Signer]%c window.nostr already set by ' +
        other +
        ' — yielding NIP-07 to it. Bitcoin API remains available on window.bitcoin.',
      'background:#8B5CF6;color:#fff;padding:2px 8px;border-radius:4px;font-weight:600',
      'color:inherit'
    );
  } else {
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
    window.dispatchEvent(new Event('nostr:init'));
    window.dispatchEvent(new Event('nostr-provider-loaded'));
  }

  // Bitcoin signing API (experimental extension to NIP-07 concept).
  // Unique to this extension — always install regardless of the Nostr
  // yield decision above.
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
  window.dispatchEvent(new Event('bitcoin-provider-loaded'));

  const nostrStatus = window.nostr && window.nostr._nostrOnchainSigner
    ? 'NIP-07 + Bitcoin signing active'
    : 'Bitcoin signing active (NIP-07 delegated to another extension)';
  console.log(
    '%c⚡ Nostr Onchain Signer ready %c ' + nostrStatus,
    'background: #F7931A; color: white; padding: 2px 8px; border-radius: 4px 0 0 4px; font-weight: bold;',
    'background: #8B5CF6; color: white; padding: 2px 8px; border-radius: 0 4px 4px 0;'
  );
})();
