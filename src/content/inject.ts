/**
 * Content script that injects the NIP-07 provider into web pages.
 * Also injects a Bitcoin signing API (experimental).
 *
 * The content script acts as a bridge between the page context
 * (where window.nostr lives) and the extension background.
 *
 * On our own PWA we inject a lightweight Bitcoin bridge that augments
 * third-party NIP-07 signers with signSchnorr without replacing them.
 */

const OWN_APP_HOSTS = [
  'nostr-onchain-signer.vercel.app',
  'localhost',
  '127.0.0.1',
];

function isOwnAppPage(): boolean {
  try {
    const host = location.hostname;
    return OWN_APP_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

// Inject provider scripts into the page
function injectScript(filename: string) {
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL(filename);
  script.type = 'text/javascript';
  (document.head || document.documentElement).appendChild(script);
  script.onload = () => script.remove();
}

if (isOwnAppPage()) {
  // Augment (not replace) third-party NIP-07 signers with Bitcoin signing
  injectScript('nostr-provider-bitcoin.js');
} else {
  injectScript('nostr-provider.js');
}

// Bridge messages from page to background
window.addEventListener('message', async (event) => {
  if (event.source !== window) return;
  if (!event.data || event.data.target !== 'nostr-onchain-signer') return;

  const { type, payload, id } = event.data;

  try {
    const response = await chrome.runtime.sendMessage({
      type,
      payload,
      id,
    });

    window.postMessage(
      {
        target: 'nostr-onchain-signer-response',
        id,
        result: response.result,
        error: response.error,
      },
      '*'
    );
  } catch (err: unknown) {
    window.postMessage(
      {
        target: 'nostr-onchain-signer-response',
        id,
        error: err instanceof Error ? err.message : 'Extension error',
      },
      '*'
    );
  }
});
