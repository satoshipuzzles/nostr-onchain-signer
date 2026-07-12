/**
 * NIP-07 postMessage bridge for embedded apps ("nostr clients within clients").
 *
 * Embedded iframes can't see our window.nostr (cross-origin), so we answer a
 * simple postMessage protocol with the user's ACTIVE app keys:
 *
 *   iframe -> parent: { target: 'nostr-onchain-nip07', id, method, params }
 *   parent -> iframe: { target: 'nostr-onchain-nip07-response', id, result?, error? }
 *
 * Supported methods: getPublicKey, signEvent, nip04.encrypt, nip04.decrypt,
 * nip44.encrypt, nip44.decrypt, getRelays.
 *
 * Signing requests always prompt the user (with the embed's origin and the
 * event preview) before being forwarded to the vault / NIP-07 signer.
 *
 * Note: apps loaded through our extension additionally get window.nostr
 * injected directly into their frame (all_frames content script), so most
 * embeds work with zero integration when the extension is installed.
 */

import { useEffect, type RefObject } from 'react';
import { createMessageId } from '@/shared/messages';

interface BridgeRequest {
  target: 'nostr-onchain-nip07';
  id: string;
  method: string;
  params?: Record<string, unknown>;
}

function isBridgeRequest(data: unknown): data is BridgeRequest {
  return (
    !!data &&
    typeof data === 'object' &&
    (data as BridgeRequest).target === 'nostr-onchain-nip07' &&
    typeof (data as BridgeRequest).id === 'string' &&
    typeof (data as BridgeRequest).method === 'string'
  );
}

async function forward(type: string, payload?: unknown): Promise<unknown> {
  const resp = await chrome.runtime.sendMessage({ type, payload, id: createMessageId() });
  if (resp?.error) throw new Error(resp.error);
  return resp?.result;
}

async function handleMethod(
  method: string,
  params: Record<string, unknown>,
  origin: string,
): Promise<unknown> {
  switch (method) {
    case 'getPublicKey':
      return forward('nip07:getPublicKey');

    case 'getRelays':
      return forward('nip07:getRelays');

    case 'signEvent': {
      const event = params.event as { kind?: number; content?: string } | undefined;
      if (!event) throw new Error('Missing event');
      const preview = (event.content || '').slice(0, 140);
      const ok = window.confirm(
        `"${origin}" wants to sign a Nostr event with your keys.\n\n` +
        `Kind: ${event.kind}\n${preview}${(event.content || '').length > 140 ? '…' : ''}\n\nAllow?`,
      );
      if (!ok) throw new Error('User rejected signing request');
      return forward('nip07:signEvent', { event });
    }

    case 'nip04.encrypt':
      return forward('nip07:nip04:encrypt', { pubkey: params.pubkey, plaintext: params.plaintext });
    case 'nip04.decrypt':
      return forward('nip07:nip04:decrypt', { pubkey: params.pubkey, ciphertext: params.ciphertext });
    case 'nip44.encrypt':
      return forward('nip07:nip44:encrypt', { pubkey: params.pubkey, plaintext: params.plaintext });
    case 'nip44.decrypt':
      return forward('nip07:nip44:decrypt', { pubkey: params.pubkey, ciphertext: params.ciphertext });

    default:
      throw new Error(`Unsupported method: ${method}`);
  }
}

/**
 * Answer NIP-07 postMessage requests coming from a specific iframe.
 * Only messages originating from that iframe's contentWindow are honored.
 */
export function useIframeNostrBridge(iframeRef: RefObject<HTMLIFrameElement | null>) {
  useEffect(() => {
    async function onMessage(event: MessageEvent) {
      const frame = iframeRef.current;
      if (!frame || event.source !== frame.contentWindow) return;
      if (!isBridgeRequest(event.data)) return;

      const { id, method, params } = event.data;
      let result: unknown;
      let error: string | undefined;
      try {
        result = await handleMethod(method, params || {}, event.origin);
      } catch (err) {
        error = err instanceof Error ? err.message : 'Request failed';
      }

      try {
        (event.source as Window).postMessage(
          { target: 'nostr-onchain-nip07-response', id, result, error },
          event.origin === 'null' ? '*' : event.origin,
        );
      } catch { /* frame may have navigated away */ }
    }

    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [iframeRef]);
}
