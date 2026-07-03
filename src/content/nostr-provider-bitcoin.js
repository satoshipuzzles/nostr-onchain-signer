/**
 * Lightweight NIP-07 Bitcoin bridge for our own PWA.
 *
 * Does NOT replace window.nostr from Alby/nos2x — only augments:
 * - Adds signSchnorr if missing (NIP-07 Bitcoin signing via BIP341 sighash)
 * - Adds window.bitcoin if missing
 *
 * If no window.nostr exists, provides a minimal NIP-07 interface via our extension vault.
 */
(function () {
  'use strict';

  let requestId = 0;
  const pendingRequests = new Map();

  function sendRequest(type, payload) {
    return new Promise((resolve, reject) => {
      const id = 'req_' + ++requestId + '_' + Date.now();
      pendingRequests.set(id, { resolve, reject });

      window.postMessage(
        { target: 'nostr-onchain-signer', type, payload, id },
        '*'
      );

      setTimeout(function () {
        if (pendingRequests.has(id)) {
          pendingRequests.delete(id);
          reject(new Error('Request timed out — unlock the Nostr Onchain extension'));
        }
      }, 60000);
    });
  }

  window.addEventListener('message', function (event) {
    if (event.source !== window) return;
    if (!event.data || event.data.target !== 'nostr-onchain-signer-response') return;

    var id = event.data.id;
    var pending = pendingRequests.get(id);
    if (!pending) return;

    pendingRequests.delete(id);
    if (event.data.error) {
      pending.reject(new Error(event.data.error));
    } else {
      pending.resolve(event.data.result);
    }
  });

  var bridge = {
    signSchnorr: function (hash) {
      return sendRequest('nip07:signSchnorr', { hash: hash });
    },
    getPublicKey: function () {
      return sendRequest('nip07:getPublicKey');
    },
    signEvent: function (event) {
      return sendRequest('nip07:signEvent', { event: event });
    },
    getRelays: function () {
      return sendRequest('nip07:getRelays');
    },
  };

  if (window.nostr) {
    if (!window.nostr.signSchnorr) {
      window.nostr.signSchnorr = bridge.signSchnorr;
    }
  } else {
    window.nostr = bridge;
  }

  if (!window.bitcoin) {
    window.bitcoin = {
      getAddress: function () {
        return sendRequest('btc:getAddress');
      },
      signPsbt: function (psbtHex, options) {
        return sendRequest('btc:signPsbt', Object.assign({ psbtHex: psbtHex }, options || {}));
      },
    };
  }

  window.dispatchEvent(new Event('nostr-onchain-bitcoin-ready'));
})();
