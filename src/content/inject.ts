/**
 * Content script that injects the NIP-07 provider into web pages.
 * Also injects a Bitcoin signing API (experimental).
 *
 * The content script acts as a bridge between the page context
 * (where window.nostr lives) and the extension background.
 */

const EXTENSION_ID = chrome.runtime.id;

// Inject the provider script into the page
function injectProvider() {
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('nostr-provider.js');
  script.type = 'text/javascript';
  (document.head || document.documentElement).appendChild(script);
  script.onload = () => script.remove();
}

injectProvider();

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
